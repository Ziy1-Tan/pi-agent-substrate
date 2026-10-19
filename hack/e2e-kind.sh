#!/usr/bin/env bash
#
# Build, push, and deploy the actor + mock LLM onto a kind cluster that
# already has Agent Substrate installed, then run the clustered e2e.
#
# Assumes:
#   - `hack/create-kind-cluster.sh` and the substrate kind install have run
#   - local registry on localhost:5001, reachable as a kind node host entry
#   - kubectl-ate on PATH (or KUBECTL_ATE set)
#
# Env:
#   KUBE_CONTEXT      kubectl context (default: kind-kind)
#   KUBECTL_ATE       kubectl-ate binary (default: kubectl-ate)
#   REGISTRY          image prefix (default: localhost:5001)
#   ACTOR_TEMPLATE    template name (default: pi-actor)
#   ATESPACE          atespace (default: pi-agents)
#   ROUTER_URL        router base URL as seen from this machine (default: http://127.0.0.1:8000)
#   IDLE_SECONDS      idle window for the automatic-suspend e2e (default: 15)
#   WEB_PORT          port for the browser-channel e2e (default: 8899)
#   CONVERSATIONS     two conversation ids for that e2e (default: web/alpha,web/beta)
#   PROVIDER          "mock" (default) or a real provider id; a real provider
#                     also needs the PI_PROVIDER_* values below and an egress
#                     policy that reaches it
#   PI_MODEL          model id for a real provider
#   PI_PROVIDER_BASE_URL / PI_PROVIDER_API
#                     endpoint and wire protocol for a real provider
#   EGRESS_POLICY     manifest applied to the actor (default: the mock policy)
#   ONLY              "deploy" to skip the e2e, "e2e" to skip the deploy
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
KUBECTL_ATE="${KUBECTL_ATE:-kubectl-ate}"
REGISTRY="${REGISTRY:-localhost:5001}"
ATESPACE="${ATESPACE:-pi-agents}"
ACTOR_TEMPLATE="${ACTOR_TEMPLATE:-pi-actor}"
ACTOR="${ACTOR:-pi-actor-1}"
ROUTER_URL="${ROUTER_URL:-http://127.0.0.1:8000}"
IDLE_SECONDS="${IDLE_SECONDS:-15}"
WEB_PORT="${WEB_PORT:-8899}"
CONVERSATIONS="${CONVERSATIONS:-web/alpha,web/beta}"
PROVIDER="${PROVIDER:-mock}"
EGRESS_POLICY="${EGRESS_POLICY:-deploy/test/egress-policy.yaml}"
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

  echo "==> pushing to ${REGISTRY}"
  docker push "${REGISTRY}/pi-actor:dev"
  docker push "${REGISTRY}/pi-mock-llm:dev"

  ACTOR_IMAGE="${REGISTRY}/pi-actor:dev"
  MOCK_LLM_IMAGE="${REGISTRY}/pi-mock-llm:dev"
  # The worker image is the ateom binary matching the sandbox class, not the
  # atelet daemon. Reuse what an existing gVisor pool already runs, so this
  # script tracks the installed version instead of hard-coding a digest.
  WORKER_IMAGE="${WORKER_IMAGE:-}"
  if [[ -z "${WORKER_IMAGE}" ]]; then
    WORKER_IMAGE="$("${kube[@]}" get workerpools -A -o json 2>/dev/null | node -e '
      let body = "";
      process.stdin.on("data", (chunk) => (body += chunk)).on("end", () => {
        const pools = JSON.parse(body).items ?? [];
        const gvisor = pools.find((pool) =>
          (pool.spec?.sandboxClasses ?? []).some((entry) => entry.name === "gvisor"),
        );
        process.stdout.write(gvisor?.spec?.workerImage ?? "");
      });')"
  fi
  if [[ -z "${WORKER_IMAGE}" ]]; then
    echo "no existing gVisor WorkerPool to copy workerImage from; set WORKER_IMAGE" >&2
    exit 1
  fi

  echo "==> applying namespace and worker pool"
  WORKER_IMAGE="${WORKER_IMAGE}" MOCK_LLM_IMAGE="${MOCK_LLM_IMAGE}" \
    envsubst '${WORKER_IMAGE} ${MOCK_LLM_IMAGE}' < deploy/test/kind.yaml.tmpl | "${kube[@]}" apply -f -

  if [[ "${PROVIDER}" == "mock" ]]; then
    "${kube[@]}" -n "${ATESPACE}" rollout status deploy/mock-llm --timeout=180s
  fi
  "${kube[@]}" -n "${ATESPACE}" rollout status deploy/pi-workerpool --timeout=180s

  echo "==> creating the actor template"
  if [[ "${PROVIDER}" == "mock" ]]; then
    PI_PROVIDER=mock
    PI_MODEL=mock-model
    PI_PROVIDER_BASE_URL="http://mock-llm.${ATESPACE}.svc.cluster.local:8080/v1"
    PI_PROVIDER_API=openai-completions
  else
    PI_PROVIDER="${PI_PROVIDER:-${PROVIDER}}"
    [[ -n "${PI_MODEL:-}" ]] || { echo "PROVIDER=${PROVIDER} needs PI_MODEL" >&2; exit 1; }
    [[ -n "${PI_PROVIDER_BASE_URL:-}" ]] || { echo "PROVIDER=${PROVIDER} needs PI_PROVIDER_BASE_URL" >&2; exit 1; }
    [[ -n "${PI_PROVIDER_API:-}" ]] || { echo "PROVIDER=${PROVIDER} needs PI_PROVIDER_API" >&2; exit 1; }
  fi
  sed -e "s#\${ACTOR_IMAGE}#${ACTOR_IMAGE}#" \
      -e "s#\${PROVIDER}#${PI_PROVIDER}#" \
      -e "s#\${MODEL_ID}#${PI_MODEL}#" \
      -e "s#\${BASE_URL}#${PI_PROVIDER_BASE_URL}#" \
      -e "s#\${API}#${PI_PROVIDER_API}#" \
      -e "s#\${CONTEXT_WINDOW}#${PI_MODEL_CONTEXT_WINDOW:-}#" \
      -e "s#\${MAX_TOKENS}#${PI_MODEL_MAX_TOKENS:-}#" \
      -e "s#\${SANDBOX_CLASS}#SANDBOX_CLASS_GVISOR#" \
      -e "s#\${SANDBOX_CONFIG}#gvisor-default#" \
      deploy/test/actor-template.json.tmpl > bin/actor-template.json
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

  echo "==> creating actor ${ATESPACE}/${ACTOR}"
  "${KUBECTL_ATE}" ${KUBE_CONTEXT:+--context "${KUBE_CONTEXT}"} create actor "${ACTOR}" -a "${ATESPACE}" --template "${ACTOR_TEMPLATE}"
fi

if [[ "${ONLY}" != "deploy" ]]; then
  echo "==> port-forwarding the router on 8000"
  "${kube[@]}" -n ate-system port-forward svc/atenet-router 8000:80 >/tmp/pi-e2e-portforward.log 2>&1 &
  forward=$!
  trap 'kill ${forward} 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:8000/" -H "ate-target-actor: ${ATESPACE}/${ACTOR}" 2>/dev/null; then break; fi
    sleep 1
  done

  echo "==> running the clustered e2e"
  PI_ATESPACE="${ATESPACE}" PI_ACTOR="${ACTOR}" PI_ROUTER_URL="${ROUTER_URL}" \
    KUBECTL_ATE="${KUBECTL_ATE}" KUBE_CONTEXT="${KUBE_CONTEXT}" \
    node hack/e2e-kind.mjs

  echo "==> running the web channel e2e"
  PI_ATESPACE="${ATESPACE}" PI_ROUTER_URL="${ROUTER_URL}" \
    KUBECTL_ATE="${KUBECTL_ATE}" KUBE_CONTEXT="${KUBE_CONTEXT}" \
    PI_IDLE_SECONDS="${IDLE_SECONDS}" PI_WEB_PORT="${WEB_PORT}" \
    PI_CONVERSATIONS="${CONVERSATIONS}" \
    node hack/e2e-web.mjs
fi
