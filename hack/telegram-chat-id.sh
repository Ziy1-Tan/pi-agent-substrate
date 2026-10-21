#!/usr/bin/env bash
#
# Resolve the chat id for a Telegram bot, then optionally write the local
# gateway environment file.
#
#   ./hack/telegram-chat-id.sh
#   PI_TELEGRAM_TOKEN=123:abc ./hack/telegram-chat-id.sh
#
# Send any message to the bot after the script starts. Telegram does not expose
# a list of chats a bot has seen; getUpdates is the supported discovery path.
set -o errexit -o nounset -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 1; }; }
need curl
need jq

TOKEN="${PI_TELEGRAM_TOKEN:-}"
if [[ -z "${TOKEN}" ]]; then
  if [[ -f deploy/local/gateway.env ]]; then
    set -a
    # shellcheck disable=SC1091
    . deploy/local/gateway.env
    set +a
    TOKEN="${PI_TELEGRAM_TOKEN:-}"
  fi
fi
if [[ -z "${TOKEN}" ]]; then
  read -r -p "Telegram bot token: " TOKEN
fi
: "${TOKEN:?Telegram bot token is required}"

API_BASE="${PI_TELEGRAM_API:-https://api.telegram.org}"
api="${API_BASE}/bot${TOKEN}"

me="$(curl -fsS -m 15 "${api}/getMe")" || {
  echo "the token is invalid or Telegram is unreachable" >&2
  exit 1
}
username="$(jq -r '.result.username // .result.first_name // "unknown"' <<<"${me}")"
echo "bot: @${username}"

if command -v kubectl >/dev/null; then
  replicas="$(kubectl --context "${KUBE_CONTEXT:-kind-kind}" -n "${ATESPACE:-pi-agents}" \
    get deployment pi-gateway -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)"
  if [[ "${replicas:-0}" -gt 0 ]]; then
    echo "a gateway is already polling this token; stop it before discovering a chat id" >&2
    echo "  kubectl -n ${ATESPACE:-pi-agents} scale deploy pi-gateway --replicas=0" >&2
    exit 1
  fi
fi

# Drain old updates before waiting for a new message, so the id belongs to the
# chat the user is about to test rather than an unrelated earlier update.
offset="$(curl -fsS -m 15 "${api}/getUpdates?timeout=0" |
  jq -r 'if (.result | length) > 0 then (.result[-1].update_id + 1) else 0 end')"

echo "send a message to @${username} now (waiting up to 120s)..."
deadline=$((SECONDS + 120))
chat_id=""
while (( SECONDS < deadline )); do
  response="$(curl -fsS -m 40 "${api}/getUpdates?offset=${offset}&timeout=30&allowed_updates=%5B%22message%22%5D")" || {
    sleep 1
    continue
  }
  updates="$(jq -c '.result // []' <<<"${response}")"
  count="$(jq 'length' <<<"${updates}")"
  if [[ "${count}" -gt 0 ]]; then
    offset="$(jq '.[-1].update_id + 1' <<<"${updates}")"
    chat_id="$(jq -r '
      [.[] | .message.chat.id | select(. != null)] | first // empty
    ' <<<"${updates}")"
    if [[ -n "${chat_id}" ]]; then
      break
    fi
  fi
done

if [[ -z "${chat_id}" ]]; then
  echo "no Telegram message arrived within 120s" >&2
  exit 1
fi

echo "PI_TELEGRAM_CHATS=${chat_id}"

if [[ "${1:-}" == "--write" ]]; then
  env_file="${PI_GATEWAY_ENV_FILE:-deploy/local/gateway.env}"
  umask 077
  {
    printf 'PI_TELEGRAM_TOKEN=%s\n' "${TOKEN}"
    printf 'PI_TELEGRAM_CHATS=%s\n' "${chat_id}"
  } > "${env_file}"
  echo "wrote ${env_file}"
fi
