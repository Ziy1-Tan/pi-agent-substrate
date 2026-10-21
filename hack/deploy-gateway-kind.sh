#!/usr/bin/env bash
#
# Build and deploy the always-on Telegram gateway into kind.
#
# One replica owns Telegram's long poll. A PVC preserves the conversation log.
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
ENV_FILE="${PI_GATEWAY_ENV_FILE:-deploy/local/gateway.env}"

kube=(kubectl --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need kubectl

set -a
# shellcheck disable=SC1091
if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
fi
set +a
TELEGRAM_CHATS="${TELEGRAM_CHATS:-${PI_TELEGRAM_CHATS:-}}"

if [[ "${STOP_LOCAL_GATEWAY}" == 1 ]]; then
  echo "==> stopping the workstation launchd gateway"
  launchctl bootout "gui/$(id -u)/com.tanziyi.pi-gateway" 2>/dev/null || true
fi

if [[ -z "${TELEGRAM_CHATS}" ]]; then
  replicas="$("${kube[@]}" -n "${ATESPACE}" get deployment pi-gateway \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  if [[ "${replicas:-0}" -gt 0 ]]; then
    echo "pi-gateway is already polling; scale it down before discovering a chat id:" >&2
    echo "  kubectl --context ${KUBE_CONTEXT} -n ${ATESPACE} scale deploy pi-gateway --replicas=0" >&2
    exit 1
  fi
  echo "==> discovering the Telegram chat id"
  TELEGRAM_CHATS="$(
    PI_TELEGRAM_TOKEN="${PI_TELEGRAM_TOKEN}" \
      PI_GATEWAY_ENV_FILE="${ENV_FILE}" \
      ./hack/telegram-chat-id.sh --write |
      sed -n 's/^PI_TELEGRAM_CHATS=//p' |
      tail -n 1
  )"
fi

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
