#!/usr/bin/env bash
#
# Local, single-user deployment: kind cluster, real model provider, Telegram.
#
# This is the path for "my own machine, my own bot". It does not deploy a
# gateway into the cluster: the gateway runs on the workstation and talks to
# the router through a port-forward, which is the same code path the tests use
# and keeps the bot token out of Kubernetes.
#
# Assumes:
#   - kind cluster with Agent Substrate installed (hack/e2e-kind.sh has done a
#     deploy at least once, so the WorkerPool and images exist)
#   - local registry on localhost:5001
#   - kubectl-ate on PATH (or KUBECTL_ATE set)
#
# Env:
#   KUBE_CONTEXT      kubectl context (default: kind-kind)
#   KUBECTL_ATE       kubectl-ate binary (default: kubectl-ate)
#   ATESPACE          atespace (default: pi-agents)
#   ACTOR_TEMPLATE    template name (default: pi-local)
#   CONVERSATION      conversation to pre-create an actor for (default: local/chat)
#   ACTOR             actor name (default: derived from CONVERSATION, matching
#                     the gateway's mapping: local/chat -> pi-local-chat)
#   PROVIDER_ENV      provider config file, sourced if present
#                     (default: deploy/local/provider.env)
#   PI_PROVIDER       provider id (required)
#   PI_MODEL          model id (required)
#   PI_PROVIDER_BASE_URL  provider endpoint (required)
#   PI_PROVIDER_API   wire protocol, e.g. openai-completions (required)
#   PI_PROVIDER_API_KEY   API key, written to a Secret (required)
#   PI_MODEL_CONTEXT_WINDOW / PI_MODEL_MAX_TOKENS
#                     optional model metadata (Pi defaults: 128000 / 16384)
#   EGRESS_POLICY     egress manifest template (default:
#                     deploy/local/egress-policy.yaml.tmpl)
#   PROVIDER_HOST     host named in the egress policy (default: parsed from the
#                     provider's baseUrl)
#   SECRET_NAME       Kubernetes Secret holding the API key (default: pi-provider)
#   IDLE_SECONDS      idle window before suspend (default: 60)
#   TELEGRAM_CHATS    comma-separated chat ids to answer (empty: any chat)
#
# The API key never enters the actor. The template carries a placeholder, and
# the egress gateway replaces the Authorization header on the way out.
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-local}"
CONVERSATION="${CONVERSATION:-local/chat}"
# The gateway derives an actor name from the conversation id; creating an actor
# under any other name would leave it unused and make the gateway create its own.
# The replacement uses -E because BSD sed does not understand `\+`.
CONVERSATION_SLUG="$(printf '%s' "${CONVERSATION}" | tr '[:upper:]' '[:lower:]' | sed -E -e 's/[^a-z0-9-]+/-/g' -e 's/^-+//' -e 's/-+$//' | cut -c1-40)"
ACTOR="${ACTOR:-pi-${CONVERSATION_SLUG:-conversation}}"
PROVIDER_ENV="${PROVIDER_ENV:-deploy/local/provider.env}"
EGRESS_POLICY="${EGRESS_POLICY:-deploy/local/egress-policy.yaml.tmpl}"
SECRET_NAME="${SECRET_NAME:-pi-provider}"
IDLE_SECONDS="${IDLE_SECONDS:-60}"
TELEGRAM_CHATS="${TELEGRAM_CHATS:-}"
REGISTRY="${REGISTRY:-localhost:5001}"

kube=(kubectl --context "${KUBE_CONTEXT}")
ate=("${KUBECTL_ATE}" --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need "${KUBECTL_ATE}"

# provider.env is the source of truth when it exists; exporting the same
# values in the shell is optional.
if [[ -f "${PROVIDER_ENV}" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${PROVIDER_ENV}"
  set +a
fi

require() {
  if [[ -z "$1" ]]; then
    echo "$2 is not set; copy deploy/local/provider.env.example to ${PROVIDER_ENV} and fill it in" >&2
    exit 1
  fi
}
require "${PI_PROVIDER:-}" PI_PROVIDER
require "${PI_MODEL:-}" PI_MODEL
require "${PI_PROVIDER_BASE_URL:-}" PI_PROVIDER_BASE_URL
require "${PI_PROVIDER_API:-}" PI_PROVIDER_API
require "${PI_PROVIDER_API_KEY:-}" PI_PROVIDER_API_KEY

echo "==> building and pushing the actor image"
npm run build
docker build -t "${REGISTRY}/pi-actor:local" -f images/actor/Dockerfile .
docker push "${REGISTRY}/pi-actor:local"
# A template must pin by digest. `docker inspect` reports the digest of the
# multi-arch index, and a node that pulls that index can end up with a partial
# image whose container never starts; resolve the linux/arm64 child manifest
# instead. The platform matches the node because kind runs on this machine.
ACTOR_INDEX="$(curl -sf -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "http://${REGISTRY}/v2/pi-actor/manifests/local")" || ACTOR_INDEX=""
if [[ -z "${ACTOR_INDEX}" ]]; then
  echo "could not read the image index for ${REGISTRY}/pi-actor:local" >&2
  exit 1
fi
ACTOR_DIGEST="$(printf '%s' "${ACTOR_INDEX}" | node -e '
  let body = "";
  process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
    const index = JSON.parse(body);
    const match = (index.manifests ?? []).find(
      (entry) => entry.platform?.architecture === "arm64" && entry.platform?.os === "linux",
    );
    if (match) process.stdout.write(match.digest);
  });')"
if [[ -z "${ACTOR_DIGEST}" ]]; then
  echo "no linux/arm64 manifest in ${REGISTRY}/pi-actor:local" >&2
  exit 1
fi
ACTOR_IMAGE="${REGISTRY}/pi-actor@${ACTOR_DIGEST}"

# `read` needs a terminating newline: without one it returns non-zero and
# errexit would end the script here.
read -r inferred_host inferred_port < <(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(`${url.hostname} ${url.port || (url.protocol === "https:" ? 443 : 80)}\n`);
' "${PI_PROVIDER_BASE_URL}")
PROVIDER_HOST="${PROVIDER_HOST:-${inferred_host}}"
PROVIDER_PORT="${PROVIDER_PORT:-${inferred_port}}"
CREDENTIAL_URI="${CREDENTIAL_URI:-ate-secret://k8s.io/default/${ATESPACE}/${SECRET_NAME}/api-key}"
RENDERED_POLICY=bin/egress-policy.yaml
echo "==> rendering the egress policy for ${PROVIDER_HOST}"
sed -e "s#\${PROVIDER_HOST}#${PROVIDER_HOST}#" \
    -e "s#\${PROVIDER_PORT}#${PROVIDER_PORT}#" \
    -e "s#\${CREDENTIAL_URI}#${CREDENTIAL_URI}#" \
    "${EGRESS_POLICY}" > "${RENDERED_POLICY}"

echo "==> creating the provider secret"
"${kube[@]}" -n "${ATESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal=api-key="${PI_PROVIDER_API_KEY}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -

# The credential provider is default-deny: without this the gateway cannot
# resolve the Secret and every matching request fails closed with 403.
echo "==> granting atespace ${ATESPACE} access to namespace ${ATESPACE}"
policy="$("${kube[@]}" -n ate-system get configmap k8s-credential-provider-namespace-policy -o jsonpath='{.data.namespace-policy\.yaml}')"
if ! printf '%s' "${policy}" | grep -q "atespace: ${ATESPACE}\$"; then
  # The shipped default grants nothing, written as `policies: []`. Appending a
  # list item to that inline empty list would be invalid YAML, so the whole
  # document is rebuilt from whatever entries are already there.
  if printf '%s' "${policy}" | grep -q '^policies: \[\]$'; then
    existing=""
  else
    existing="$(printf '%s' "${policy}" | sed -n '/^policies:/,$p' | tail -n +2)"
  fi
  {
    echo "policies:"
    printf '%s\n' "${existing}" | sed '/^[[:space:]]*$/d'
    printf '%s\n' "- atespace: ${ATESPACE}" "  allowedNamespaces:" "  - ${ATESPACE}"
  } > /tmp/pi-namespace-policy.yaml
  "${kube[@]}" -n ate-system create configmap k8s-credential-provider-namespace-policy \
    --from-file=namespace-policy.yaml=/tmp/pi-namespace-policy.yaml \
    --dry-run=client -o yaml | "${kube[@]}" apply -f -
  # The provider reads the policy once at startup; editing the ConfigMap alone
  # changes nothing until it restarts.
  "${kube[@]}" -n ate-system rollout restart deployment/k8s-credential-provider
  "${kube[@]}" -n ate-system rollout status deployment/k8s-credential-provider --timeout=120s
fi

echo "==> creating the actor template (${PI_PROVIDER}/${PI_MODEL})"
sed -e "s#\${ACTOR_IMAGE}#${ACTOR_IMAGE}#" \
    -e "s#\${PROVIDER}#${PI_PROVIDER}#" \
    -e "s#\${MODEL_ID}#${PI_MODEL}#" \
    -e "s#\${BASE_URL}#${PI_PROVIDER_BASE_URL}#" \
    -e "s#\${API}#${PI_PROVIDER_API}#" \
    -e "s#\${CONTEXT_WINDOW}#${PI_MODEL_CONTEXT_WINDOW:-}#" \
    -e "s#\${MAX_TOKENS}#${PI_MODEL_MAX_TOKENS:-}#" \
    deploy/test/actor-template.json.tmpl > bin/actor-template.json
# A template is immutable, so a rerun cannot replace it. Creating one is
# therefore best-effort: an existing template is reused as-is, and the warning
# says what to do when the image or the provider changed.
sed -i.bak -e "s#^  name: pi-actor\$#  name: ${ACTOR_TEMPLATE}#" -e "s#^  atespace: pi-agents\$#  atespace: ${ATESPACE}#" bin/actor-template.json && rm -f bin/actor-template.json.bak
template_error="$("${ate[@]}" create actor-template -f bin/actor-template.json 2>&1)" || {
  if ! printf '%s' "${template_error}" | grep -q "AlreadyExists"; then
    echo "${template_error}" >&2
    exit 1
  fi
  echo "template ${ATESPACE}/${ACTOR_TEMPLATE} already exists; reusing it" >&2
  echo "  (templates are immutable: set ACTOR_TEMPLATE to a new name after changing the image or provider)" >&2
}

echo "==> waiting for the golden snapshot"
for _ in $(seq 1 120); do
  tag="$("${ate[@]}" get actor-template -a "${ATESPACE}" "${ACTOR_TEMPLATE}" 2>/dev/null | tail -1 || true)"
  if echo "${tag}" | grep -qE '[0-9a-f]{8}-'; then break; fi
  if echo "${tag}" | grep -q 'ERROR'; then
    echo "template failed: ${tag}" >&2
    exit 1
  fi
  sleep 5
done

echo "==> creating actor ${ATESPACE}/${ACTOR}"
actor_error="$("${ate[@]}" create actor "${ACTOR}" -a "${ATESPACE}" --template "${ACTOR_TEMPLATE}" 2>&1)" || {
  if ! printf '%s' "${actor_error}" | grep -q "AlreadyExists"; then
    echo "${actor_error}" >&2
    exit 1
  fi
}

# The policy is replaced rather than created so a re-run after editing the
# template takes effect on the actor that already exists. An update needs the
# uid and version of the stored policy as preconditions, and those are the
# fields the API prints back. A missing policy still exits 0 here, so the
# emptiness of the uid is what says whether there is one.
existing_policy="$("${ate[@]}" get egress-policy "${ACTOR}" -a "${ATESPACE}" -o json 2>/dev/null || true)"
precondition_uid="$(printf '%s' "${existing_policy}" | node -e '
  let b = "";
  process.stdin.on("data", (c) => (b += c)).on("end", () => {
    try {
      process.stdout.write(JSON.parse(b).metadata?.uid ?? "");
    } catch {
      process.stdout.write("");
    }
  });')"
if [[ -n "${precondition_uid}" ]]; then
  precondition_version="$(printf '%s' "${existing_policy}" | node -e 'let b="";process.stdin.on("data",(c)=>b+=c).on("end",()=>process.stdout.write(String(JSON.parse(b).metadata.version)))')"
  {
    printf 'metadata:\n  atespace: %s\n  name: default\n  uid: %s\n  version: "%s"\n' \
      "${ATESPACE}" "${precondition_uid}" "${precondition_version}"
    sed -n '/^rules:/,$p' "${RENDERED_POLICY}"
  } > bin/egress-policy-update.yaml
  "${ate[@]}" update egress-policy "${ACTOR}" -a "${ATESPACE}" -f bin/egress-policy-update.yaml
else
  "${ate[@]}" create egress-policy "${ACTOR}" -a "${ATESPACE}" -f "${RENDERED_POLICY}"
fi

cat <<EOF

==> ready

Start the gateway on this machine:

  kubectl -n ate-system port-forward svc/atenet-router 8000:80 &
  KUBECTL_ATE=${KUBECTL_ATE} KUBE_CONTEXT=${KUBE_CONTEXT} \\
  PI_ACTOR_URL=ws://127.0.0.1:8000 PI_ACTOR_TEMPLATE=${ACTOR_TEMPLATE} \\
  PI_EGRESS_POLICY=${RENDERED_POLICY} PI_IDLE_SECONDS=${IDLE_SECONDS} \\
  PI_CONVERSATIONS=${CONVERSATION} PI_TELEGRAM_TOKEN=<your bot token> \\
  PI_TELEGRAM_CHATS=${TELEGRAM_CHATS:-<your chat id>} \\
    node dist/src/bin/web.js

Then send the bot a message. It creates the conversation on first use, and the
idle lifecycle suspends the actor ${IDLE_SECONDS}s after the last turn.
EOF
