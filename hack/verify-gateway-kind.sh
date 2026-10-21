#!/usr/bin/env bash
# Verifies the clustered gateway against a live kind deployment.
set -o errexit -o nounset -o pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-kind-kind}"
ATESPACE="${ATESPACE:-pi-agents}"
TELEGRAM_CHAT="${TELEGRAM_CHAT:?TELEGRAM_CHAT is required}"
kube=(kubectl --context "${KUBE_CONTEXT}" -n "${ATESPACE}")

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need jq

"${kube[@]}" rollout status deploy/pi-gateway --timeout=120s
"${kube[@]}" get pvc pi-gateway-data >/dev/null
"${kube[@]}" exec deploy/pi-gateway -- /usr/local/bin/kubectl-ate get actors -a "${ATESPACE}" >/dev/null
"${kube[@]}" exec deploy/pi-gateway -- curl -fsS http://127.0.0.1:8788/metrics >/dev/null

# Exercise the actor and channel path without pretending to be a Telegram user.
body="$(jq -nc --arg conversation "telegram/${TELEGRAM_CHAT}" \
  --arg messageId "cluster-gateway-verify-$(date +%s)" \
  '{conversation: $conversation, text: "请只回复：cluster gateway ok",
    messageId: $messageId,
    userId: "verify", userName: "verify"}')"
"${kube[@]}" exec deploy/pi-gateway -- curl -fsS --max-time 600 \
  http://127.0.0.1:8788/messages -H 'content-type: application/json' -d "${body}" |
  jq -e '.text == "cluster gateway ok"' >/dev/null

echo "gateway deployment verification passed"
