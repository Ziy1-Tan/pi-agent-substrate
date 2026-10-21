# pi-agent-substrate

**Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate).**

A message arrives, an agent wakes up, answers in a stream, and goes back to
sleep by itself. The chat connection stays up while the thinking happens in a
sandbox that costs nothing when idle.

This repository runs Pi. It is not a drop-in replacement for an OpenClaw
deployment. The always-on/gateway and suspendable-actor split is the same; the
agent runtime and configuration are Pi's.

```text
Telegram / curl
        │
        ▼
   gateway (always on)          ← chat presence, conversation log, idle policy
        │
        ▼
   Substrate actor (sleeps)     ← pi --mode rpc, /workspace, session files
        │
        ▼
   model provider
```

## Why

An agent is idle most of the time. A resident process wastes the machine;
killing it loses the conversation. Here each conversation maps to its own
suspendable actor: the gateway stays up to hold the chat connection, and the
actor sleeps between turns with its files and Pi session intact. Sending a
message is the only thing that wakes it.

## What you get

- Two entry points over one conversation model: Telegram and `curl` address
  the same `account/channel` id.
- Streaming replies: Telegram edits one message in place; `curl` gets the
  settled reply in the response body.
- Automatic suspend and resume with the session and `/workspace` intact.
- One actor per conversation, so failures and context stay isolated.
- Attachments land in `/workspace/incoming` and appear in the prompt.
- Provider failures surface as errors, not empty replies.

## Quickstart

### Prerequisites

Node.js 22 or newer, Docker, `kubectl`, a kind cluster, a local registry on
`localhost:5001`, and `kubectl-ate` on `PATH`.

Install Substrate from an upstream checkout before using this repository:

```sh
cd /path/to/substrate
hack/create-kind-cluster.sh
hack/install-ate-kind.sh --deploy-ate-system \
  --credential-provider='{"name":"k8s.io"}'
```

Set `KUBECTL_CONTEXT` for the upstream installer if the kind context is not
`kind-kind`. The scripts in this repository use `KUBE_CONTEXT`.

### Mock smoke test

Use this first to verify the cluster, worker pool, actor bridge, and local
gateway process without a provider key:

```sh
./hack/e2e-kind.sh
```

This builds the actor and mock model images, applies the kind namespace and
WorkerPool, creates a template, and runs the clustered actor and gateway tests.
It needs no network access to a model provider. It does not deploy the
always-on `pi-gateway` Deployment.

### Real provider + Telegram

```sh
cp deploy/local/provider.env.example deploy/local/provider.env
$EDITOR deploy/local/provider.env     # provider, model, endpoint, API, key

# kind follows the microvm default only when the node advertises ate.dev/kvm.
# For the gVisor WorkerPool created by e2e-kind.sh, use:
SANDBOX_CLASS=SANDBOX_CLASS_GVISOR SANDBOX_CONFIG=gvisor-default \
  ./hack/deploy-local.sh

PI_TELEGRAM_TOKEN=123:abc ./hack/deploy-gateway-kind.sh
```

`deploy-local.sh` builds the actor image, creates a template from the values in
`provider.env`, writes the API key to a Secret, and grants the atespace access.
`deploy-gateway-kind.sh` then deploys the one-replica gateway and discovers the
Telegram chat id on first use.

### Provider settings

A single model call needs five values. They live in
`deploy/local/provider.env`, which is gitignored:

| Variable | Meaning |
|---|---|
| `PI_PROVIDER` | Provider id Pi passes as `--provider` |
| `PI_MODEL` | Model id Pi passes as `--model` |
| `PI_PROVIDER_BASE_URL` | Endpoint, e.g. `https://api.example.com/v1` |
| `PI_PROVIDER_API` | Wire protocol: `openai-completions` or `anthropic-messages` |
| `PI_PROVIDER_API_KEY` | Key, written to a Kubernetes Secret and injected on egress |

Pi defaults `contextWindow` to 128000 and `maxTokens` to 16384. Set
`PI_MODEL_CONTEXT_WINDOW` or `PI_MODEL_MAX_TOKENS` only when the model differs.

The endpoint and API go into the actor template. The key does not: the actor
sends a placeholder header, which the EgressPolicy replaces with the value
from the Secret. The header follows the wire API: `Authorization: Bearer` for
OpenAI-compatible endpoints, `x-api-key` for Anthropic-compatible ones.

### Talk to it

Deploy the gateway into kind with the Telegram bot token:

```sh
PI_TELEGRAM_TOKEN=123:abc ./hack/deploy-gateway-kind.sh
```

On the first run the script waits for you to send the bot any message, discovers
the chat id, writes `deploy/local/gateway.env`, then builds and deploys the
gateway. Later runs reuse that file. Set `STOP_LOCAL_GATEWAY=1` when replacing
a workstation poller.

The gateway owns the Telegram long poll and conversation log; the actor remains
a suspendable Substrate workload.

The Deployment consists of a ServiceAccount, a PVC for the conversation log, a
Secret for the bot token, and RBAC for the shared `ate-client` identity. The
PVC is what keeps the conversation log across pod restarts.

The Pod reads the router directly at
`ws://atenet-router.ate-system.svc:80`; no `kubectl port-forward` is needed.
Conversation logs live on the `pi-gateway-data` PVC. To check the deployment:

```sh
kubectl -n pi-agents get deploy pi-gateway
kubectl -n pi-agents logs deploy/pi-gateway -f
kubectl -n pi-agents exec deploy/pi-gateway -- \
  curl -sS http://127.0.0.1:8788/metrics
```

Verify the deployment with a real turn:

```sh
set -a
. deploy/local/gateway.env
set +a
TELEGRAM_CHAT="${PI_TELEGRAM_CHATS}" ./hack/verify-gateway-kind.sh
```

For a local gateway process instead of a Deployment, see
[docs/dev/local-gateway.md](docs/dev/local-gateway.md).

The gateway also accepts a direct HTTP request:

```sh
curl -s localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","messageId":"...","text":"..."}
```

### Troubleshooting

First separate the layers:

- No Telegram message in the conversation log: the gateway is not polling, or
  the chat is filtered by `PI_TELEGRAM_CHATS`.
- `inbound` but no `job_dispatched`: the gateway queue is not moving.
- `job_dispatched` but no `outbound`: check the actor, router, and provider.
- `job_failed`: read the `error` field in the conversation log.

Start with:

```sh
kubectl -n pi-agents logs deploy/pi-gateway --tail=200
kubectl -n pi-agents exec deploy/pi-gateway -- \
  /usr/local/bin/kubectl-ate get actors -a pi-agents
```

The conversation log lives under
`/data/accounts/telegram/channels/<chat-id>/channel.jsonl` in the gateway Pod.
For a `503` after `job_dispatched`, inspect the router and worker logs before
changing the gateway deployment.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_ACTOR_URL` | `ws://127.0.0.1:8000` | Router endpoint, usually a port-forward |
| `PI_ACTOR_TEMPLATE` | `pi-actor` | Template used to create a missing actor |
| `PI_EGRESS_POLICY` | `deploy/test/egress-policy.yaml` | Applied to each new actor |
| `PI_IDLE_SECONDS` | `60` | Idle window before suspend; `0` disables it |
| `PI_HTTP_PORT` | `8788` | HTTP port |
| `PI_HTTP_HOST` | `127.0.0.1` | Listen address |
| `PI_GATEWAY_DATA_DIR` | `/tmp/pi-gateway` | Conversation logs and workspace |
| `PI_TELEGRAM_TOKEN` | unset | Enables the Telegram entry point |
| `PI_TELEGRAM_CHATS` | any | Comma-separated chat ids to answer |
| `KUBECTL_ATE` / `KUBE_CONTEXT` | from `PATH` | Control plane access |

## How it works

The gateway and the actor are separate processes that talk over a WebSocket.
The actor runs a bridge exposing `pi --mode rpc` as JSONL records; the gateway
owns the conversation log, the queue, and the idle timer.

```text
IDLE ──prompt──> ACTIVE ──settled──> GRACE ──idle──> SUSPENDING ──> SUSPENDED
```

A suspend is never issued mid-turn, because substrate cancels in-flight work
rather than draining it, and nothing reconnects on its own, because connecting
is what wakes an actor.

Protocol, state machines, and the reasoning behind each choice are in
[docs/architecture.md](docs/architecture.md).

## Development

```sh
npm install
npm test
```
