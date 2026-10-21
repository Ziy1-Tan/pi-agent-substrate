# pi-agent-substrate

**Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate).**

A message arrives, an agent wakes up, answers in a stream, and goes back to
sleep. The chat connection stays up while its sandbox sleeps: the WorkerPool
worker is released, and snapshots and storage remain.

This repository runs Pi on Agent Substrate. A resident gateway keeps the chat
connection and drives a suspendable actor over RPC. Telegram and curl are the
entry points; a template fixes one provider and model.

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
killing it loses the conversation. Here each conversation has its own
suspendable actor. The gateway holds the chat connection while the actor sleeps.
The actor keeps its files and Pi session, and only a message wakes it.

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

This project assumes Agent Substrate is already installed. See the
[Substrate quickstart](https://github.com/agent-substrate/substrate#quickstart-development)
if it is not.

Check the cluster and local tools:

```sh
kubectl config current-context
kubectl -n ate-system get svc atenet-router
kubectl get workerpools -A
kubectl-ate get atespace pi-agents
node --version && docker version --format '{{.Server.Version}}' &&
kubectl version --client && kubectl-ate --version &&
envsubst --version | head -1 && jq --version && curl --version | head -1
```

Set `KUBE_CONTEXT` for a non-default cluster. The smoke test needs a gVisor
WorkerPool; real deployments also need one in `pi-agents` with `workload: pi`.
See [deployment notes](docs/deployment.md) if a check fails.

Install this repository's dependencies:

```sh
cd /path/to/pi-agent-substrate
npm install
```

### Mock smoke test

Use this first to verify the cluster, worker pool, actor bridge, and local
gateway process without a provider key:

```sh
./hack/e2e-kind.sh
```

This builds the actor and mock model images, applies the kind namespace,
replaces `pi-workerpool` and the `pi-e2e` template, and runs the clustered
actor and gateway tests. It needs no provider key, but the gVisor WorkerPool
must already exist so the script can find its worker image. This does not
deploy `pi-gateway`.

### Real provider + Telegram

```sh
cp deploy/local/provider.env.example deploy/local/provider.env
$EDITOR deploy/local/provider.env     # provider, model, endpoint, API, key

# The actor defaults to the microvm sandbox. For the existing gVisor pool, use:
# Keep ACTOR_TEMPLATE the same for both commands.
ACTOR_TEMPLATE=pi-local \
SANDBOX_CLASS=SANDBOX_CLASS_GVISOR SANDBOX_CONFIG=gvisor-default \
  ./hack/deploy-local.sh

STOP_LOCAL_GATEWAY=1 ACTOR_TEMPLATE=pi-local \
  PI_TELEGRAM_TOKEN=123:abc ./hack/deploy-gateway-kind.sh
```

`deploy-local.sh` builds the actor image, creates a template from the values in
`provider.env`, writes the API key to a Secret, and grants the atespace access.
`deploy-gateway-kind.sh` then deploys the one-replica gateway and discovers the
Telegram chat id on first use.

Only one process may consume updates for a Telegram token. Stop any other
gateway polling that bot before reusing it. `STOP_LOCAL_GATEWAY=1` removes this
repository's launchd job, but cannot stop processes outside the repository.
Test a new bot first if you need to keep the current deployment running.

### Provider settings

A single model call needs five values. They live in
`deploy/local/provider.env`, which is gitignored:

| Variable | Meaning |
|---|---|
| `PI_PROVIDER` | Provider id Pi passes as `--provider` |
| `PI_MODEL` | Model id Pi passes as `--model` |
| `PI_PROVIDER_BASE_URL` | Endpoint, e.g. `https://api.example.com/v1` |
| `PI_PROVIDER_API` | Wire protocol: `openai-completions`, `openai-responses`, or `anthropic-messages` |
| `PI_PROVIDER_API_KEY` | Key, written to a Kubernetes Secret and injected on egress |

Pi defaults `contextWindow` to 128000 and `maxTokens` to 16384. Set
`PI_MODEL_CONTEXT_WINDOW` or `PI_MODEL_MAX_TOKENS` only when the model differs.

The actor never receives the key. Egress replaces a placeholder header with
the Secret value, and egress is default-deny. Use `https:` for a TLS provider.
See [deployment notes](docs/deployment.md) for actor settings, credential
details, and snapshots.

### Talk to it

Deploy the gateway into the cluster with the Telegram bot token:

```sh
ACTOR_TEMPLATE=pi-local PI_TELEGRAM_TOKEN=123:abc \
  PI_GATEWAY_ENV_FILE=deploy/local/gateway.local.env \
  ./hack/deploy-gateway-kind.sh
```

On the first run the script waits for a message, discovers the chat id, writes
the env file, then builds and deploys the gateway. Later runs reuse that file.
Set `STOP_LOCAL_GATEWAY=1` when replacing a gateway process on the workstation.

The script loads the env file before reading `PI_TELEGRAM_TOKEN` and
`PI_TELEGRAM_CHATS`, so switching bots needs a new file. Pass the same
`ACTOR_TEMPLATE` on later runs.

The gateway owns the Telegram long poll and conversation log. Check the
deployment:

```sh
kubectl -n pi-agents get deploy pi-gateway
kubectl -n pi-agents logs deploy/pi-gateway -f
```

Verify the deployment with a real turn:

```sh
set -a
. deploy/local/gateway.local.env
set +a
TELEGRAM_CHAT="${PI_TELEGRAM_CHATS}" ./hack/verify-gateway-kind.sh
```

For an HTTP client on this workstation, forward the gateway Service:

```sh
kubectl -n pi-agents port-forward svc/pi-gateway 8788:8788
```

In another terminal, send a turn. The endpoint accepts only `POST`:

```sh
curl -sS -X POST localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","messageId":"...","text":"..."}
```

The HTTP server has no authentication. The Service is ClusterIP, so expose it
only through a trusted port-forward or an authenticated proxy.

For a local gateway process instead of a Deployment, see
[docs/dev/local-gateway.md](docs/dev/local-gateway.md). It needs
`PI_EGRESS_POLICY=bin/egress-policy.yaml` for a real provider; the default
policy only admits the mock model.

If a turn fails, see [troubleshooting](docs/troubleshooting.md).

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
| `PI_ATESPACE` | `pi-agents` | Atespace for actors and egress policies |

Actor settings are in [deployment notes](docs/deployment.md).

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
[docs/architecture.md](docs/architecture.md). Deployment internals and snapshot
behavior are in [deployment notes](docs/deployment.md).

## Development

```sh
npm test
```
