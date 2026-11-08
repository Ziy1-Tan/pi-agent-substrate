#!/usr/bin/env bash
#
# Build, push, and deploy the actor + mock LLM onto a kind cluster that
# already has Agent Substrate installed, then run the clustered e2e.
#
# Assumes:
#   - a kind cluster with Agent Substrate installed
#   - local registry on localhost:5001, reachable as a kind node host entry
#   - kubectl-ate on PATH (or KUBECTL_ATE set)
#
# Env:
#   KUBE_CONTEXT      kubectl context (default: kind-kind)
#   KUBECTL_ATE       kubectl-ate binary (default: kubectl-ate)
#   REGISTRY          image prefix (default: localhost:5001)
#   ACTOR_TEMPLATE    template name (default: pi-e2e, distinct from the manual
#                     pi-actor template so the two cannot be mixed up)
#   ATESPACE          atespace (default: pi-agents)
#   IDLE_SECONDS      idle window for the automatic-suspend e2e (default: 15)
#   SANDBOX_CLASS_NAME  gvisor (default) or microvm
#   SANDBOX_CONFIG_NAME SandboxConfig name (default: gvisor-default or microvm)
#   WORKER_IMAGE      worker image (default: copy an existing pool of the class)
#   ONLY              "deploy" to skip the e2e, "e2e" to skip the deploy
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${ROOT}"
# shellcheck source=scripts/lib.sh
. "${ROOT}/scripts/lib.sh"

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
REGISTRY="${REGISTRY:-localhost:5001}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-e2e}"
IDLE_SECONDS="${IDLE_SECONDS:-15}"
HTTP_PORT="${HTTP_PORT:-8899}"
CONVERSATIONS="${CONVERSATIONS:-web/alpha,web/beta}"
EGRESS_POLICY=deploy/e2e/egress-policy.yaml
SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME:-gvisor}"
SANDBOX_CONFIG_NAME="${SANDBOX_CONFIG_NAME:-$(sandbox_config_name "${SANDBOX_CLASS_NAME}")}"
WORKERPOOL_NAME="${WORKERPOOL_NAME:-pi-workerpool}"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE:-pi-gateway}"
SUBSTRATE_NAMESPACE="${SUBSTRATE_NAMESPACE:-ate-system}"
E2E_GATEWAY_NAME="${E2E_GATEWAY_NAME:-pi-gateway-e2e}"
E2E_GATEWAY_EGRESS="${E2E_GATEWAY_EGRESS:-pi-gateway-e2e-egress}"
GATEWAY_IMAGE="${GATEWAY_IMAGE:-${REGISTRY}/pi-gateway:local}"
ONLY="${ONLY:-}"

kube=(kubectl --context "${KUBE_CONTEXT}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need docker
need "${KUBECTL_ATE}"

if [[ "${ONLY}" != "e2e" ]]; then
  echo "==> building the actor image"
  npm run build
  docker build -t "${REGISTRY}/pi-actor:dev" -f images/actor/Dockerfile .

  echo "==> building the mock LLM image"
  docker build -t "${REGISTRY}/pi-mock-llm:dev" -f images/mock-llm/Dockerfile images/mock-llm

  echo "==> building the gateway image"
  mkdir -p bin
  cp "$(command -v "${KUBECTL_ATE}")" bin/kubectl-ate
  docker build -t "${GATEWAY_IMAGE}" -f images/gateway/Dockerfile .

  echo "==> pushing to ${REGISTRY}"
  docker push "${REGISTRY}/pi-actor:dev"
  docker push "${REGISTRY}/pi-mock-llm:dev"
  docker push "${GATEWAY_IMAGE}"

  # A template must pin its image by digest: the server refuses a tag, because
  # a moved tag would silently invalidate existing snapshots.
  case "$(uname -m)" in
    x86_64|amd64) ACTOR_ARCH=amd64 ;;
    aarch64|arm64) ACTOR_ARCH=arm64 ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  ACTOR_DIGEST="$(image_digest pi-actor dev "${ACTOR_ARCH}")" || ACTOR_DIGEST=""
  if [[ -z "${ACTOR_DIGEST}" ]]; then
    echo "no linux/${ACTOR_ARCH} manifest in ${REGISTRY}/pi-actor:dev" >&2
    exit 1
  fi

  ACTOR_IMAGE="${REGISTRY}/pi-actor@${ACTOR_DIGEST}"
  MOCK_LLM_IMAGE="${REGISTRY}/pi-mock-llm:dev"
  # The worker image matches the sandbox class. Reuse what an existing pool
  # already runs, so this script tracks the installed version.
  WORKER_IMAGE="${WORKER_IMAGE:-$(worker_image_for "${SANDBOX_CLASS_NAME}")}"
  if [[ -z "${WORKER_IMAGE}" ]]; then
    echo "no existing ${SANDBOX_CLASS_NAME} WorkerPool to copy workerImage from; set WORKER_IMAGE" >&2
    exit 1
  fi

  echo "==> applying namespace, worker pool, and mock LLM"
  mkdir -p bin
  ATESPACE="${ATESPACE}" WORKERPOOL_NAME="${WORKERPOOL_NAME}" \
    SANDBOX_CLASS_NAME="${SANDBOX_CLASS_NAME}" SANDBOX_CONFIG_NAME="${SANDBOX_CONFIG_NAME}" \
    WORKER_IMAGE="${WORKER_IMAGE}" \
    envsubst '${ATESPACE} ${WORKERPOOL_NAME} ${SANDBOX_CLASS_NAME} ${SANDBOX_CONFIG_NAME} ${WORKER_IMAGE}' \
    < deploy/workerpool.yaml.tmpl | "${kube[@]}" apply -f -
  ATESPACE="${ATESPACE}" MOCK_LLM_IMAGE="${MOCK_LLM_IMAGE}" \
    envsubst '${ATESPACE} ${MOCK_LLM_IMAGE}' < deploy/e2e/mock-llm.yaml.tmpl | "${kube[@]}" apply -f -

  "${kube[@]}" -n "${ATESPACE}" rollout status deploy/mock-llm --timeout=180s
  "${kube[@]}" -n "${ATESPACE}" rollout status "deploy/${WORKERPOOL_NAME}" --timeout=180s

  echo "==> creating the actor template"
  PI_PROVIDER=mock
  PI_MODEL=mock-model
  PI_PROVIDER_BASE_URL="http://mock-llm.${ATESPACE}.svc.cluster.local:8080/v1"
  PI_PROVIDER_API=openai-completions
  render_actor_template bin/actor-template.json "${ACTOR_IMAGE}"

  # A template is immutable and the server refuses a create when one already
  # exists, so a rerun against the same cluster would fail. Every run builds a
  # new image whose digest differs even for identical sources (the layer tar
  # carries file mtimes), so the template has to be rebuilt rather than
  # compared. An actor on a replaced template can never resume ("actor
  # template not found"), which is why the actors go first.
  stale_actors() {
    "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} get actor -a "${ATESPACE}" -o json 2>/dev/null |
      node -e '
        let body = "";
        process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
          const [template] = process.argv.slice(1);
          let parsed;
          try { parsed = JSON.parse(body); } catch { return; }
          for (const actor of parsed.actors ?? []) {
            if (actor.actorTemplate?.name === template) process.stdout.write(`${actor.metadata.name}\n`);
          }
        });' "${ACTOR_TEMPLATE}"
  }
  # Captured before the loop: a pipeline would run the loop in a subshell and
  # its output would not reach this log.
  stale="$(stale_actors)"
  while IFS= read -r name; do
    [[ -n "${name}" ]] || continue
    "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} delete actor "${name}" -a "${ATESPACE}" >/dev/null
    echo "    removed actor ${name}, left over from an earlier run"
  done <<< "${stale}"
  if "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} get actor-template -a "${ATESPACE}" "${ACTOR_TEMPLATE}" >/dev/null 2>&1; then
    echo "    replacing template ${ATESPACE}/${ACTOR_TEMPLATE} with the image this run built"
    "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} delete actor-template "${ACTOR_TEMPLATE}" -a "${ATESPACE}"
  fi
  "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} create actor-template -f bin/actor-template.json

  echo "==> waiting for the golden snapshot"
  for _ in $(seq 1 120); do
    tag="$("${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} get actor-template -a "${ATESPACE}" "${ACTOR_TEMPLATE}" 2>/dev/null | tail -1 || true)"
    if echo "${tag}" | grep -qE '[0-9a-f]{8}-'; then break; fi
    if echo "${tag}" | grep -q 'ERROR'; then
      echo "template failed: ${tag}" >&2
      exit 1
    fi
    sleep 5
  done

fi

if [[ "${ONLY}" != "deploy" ]]; then
  echo "==> deploying the e2e gateway"
  "${kube[@]}" create namespace "${GATEWAY_NAMESPACE}" --dry-run=client -o yaml | "${kube[@]}" apply -f -
  "${kube[@]}" -n "${GATEWAY_NAMESPACE}" create configmap "${E2E_GATEWAY_EGRESS}" \
    --from-file=egress-policy.yaml="${EGRESS_POLICY}" \
    --dry-run=client -o yaml | "${kube[@]}" apply -f -
  # Start from an empty deployment so the metrics counters describe this run.
  "${kube[@]}" -n "${GATEWAY_NAMESPACE}" delete deploy/"${E2E_GATEWAY_NAME}" svc/"${E2E_GATEWAY_NAME}" \
    --ignore-not-found >/dev/null
  GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE}" GATEWAY_NAME="${E2E_GATEWAY_NAME}" \
    GATEWAY_EGRESS_CONFIGMAP="${E2E_GATEWAY_EGRESS}" \
    SUBSTRATE_NAMESPACE="${SUBSTRATE_NAMESPACE}" \
    GATEWAY_IMAGE="${GATEWAY_IMAGE}" ATESPACE="${ATESPACE}" ACTOR_TEMPLATE="${ACTOR_TEMPLATE}" \
    IDLE_SECONDS="${IDLE_SECONDS}" \
    envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_NAME} ${GATEWAY_EGRESS_CONFIGMAP} ${SUBSTRATE_NAMESPACE} ${GATEWAY_IMAGE} ${ATESPACE} ${ACTOR_TEMPLATE} ${IDLE_SECONDS}' \
    < deploy/local/gateway.yaml.tmpl | "${kube[@]}" apply -f -
  "${kube[@]}" -n "${GATEWAY_NAMESPACE}" rollout status "deploy/${E2E_GATEWAY_NAME}" --timeout=180s
  "${kube[@]}" -n "${GATEWAY_NAMESPACE}" port-forward "svc/${E2E_GATEWAY_NAME}" "${HTTP_PORT}:8788" >/tmp/pi-e2e-gateway.log 2>&1 &
  gateway_forward=$!
  trap 'kill ${gateway_forward:-} 2>/dev/null || true' EXIT

  echo "==> running the gateway e2e"
  E2E_ATESPACE="${ATESPACE}" \
    KUBECTL_ATE="${KUBECTL_ATE}" KUBE_CONTEXT="${KUBE_CONTEXT}" \
    E2E_IDLE_SECONDS="${IDLE_SECONDS}" E2E_HTTP_PORT="${HTTP_PORT}" \
    E2E_CONVERSATIONS="${CONVERSATIONS}" \
    node scripts/e2e/gateway.js

  echo "==> removing the e2e gateway"
  kill "${gateway_forward}" 2>/dev/null || true
  "${kube[@]}" -n "${GATEWAY_NAMESPACE}" delete deploy/"${E2E_GATEWAY_NAME}" svc/"${E2E_GATEWAY_NAME}" \
    configmap/"${E2E_GATEWAY_EGRESS}" --ignore-not-found >/dev/null
fi
