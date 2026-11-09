#!/usr/bin/env bash
#
# Local, single-user deployment: kind cluster, real model provider.
#
# It deploys the gateway into the cluster: the gateway reaches atenet-router
# over HTTPS with its projected podidentity certificate and answers
# POST /messages. The provider key goes into a Secret and never enters the
# actor; egress injects it.
#
# Assumes:
#   - kind cluster with Agent Substrate v1.0.0 installed
#   - local registry on localhost:5001
#   - kubectl-ate v1.0.0 on PATH (or KUBECTL_ATE set)
#
# Env:
#   KUBE_CONTEXT      kubectl context (default: kind-kind)
#   KUBECTL_ATE       kubectl-ate binary (default: kubectl-ate)
#   ATESPACE          atespace (default: pi-agents); created if absent
#   ACTOR_TEMPLATE    template name (default: pi-local-v1-0-0; names may not
#                     contain dots)
#   SANDBOX_CLASS_NAME  microvm (default) or gvisor
#   WORKER_IMAGE      worker image (default: the cluster's existing pool for
#                     this class, then the release image)
#   IDLE_SECONDS      idle window before suspend (default: 60)
#   REGISTRY          image registry (default: localhost:5001)
#   PROVIDER_ENV      provider config file (default: deploy/provider.env)
#   PI_PROVIDER / PI_MODEL / PI_PROVIDER_BASE_URL / PI_PROVIDER_API /
#   PI_PROVIDER_API_KEY
#                     source provider values, normally from provider.env
#
# The API key never enters the actor. The template carries a placeholder, and
# the egress gateway replaces the auth header on the way out.
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
# shellcheck source=deploy/lib.sh
. "${ROOT}/deploy/lib.sh"

# The gateway image runs kubectl-ate inside a Linux container, so the binary it
# copies must be a Linux one. On a Linux host the installed binary already is;
# elsewhere set KUBECTL_ATE_LINUX to a linux build of the same release.
gateway_kubectl_ate() { # <target-file>
	local target="$1" src
	if [[ -n "${KUBECTL_ATE_LINUX:-}" ]]; then
		src="${KUBECTL_ATE_LINUX}"
	elif [[ "$(uname -s)" == "Linux" ]]; then
		src="$(command -v "${KUBECTL_ATE}")"
	else
		echo "the gateway image needs a Linux kubectl-ate: set KUBECTL_ATE_LINUX" >&2
		return 1
	fi
	cp "${src}" "${target}"
}

SUBSTRATE_VERSION="$(node -p "require('./package.json').substrateVersion")"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-local-v1-0-0}"
PROVIDER_ENV="${PROVIDER_ENV:-deploy/provider.env}"
SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME:-microvm}"
SANDBOX_CONFIG_NAME="$(sandbox_config_name "${SANDBOX_CLASS_NAME}")"
WORKERPOOL_NAME="pi-workerpool-${SANDBOX_CLASS_NAME}"
WORKER_IMAGE="${WORKER_IMAGE:-}"
IDLE_SECONDS="${IDLE_SECONDS:-60}"
REGISTRY="${REGISTRY:-localhost:5001}"
GATEWAY_IMAGE="${REGISTRY}/pi-gateway:local"
GATEWAY_NAME=pi-gateway
GATEWAY_EGRESS_CONFIGMAP="${GATEWAY_NAME}-egress"
SUBSTRATE_NAMESPACE=ate-system
SECRET_NAME=pi-provider

kube=(kubectl --context "${KUBE_CONTEXT}")
ate=("${KUBECTL_ATE}" --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need node
need envsubst
need "${KUBECTL_ATE}"

ate_version="$("${KUBECTL_ATE}" --version 2>&1 || true)"
if [[ "${ate_version}" != *"v${SUBSTRATE_VERSION}"* && "${ate_version}" != *"(devel)"* ]]; then
  echo "kubectl-ate is not v${SUBSTRATE_VERSION}: ${ate_version}" >&2
  echo "install the release binary, or set KUBECTL_ATE" >&2
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
    echo "$2 is not set; copy deploy/provider.env.example to ${PROVIDER_ENV} and fill it in" >&2
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
docker build -t "${REGISTRY}/pi-actor:local" -f deploy/actor.Dockerfile .
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
gateway_kubectl_ate bin/kubectl-ate
docker build -t "${GATEWAY_IMAGE}" -f deploy/gateway.Dockerfile .
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
  < deploy/workerpool.yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n "${ATESPACE}" rollout status "deploy/${WORKERPOOL_NAME}" --timeout=300s

# `read` needs a terminating newline: without one it returns non-zero and
# errexit would end the script here.
read -r inferred_host inferred_port < <(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(`${url.hostname} ${url.port || (url.protocol === "https:" ? 443 : 80)}\n`);
' "${PI_PROVIDER_BASE_URL}")
PROVIDER_HOST="${inferred_host}"
PROVIDER_PORT="${inferred_port}"
CREDENTIAL_URI="ate-secret://k8s.io/default/${ATESPACE}/${SECRET_NAME}/api-key"
RENDERED_POLICY=bin/egress-policy.yaml
echo "==> rendering the egress policy for ${PROVIDER_HOST}"
PROVIDER_HOST="${PROVIDER_HOST}" PROVIDER_PORT="${PROVIDER_PORT}" \
AUTH_HEADER="${AUTH_HEADER}" AUTH_PREFIX="${AUTH_PREFIX}" CREDENTIAL_URI="${CREDENTIAL_URI}" \
envsubst '${PROVIDER_HOST} ${PROVIDER_PORT} ${AUTH_HEADER} ${AUTH_PREFIX} ${CREDENTIAL_URI}' \
  < deploy/egress-policy.yaml > "${RENDERED_POLICY}"

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
render_actor_template bin/actor-template.yaml "${ACTOR_IMAGE}"
# A template is immutable, so a rerun cannot replace it. Creating one is
# therefore best-effort: an existing template is reused as-is, and the warning
# says what to do when the image or the provider changed.
template_error="$("${ate[@]}" create actor-template -f bin/actor-template.yaml 2>&1)" || {
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

gateway_spiffe="spiffe://cluster.local/ns/pi-gateway/sa/pi-gateway"
if ! "${kube[@]}" -n "${SUBSTRATE_NAMESPACE}" get deploy atenet-router -o yaml 2>/dev/null | grep -q "${gateway_spiffe}"; then
  echo "atenet-router does not allow ${gateway_spiffe}" >&2
  echo "reinstall substrate with --ingress-allowed-spiffe-ids=${gateway_spiffe}" >&2
  exit 1
fi

echo "==> creating the gateway namespace and inputs"
"${kube[@]}" create namespace pi-gateway --dry-run=client -o yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n pi-gateway create configmap "${GATEWAY_EGRESS_CONFIGMAP}" \
  --from-file=egress-policy.yaml="${RENDERED_POLICY}" \
  --dry-run=client -o yaml | "${kube[@]}" apply -f -

echo "==> applying the gateway"
GATEWAY_NAME="${GATEWAY_NAME}" GATEWAY_EGRESS_CONFIGMAP="${GATEWAY_EGRESS_CONFIGMAP}" \
  GATEWAY_IMAGE="${GATEWAY_IMAGE}" ATESPACE="${ATESPACE}" ACTOR_TEMPLATE="${ACTOR_TEMPLATE}" \
  IDLE_SECONDS="${IDLE_SECONDS}" \
  envsubst '${GATEWAY_NAME} ${GATEWAY_EGRESS_CONFIGMAP} ${GATEWAY_IMAGE} ${ATESPACE} ${ACTOR_TEMPLATE} ${IDLE_SECONDS}' \
  < deploy/gateway.yaml | "${kube[@]}" apply -f -
"${kube[@]}" -n pi-gateway rollout status "deploy/${GATEWAY_NAME}" --timeout=180s

cat <<EOF

==> ready

Reach the gateway API from this machine:

  kubectl --context ${KUBE_CONTEXT} -n pi-gateway port-forward svc/${GATEWAY_NAME} 8788:8788 &
  curl -s -X POST http://127.0.0.1:8788/messages \\
    -H 'content-type: application/json' \\
    -d '{"conversation":"local/chat","text":"hello"}'

The gateway reaches actors through atenet-router over wss, creates the actor
on first use, and suspends it ${IDLE_SECONDS}s after the last turn.
EOF
