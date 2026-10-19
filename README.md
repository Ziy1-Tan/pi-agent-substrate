# pi-agent-substrate

**Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate).**

A message arrives, an agent wakes up, answers in a stream, and goes back to
sleep by itself. The chat connection stays up while the thinking happens in a
sandbox that costs nothing when idle.

```text
Telegram / curl / browser
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

- Three entry points over one conversation model: Telegram, `curl`, and a
  browser page address the same `account/channel` id.
- Streaming replies: Telegram edits one message, the browser gets preview
  frames, `curl` gets the settled reply in the response body.
- Automatic suspend and resume with the session and `/workspace` intact.
- One actor per conversation, so failures and context stay isolated.
- Attachments land in `/workspace/incoming` and appear in the prompt.
- Reconnect replay with a cursor: exactly the missed frames, no gaps.
- Provider failures surface as errors, not empty replies.

## Quickstart

### Prerequisites

Node.js 22 or newer, and a kind cluster with Agent Substrate installed
(`hack/install-ate-kind.sh --deploy-ate-system --credential-provider='{"name":"k8s.io"}'`),
a local registry on `localhost:5001`, and `kubectl-ate` on `PATH`.

### Run it

```sh
cp deploy/local/provider.env.example deploy/local/provider.env
$EDITOR deploy/local/provider.env     # provider, model, endpoint, API, key
./hack/deploy-local.sh                # real model
./hack/e2e-kind.sh                    # mock model
```

The first builds the actor image, creates a template from the values in
`provider.env`, writes the API key to a Secret, and prints the gateway
command. The bridge builds Pi's model catalog at startup. The second needs no
key or network.

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

Telegram:

```sh
PI_TELEGRAM_TOKEN=123:abc PI_TELEGRAM_CHATS=42 \
  node dist/src/bin/web.js
```

Each chat becomes `telegram/<chat id>`. `PI_TELEGRAM_CHATS` restricts who gets
an answer; empty answers any chat.

curl:

```sh
curl -s localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","messageId":"...","text":"..."}
```

Browser: open `http://127.0.0.1:8788/`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PI_ACTOR_URL` | `ws://127.0.0.1:8000` | Router endpoint, usually a port-forward |
| `PI_ACTOR_TEMPLATE` | `pi-actor` | Template used to create a missing actor |
| `PI_EGRESS_POLICY` | `deploy/test/egress-policy.yaml` | Applied to each new actor |
| `PI_IDLE_SECONDS` | `60` | Idle window before suspend; `0` disables it |
| `PI_CONVERSATIONS` | `local/chat` | Conversations the page offers |
| `PI_WEB_PORT` | `8788` | HTTP port |
| `PI_WEB_HOST` | `127.0.0.1` | Listen address; the page has no authentication |
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
