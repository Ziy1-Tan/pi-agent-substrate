# Local Gateway

Run the gateway on the workstation when developing the channel or conversation
logic. Do not run it while the `pi-gateway` Deployment is active: both processes
poll the same bot and consume each other's Telegram updates.

## Setup

`hack/deploy-local.sh` creates the actor template, egress policy, and provider
secret, then prints the command for this checkout:

```sh
./hack/deploy-local.sh
```

Use the `PI_ACTOR_TEMPLATE` and egress policy paths printed by that command.
The default template is `pi-local`; the example cluster deployment uses
`pi-local2`.

## Resolve the Telegram chat

The first run can discover the chat id. Send the bot any message while the
helper is waiting:

```sh
PI_TELEGRAM_TOKEN=123:abc ./hack/telegram-chat-id.sh --write
```

This writes `deploy/local/gateway.env`. The file contains the bot token and
`PI_TELEGRAM_CHATS`; keep it out of version control.

## Run

The local gateway needs the router port-forward:

```sh
kubectl -n ate-system port-forward svc/atenet-router 8000:80 &

set -a
. deploy/local/gateway.env
set +a

KUBECTL_ATE="$(command -v kubectl-ate)" \
KUBE_CONTEXT=kind-kind \
PI_ACTOR_URL=ws://127.0.0.1:8000 \
PI_ACTOR_TEMPLATE=pi-local \
PI_EGRESS_POLICY=bin/egress-policy.yaml \
  node dist/src/host/main.js
```

Set `PI_ACTOR_TEMPLATE` to the template created by `hack/deploy-local.sh`
(default `pi-local`).
`PI_TELEGRAM_CHATS` limits which chats receive answers; an empty value accepts
any chat.

The gateway logs polling and lifecycle events to stderr. Conversation records
are stored under `PI_GATEWAY_DATA_DIR`, which defaults to `/tmp/pi-gateway`.
