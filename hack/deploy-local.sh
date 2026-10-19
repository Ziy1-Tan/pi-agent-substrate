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
#   PROVIDER          provider name in models.json (default: tokenhub)
#   PI_MODEL          model id (default: deepseek-v4-pro)
#   PI_MODELS_JSON    models.json to inline (default: ~/.pi/agent/models.json)
#   PI_MODELS_SOURCE  copy only this provider out of PI_MODELS_JSON
#   EGRESS_POLICY     egress manifest (default: deploy/local/egress-policy.yaml)
#   IDLE_SECONDS      idle window before suspend (default: 60)
#   TELEGRAM_CHATS    comma-separated chat ids to answer (empty: any chat)
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-local}"
ACTOR="${ACTOR:-pi-local-1}"
PROVIDER="${PROVIDER:-tokenhub}"
PI_MODEL="${PI_MODEL:-deepseek-v4-pro}"
PI_MODELS_JSON="${PI_MODELS_JSON:-$HOME/.pi/agent/models.json}"
EGRESS_POLICY="${EGRESS_POLICY:-deploy/local/egress-policy.yaml}"
IDLE_SECONDS="${IDLE_SECONDS:-60}"
TELEGRAM_CHATS="${TELEGRAM_CHATS:-}"
REGISTRY="${REGISTRY:-localhost:5001}"

kube=(kubectl --context "${KUBE_CONTEXT}")
ate=("${KUBECTL_ATE}" --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need "${KUBECTL_ATE}"

if [[ ! -f "${PI_MODELS_JSON}" ]]; then
  echo "no models.json at ${PI_MODELS_JSON}; set PI_MODELS_JSON" >&2
  exit 1
fi

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

echo "==> creating the actor template (${PROVIDER}/${PI_MODEL})"
MODELS_JSON="$(node -e '
  const fs = require("node:fs");
  const all = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const name = process.argv[2];
  const provider = all.providers?.[name];
  if (!provider) {
    console.error(`provider ${name} not found in ${process.argv[1]}`);
    process.exit(1);
  }
  // Only the selected provider is copied into the sandbox; the other entries
  // in the workstation catalog are not part of this deployment.
  process.stdout.write(JSON.stringify({ providers: { [name]: provider } }));
' "${PI_MODELS_JSON}" "${PROVIDER}")"
sed -e "s#\${ACTOR_IMAGE}#${ACTOR_IMAGE}#" \
    -e "s#\${MODELS_JSON}#${MODELS_JSON}#" \
    -e "s#\${PROVIDER}#${PROVIDER}#" \
    -e "s#\${MODEL_ID}#${PI_MODEL}#" \
    deploy/test/actor-template.json.tmpl > bin/actor-template.json
# A template is immutable, so a local one cannot reuse the e2e's name; the
# metadata name is the only field that differs.
sed -i.bak -e "s#^  name: pi-actor\$#  name: ${ACTOR_TEMPLATE}#" -e "s#^  atespace: pi-agents\$#  atespace: ${ATESPACE}#" bin/actor-template.json && rm -f bin/actor-template.json.bak
"${ate[@]}" create actor-template -f bin/actor-template.json

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
"${ate[@]}" create actor "${ACTOR}" -a "${ATESPACE}" --template "${ACTOR_TEMPLATE}" || true
"${ate[@]}" create egress-policy "${ACTOR}" -a "${ATESPACE}" -f "${EGRESS_POLICY}" || true

cat <<EOF

==> ready

Start the gateway on this machine:

  kubectl -n ate-system port-forward svc/atenet-router 8000:80 &
  KUBECTL_ATE=${KUBECTL_ATE} KUBE_CONTEXT=${KUBE_CONTEXT} \\
  PI_ACTOR_URL=ws://127.0.0.1:8000 PI_EGRESS_POLICY=${EGRESS_POLICY} \\
  PI_IDLE_SECONDS=${IDLE_SECONDS} PI_CONVERSATIONS=local/chat \\
  PI_TELEGRAM_TOKEN=<your bot token> PI_TELEGRAM_CHATS=${TELEGRAM_CHATS:-<your chat id>} \\
    node dist/src/bin/web.js

Then send the bot a message. It creates the conversation on first use, and the
idle lifecycle suspends the actor ${IDLE_SECONDS}s after the last turn.
EOF
