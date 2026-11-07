#!/usr/bin/env bash
#
# Local, single-user deployment: kind cluster, real model provider, Telegram.
#
# This is the path for "my own machine, my own bot". It deploys the gateway
# into the cluster: the gateway reaches atenet-router over HTTPS with its
# projected podidentity certificate, keeps its conversation log on a PVC, and
# reads the bot token from a Secret. The actor never sees either.
#
# Assumes:
#   - kind cluster with Agent Substrate v1.0.0 installed
#   - local registry on localhost:5001
#   - kubectl-ate v1.0.0 on PATH (or KUBECTL_ATE set)
#
# Env:
#   KUBE_CONTEXT      kubectl context (default: kind-kind)
#   KUBECTL_ATE       kubectl-ate binary (default: kubectl-ate)
#   KUBECTL_ATE_BIN   local binary copied into the gateway image
#                     (default: KUBECTL_ATE resolved on PATH)
#   SUBSTRATE_VERSION substrate release the cluster and CLI run (default:
#                     package.json substrateVersion)
#   ATESPACE          atespace (default: pi-agents); created if absent
#   ACTOR_TEMPLATE    template name (default: pi-local-v1-0-0; names may not
#                     contain dots)
#   WORKERPOOL_NAME   WorkerPool name (default: pi-workerpool-<class>)
#   CONVERSATION      conversation to pre-create an actor for (default: local/chat)
#   ACTOR             actor name (default: derived from CONVERSATION, matching
#                     the gateway's mapping: local/chat -> pi-local-chat)
#   PROVIDER_ENV      provider config file, sourced if present
#                     (default: deploy/local/provider.env)
#   PI_PROVIDER       provider id (required)
#   PI_MODEL          model id (required)
#   PI_PROVIDER_BASE_URL  provider endpoint (required)
#   PI_PROVIDER_API   wire protocol: openai-completions, openai-responses, or
#                     anthropic-messages (required)
#   PI_PROVIDER_API_KEY   API key, written to a Secret (required)
#   PI_MODEL_CONTEXT_WINDOW / PI_MODEL_MAX_TOKENS
#                     optional model metadata (Pi defaults: 128000 / 16384)
#   EGRESS_POLICY     egress manifest template (default:
#                     deploy/local/egress-policy.yaml.tmpl)
#   PROVIDER_HOST     host named in the egress policy (default: parsed from the
#                     provider's baseUrl)
#   SECRET_NAME       Kubernetes Secret holding the API key (default: pi-provider)
#   SANDBOX_CLASS_NAME  microvm (default) or gvisor
#   SANDBOX_CONFIG_NAME SandboxConfig name (default: microvm or gvisor-default)
#   WORKER_IMAGE      worker image (default: the cluster's existing pool for
#                     this class, then the release image for SUBSTRATE_VERSION)
#   IDLE_SECONDS      idle window before suspend (default: 60)
#   TELEGRAM_TOKEN    bot token; empty disables the Telegram entry point
#   TELEGRAM_CHATS    comma-separated chat ids to answer (empty: any chat)
#   GATEWAY_NAMESPACE namespace for the gateway (default: pi-gateway)
#   SUBSTRATE_NAMESPACE system namespace (default: ate-system)
#   REGISTRY          image registry (default: localhost:5001)
#
# The API key never enters the actor. The template carries a placeholder, and
# the egress gateway replaces the auth header on the way out.
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
# shellcheck source=scripts/lib.sh
. "${ROOT}/scripts/lib.sh"

SUBSTRATE_VERSION="${SUBSTRATE_VERSION:-$(node -p "require('./package.json').substrateVersion")}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-local-v1-0-0}"
CONVERSATION="${CONVERSATION:-local/chat}"
# The gateway derives an actor name from the conversation id; creating an actor
# under any other name would leave it unused and make the gateway create its own.
# The replacement uses -E because BSD sed does not understand `\+`.
CONVERSATION_SLUG="$(printf '%s' "${CONVERSATION}" | tr '[:upper:]' '[:lower:]' | sed -E -e 's/[^a-z0-9-]+/-/g' -e 's/^-+//' -e 's/-+$//' | cut -c1-40)"
ACTOR="${ACTOR:-pi-${CONVERSATION_SLUG:-conversation}}"
PROVIDER_ENV="${PROVIDER_ENV:-deploy/local/provider.env}"
EGRESS_POLICY="${EGRESS_POLICY:-deploy/local/egress-policy.yaml.tmpl}"
SECRET_NAME="${SECRET_NAME:-pi-provider}"
SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME:-microvm}"
SANDBOX_CONFIG_NAME="${SANDBOX_CONFIG_NAME:-$(sandbox_config_name "${SANDBOX_CLASS_NAME}")}"
WORKERPOOL_NAME="${WORKERPOOL_NAME:-pi-workerpool-${SANDBOX_CLASS_NAME}}"
WORKER_IMAGE="${WORKER_IMAGE:-}"
IDLE_SECONDS="${IDLE_SECONDS:-60}"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-${PI_TELEGRAM_TOKEN:-}}"
TELEGRAM_CHATS="${TELEGRAM_CHATS:-${PI_TELEGRAM_CHATS:-}}"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE:-pi-gateway}"
SUBSTRATE_NAMESPACE="${SUBSTRATE_NAMESPACE:-ate-system}"
REGISTRY="${REGISTRY:-localhost:5001}"
GATEWAY_IMAGE="${GATEWAY_IMAGE:-${REGISTRY}/pi-gateway:local}"

kube=(kubectl --context "${KUBE_CONTEXT}")
ate=("${KUBECTL_ATE}" --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need envsubst
need "${KUBECTL_ATE}"

KUBECTL_ATE_BIN="${KUBECTL_ATE_BIN:-$(command -v "${KUBECTL_ATE}")}"
ate_version="$("${KUBECTL_ATE}" --version 2>&1 || true)"
if [[ "${ate_version}" != *"v${SUBSTRATE_VERSION}"* && "${ate_version}" != *"(devel)"* ]]; then
  echo "kubectl-ate is not v${SUBSTRATE_VERSION}: ${ate_version}" >&2
  echo "install the release binary, or set KUBECTL_ATE/KUBECTL_ATE_BIN" >&2
  exit 1
fi

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

if [[ "${SANDBOX_CLASS_NAME}" == "microvm" ]]; then
  kvm_total="$("${kube[@]}" get nodes -o jsonpath='{range .items[*]}{.status.allocatable.ate\.dev/kvm}{"\n"}{end}' | awk '{total += $1} END {print total + 0}')"
  if [[ "${kvm_total}" == "0" ]]; then
    echo "no node advertises ate.dev/kvm; ${SANDBOX_CLASS_NAME} needs nested virtualization" >&2
    exit 1
  fi
fi

# Pi sends the key in the header its wire API uses. Anthropic uses x-api-key;
# the OpenAI-compatible APIs use an Authorization bearer token.
case "${PI_PROVIDER_API}" in
  anthropic-messages) AUTH_HEADER=x-api-key; AUTH_PREFIX="" ;;
  openai-completions|openai-responses) AUTH_HEADER=Authorization; AUTH_PREFIX="Bearer " ;;
  *) echo "unsupported PI_PROVIDER_API: ${PI_PROVIDER_API}" >&2; exit 1 ;;
esac

echo "==> building and pushing the actor image"
npm run build
docker build -t "${REGISTRY}/pi-actor:local" -f images/actor/Dockerfile .
docker push "${REGISTRY}/pi-actor:local"
# A template must pin by digest. `docker inspect` reports the digest of the
# multi-arch index, and a node that pulls that index can end up with a partial
# image whose container never starts; resolve the child manifest for this
# machine's architecture instead. kind runs on this machine, so that is the
# node's architecture too.
case "$(uname -m)" in
  x86_64|amd64) ACTOR_ARCH=amd64 ;;
  aarch64|arm64) ACTOR_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
ACTOR_DIGEST="$(image_digest pi-actor local "${ACTOR_ARCH}")" || ACTOR_DIGEST=""
if [[ -z "${ACTOR_DIGEST}" ]]; then
  echo "no linux/${ACTOR_ARCH} manifest in ${REGISTRY}/pi-actor:local" >&2
  exit 1
fi
ACTOR_IMAGE="${REGISTRY}/pi-actor@${ACTOR_DIGEST}"

echo "==> building and pushing the gateway image"
mkdir -p bin
cp "${KUBECTL_ATE_BIN}" bin/kubectl-ate
docker build -t "${GATEWAY_IMAGE}" -f images/gateway/Dockerfile .
docker push "${GATEWAY_IMAGE}"

echo "==> ensuring atespace ${ATESPACE}"
if ! "${ate[@]}" get atespace "${ATESPACE}" >/dev/null 2>&1; then
  "${ate[@]}" create atespace "${ATESPACE}"
fi

# The worker image tracks the installed substrate. Prefer what an existing
# pool of this class already runs; fall back to the release image.
if [[ -z "${WORKER_IMAGE}" ]]; then
  WORKER_IMAGE="$(worker_image_for "${SANDBOX_CLASS_NAME}")" || WORKER_IMAGE=""
fi
if [[ -z "${WORKER_IMAGE}" ]]; then
  WORKER_IMAGE="ghcr.io/agent-substrate/substrate/ateworker-${SANDBOX_CLASS_NAME}:v${SUBSTRATE_VERSION}"
fi

echo "==> applying worker pool ${WORKERPOOL_NAME} (${SANDBOX_CLASS_NAME})"
ATESPACE="${ATESPACE}" WORKERPOOL_NAME="${WORKERPOOL_NAME}" \
  SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME}" SANDBOX_CONFIG_NAME="${SANDBOX_CONFIG_NAME}" \
  WORKER_IMAGE="${WORKER_IMAGE}" \
  envsubst '${ATESPACE} ${WORKERPOOL_NAME} ${SANDBOX_CLASS_NAME} ${SANDBOX_CONFIG_NAME} ${WORKER_IMAGE}' \
  < deploy/workerpool.yaml.tmpl | "${kube[@]}" apply -f -
"${kube[@]}" -n "${ATESPACE}" rollout status "deploy/${WORKERPOOL_NAME}" --timeout=300s

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
    -e "s#\${AUTH_HEADER}#${AUTH_HEADER}#" \
    -e "s#\${AUTH_PREFIX}#${AUTH_PREFIX}#" \
    -e "s#\${CREDENTIAL_URI}#${CREDENTIAL_URI}#" \
    "${EGRESS_POLICY}" > "${RENDERED_POLICY}"

echo "==> creating the provider secret"
"${kube[@]}" -n "${ATESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal=api-key="${PI_PROVIDER_API_KEY}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -

# The credential provider is default-deny: without this the gateway cannot
# resolve the Secret and every matching request fails closed with 403.
echo "==> granting atespace ${ATESPACE} access to namespace ${ATESPACE}"
policy="$("${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" get configmap k8s-credential-provider-namespace-policy -o jsonpath='{.data.namespace-policy\.yaml}')"
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
  "${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" create configmap k8s-credential-provider-namespace-policy \
    --from-file=namespace-policy.yaml=/tmp/pi-namespace-policy.yaml \
    --dry-run=client -o yaml | "${kube[@]}" apply -f -
  # The provider reads the policy once at startup; editing the ConfigMap alone
  # changes nothing until it restarts.
  "${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" rollout restart deployment/k8s-credential-provider
  "${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" rollout status deployment/k8s-credential-provider --timeout=120s
fi

echo "==> creating the actor template (${PI_PROVIDER}/${PI_MODEL})"
render_actor_template bin/actor-template.json "${ACTOR_IMAGE}"
# A template is immutable, so a rerun cannot replace it. Creating one is
# therefore best-effort: an existing template is reused as-is, and the warning
# says what to do when the image or the provider changed.
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
if ! printf '%s' "${tag}" | grep -qE '[0-9a-f]{8}-'; then
  echo "template did not produce a golden snapshot; inspect ${ATESPACE}/${ACTOR_TEMPLATE}" >&2
  exit 1
fi

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

gateway_spiffe="spiffe://cluster.local/ns/${GATEWAY_NAMESPACE}/sa/pi-gateway"
if ! "${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" get deploy atenet-router -o yaml 2>/dev/null | grep -q "${gateway_spiffe}"; then
  echo "atenet-router does not allow ${gateway_spiffe}" >&2
  echo "reinstall substrate with --ingress-allowed-spiffe-ids=${gateway_spiffe}" >&2
  exit 1
fi

echo "==> creating the gateway namespace and inputs"
"${kube[@]}" create namespace "${GATEWAY_NAMESPACE}" --dry-run=client -o yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n "${GATEWAY_NAMESPACE}" create secret generic pi-telegram \
  --from-literal=token="${TELEGRAM_TOKEN}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n "${GATEWAY_NAMESPACE}" create configmap pi-gateway-egress \
  --from-file=egress-policy.yaml="${RENDERED_POLICY}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -

echo "==> applying the gateway"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE}" SUBSTRATE_NAMESPACE="${SUBSTRATE_NAMESPACE}" \
  GATEWAY_IMAGE="${GATEWAY_IMAGE}" ATESPACE="${ATESPACE}" ACTOR_TEMPLATE="${ACTOR_TEMPLATE}" \
  IDLE_SECONDS="${IDLE_SECONDS}" TELEGRAM_CHATS="${TELEGRAM_CHATS}" \
  envsubst '${GATEWAY_NAMESPACE} ${SUBSTRATE_NAMESPACE} ${GATEWAY_IMAGE} ${ATESPACE} ${ACTOR_TEMPLATE} ${IDLE_SECONDS} ${TELEGRAM_CHATS}' \
  < deploy/local/gateway.yaml.tmpl | "${kube[@]}" apply -f -
"${kube[@]}" -n "${GATEWAY_NAMESPACE}" rollout status deploy/pi-gateway --timeout=180s

telegram_status=$([[ -n "${TELEGRAM_TOKEN}" ]] && echo enabled || echo disabled)

cat <<EOF

==> ready

Reach the gateway API from this machine:

  kubectl --context ${KUBE_CONTEXT} -n ${GATEWAY_NAMESPACE} port-forward svc/pi-gateway 8788:8788 &
  curl -s -X POST http://127.0.0.1:8788/messages \\
    -H 'content-type: application/json' \\
    -d '{"conversation":"${CONVERSATION}","text":"hello"}'

The gateway reaches actors through atenet-router over wss, creates the actor
on first use, and suspends it ${IDLE_SECONDS}s after the last turn. Telegram is
${telegram_status}; chats: ${TELEGRAM_CHATS:-any}.
EOF
