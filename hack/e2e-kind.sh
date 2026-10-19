#!/usr/bin/env bash
#
# Build, push, and deploy the M2 actor + mock LLM onto a kind cluster that
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
#   PROVIDER          "mock" (default) or "tokenhub"; a real provider needs
#                     PI_MODELS_JSON and an egress policy that reaches it
#   PI_MODELS_JSON    models.json for a real provider, inlined into the template
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
PI_MODELS_JSON="${PI_MODELS_JSON:-}"
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
    MODELS_JSON="$(node -e 'console.log(JSON.stringify({providers:{mock:{baseUrl:"http://mock-llm.'"${ATESPACE}"'.svc.cluster.local:8080/v1",api:"openai-completions",apiKey:"mock",compat:{supportsDeveloperRole:false,supportsReasoningEffort:false,supportsUsageInStreaming:false},models:[{id:"mock-model",name:"mock",contextWindow:100000,maxTokens:4096}]}}}))')"
    MODEL_ID="mock-model"
  else
    # A real provider's catalog is too large to paste into this script, so the
    # caller supplies the same models.json Pi reads on the workstation.
    if [[ -z "${PI_MODELS_JSON}" ]]; then
      echo "PROVIDER=${PROVIDER} needs PI_MODELS_JSON" >&2
      exit 1
    fi
    MODELS_JSON="$(cat "${PI_MODELS_JSON}")"
    MODEL_ID="${PI_MODEL:-deepseek-v4-pro}"
  fi
  sed -e "s#\${ACTOR_IMAGE}#${ACTOR_IMAGE}#" \
      -e "s#\${MODELS_JSON}#${MODELS_JSON}#" \
      -e "s#\${PROVIDER}#${PROVIDER}#" \
      -e "s#\${MODEL_ID}#${MODEL_ID}#" \
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
