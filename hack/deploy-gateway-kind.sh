#!/usr/bin/env bash
#
# Build and deploy the always-on Telegram gateway into kind.
#
# The gateway runs as a one-replica Deployment so it owns the single Telegram
# long-poll connection, and a PVC keeps the conversation log across pod restarts.
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-local2}"
REGISTRY="${REGISTRY:-localhost:5001}"
IMAGE="${IMAGE:-${REGISTRY}/pi-gateway:local}"
TELEGRAM_CHATS="${TELEGRAM_CHATS:-}"
STOP_LOCAL_GATEWAY="${STOP_LOCAL_GATEWAY:-0}"

kube=(kubectl --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need kubectl

if [[ ! -f deploy/local/gateway.env ]]; then
  echo "missing deploy/local/gateway.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. deploy/local/gateway.env
set +a
TELEGRAM_CHATS="${TELEGRAM_CHATS:-${PI_TELEGRAM_CHATS:-}}"
: "${PI_TELEGRAM_TOKEN:?PI_TELEGRAM_TOKEN is required}"
: "${TELEGRAM_CHATS:?TELEGRAM_CHATS or PI_TELEGRAM_CHATS is required}"

if [[ ! -f bin/egress-policy.yaml ]]; then
  echo "missing bin/egress-policy.yaml; run hack/deploy-local.sh first" >&2
  exit 1
fi

echo "==> building and pushing ${IMAGE}"
npm run build
docker build -t "${IMAGE}" -f images/gateway/Dockerfile .
docker push "${IMAGE}"
IMAGE_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE}")"
if [[ -z "${IMAGE_DIGEST}" ]]; then
  echo "could not resolve the pushed gateway image digest" >&2
  exit 1
fi

if [[ "${STOP_LOCAL_GATEWAY}" == 1 ]]; then
  echo "==> stopping the workstation launchd gateway"
  launchctl bootout "gui/$(id -u)/com.tanziyi.pi-gateway" 2>/dev/null || true
fi

echo "==> creating Telegram and egress config"
"${kube[@]}" -n "${ATESPACE}" create secret generic pi-gateway-telegram \
  --from-literal=PI_TELEGRAM_TOKEN="${PI_TELEGRAM_TOKEN}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n "${ATESPACE}" create configmap pi-gateway-egress \
  --from-file=egress-policy.yaml=bin/egress-policy.yaml \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -

echo "==> rendering gateway manifest"
mkdir -p bin
GATEWAY_IMAGE="${IMAGE_DIGEST}" ATESPACE="${ATESPACE}" \
  ACTOR_TEMPLATE="${ACTOR_TEMPLATE}" TELEGRAM_CHATS="${TELEGRAM_CHATS}" \
  node -e '
    const fs = require("node:fs");
    const source = fs.readFileSync("deploy/local/gateway.yaml.tmpl", "utf8");
    const replacements = {
      ATESPACE: process.env.ATESPACE,
      ACTOR_TEMPLATE: process.env.ACTOR_TEMPLATE,
      TELEGRAM_CHATS: process.env.TELEGRAM_CHATS,
      GATEWAY_IMAGE: process.env.GATEWAY_IMAGE,
    };
    fs.writeFileSync("bin/gateway.yaml", source.replace(/\$\{([A-Z_]+)\}/g, (_, key) => {
      if (!(key in replacements)) throw new Error(`missing replacement: ${key}`);
      return replacements[key];
    }));
  '

"${kube[@]}" apply -f bin/gateway.yaml
"${kube[@]}" -n "${ATESPACE}" rollout status deployment/pi-gateway --timeout=180s

echo "==> gateway pod"
"${kube[@]}" -n "${ATESPACE}" get deploy pi-gateway
"${kube[@]}" -n "${ATESPACE}" get pod -l app=pi-gateway -o wide

echo "==> gateway metrics"
"${kube[@]}" -n "${ATESPACE}" exec deploy/pi-gateway -- \
  curl -fsS http://127.0.0.1:8788/metrics

echo
echo "gateway is deployed in ${ATESPACE}."
