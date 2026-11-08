# pi-agent-substrate

**Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate).**

A message arrives, an agent wakes up, answers in a stream, and goes back to
sleep by itself. The chat connection stays up while the thinking happens in a
sandbox that costs nothing when idle.

```text
curl POST /messages
        │
        ▼
   gateway (always on)          ← HTTP entry, idle policy
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
suspendable actor: the gateway stays up to answer HTTP requests, and the
actor sleeps between turns with its files and Pi session intact. Sending a
message is the only thing that wakes it.

## What you get

- One HTTP entry point: `POST /messages` with a conversation id and text, and
  the settled reply in the response.
- Automatic suspend and resume with the session and `/workspace` intact.
- One actor per conversation, so failures and context stay isolated.
- Provider failures surface as errors, not empty replies.

## Quickstart

### Prerequisites

Node.js 22 or newer, a kind cluster with Agent Substrate v1.0.0 installed,
a local registry on `localhost:5001`, and `kubectl-ate` v1.0.0 on `PATH`.

Create a kind cluster and install Substrate from its v1.0.0 checkout:

```sh
kind create cluster --name pi-v1
cd <substrate v1.0.0 checkout>
export ATE_INSTALL_KIND=true
go run ./cmd/ate-setup deploy ate-system \
  --kind --context kind-pi-v1 \
  --credential-provider='{"name":"k8s.io"}' \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/pi-gateway/sa/pi-gateway
```

The ID lets the in-cluster gateway reach actors through atenet-router.
`sandbox.microvm` needs a node that advertises `ate.dev/kvm`. On a host
without nested virtualization, add `--sandbox-classes=gvisor`.

### Run it

```sh
cp deploy/local/provider.env.example deploy/local/provider.env
$EDITOR deploy/local/provider.env     # provider, model, endpoint, API, key
KUBE_CONTEXT=kind-pi-v1 ./scripts/deploy-local.sh                # real model
KUBE_CONTEXT=kind-pi-v1 SANDBOX_CLASS_NAME=microvm ./scripts/e2e/kind.sh   # mock model
```

`deploy-local.sh` builds the actor and gateway images, creates the atespace,
the WorkerPool, the actor template, the provider Secret, the egress policy,
and the in-cluster gateway. It prints the port-forward command for the
gateway's HTTP API. The bridge builds Pi's model catalog at startup. The e2e
needs no key or network.

A microVM pool needs a worker image that matches the installed Substrate. A
dev install built from source may leave an older image under the local
registry's `latest` tag; set `WORKER_IMAGE` to the release image, for example
`localhost:5001/ateworker-microvm:v1.0.0`.

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

The deployed gateway answers on its Service. Forward the port and use the HTTP
entry point:

```sh
kubectl -n pi-gateway port-forward svc/pi-gateway 8788:8788 &
curl -s localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","text":"..."}
```

`GET /metrics` returns counters for turns, suspends, and resumed turns.

`deploy-local.sh` is the supported path. The gateway always reaches actors
through atenet-router and needs the client certificate that only the
in-cluster pod identity provides.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_ACTOR_URL` | required | Router WebSocket, `wss://` in the cluster |
| `PI_ROUTER_CA` | unset | CA bundle for a `wss` router |
| `PI_ROUTER_CERT` / `PI_ROUTER_KEY` | unset | Client credential for the router's mTLS ingress; may be the same projected bundle |
| `PI_ATESPACE` | `pi-agents` | Atespace that holds the actors |
| `PI_ACTOR_TEMPLATE` | `pi-actor` | Template used to create a missing actor |
| `PI_EGRESS_POLICY` | `deploy/e2e/egress-policy.yaml` | Applied to each new actor |
| `PI_IDLE_SECONDS` | `60` | Idle window before suspend; `0` disables it |

## How it works

The gateway and the actor are separate processes that talk over a WebSocket.
The actor runs a bridge exposing `pi --mode rpc` as JSONL records; the gateway
relays one turn per request and owns the idle timer.

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

The bridge tests start the real `pi` binary. They look for it next to the Node
executable and fall back to `PI_BIN`, so install the version in
`package.json`'s `piVersion` in that location, or point `PI_BIN` at it. A
newer global `pi` speaks a different RPC dialect and the tests hang.
