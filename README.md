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

An agent is idle most of the time. Keeping a process resident for the few
minutes a day you talk to it wastes the machine; killing it loses the
conversation. This project maps each conversation to its own suspendable
Substrate actor: the gateway stays up because that is what holds the chat
connection, and the actor sleeps between turns with its memory, files, and Pi
session intact.

Sending a message is the only thing that wakes an actor. There is no resume
command and no warm-up step.

## What you get

- **Three entry points, one conversation model.** Telegram, `curl`, and a
  browser page all address the same `account/channel` id, so a conversation
  started from a phone continues from a terminal.
- **Streaming replies.** Telegram gets edits of one message; the browser gets
  preview frames; `curl` gets the settled reply in the response body.
- **Automatic suspend and resume.** A turn settles, an idle window passes, the
  actor is snapshotted and releases its worker. The next message resumes it
  with the session and `/workspace` intact.
- **One actor per conversation.** No shared context, no cross-talk, and one
  conversation failing does not take the others down.
- **Attachments.** Images and files land in `/workspace/incoming` and appear in
  the prompt.
- **Reconnect replay.** A browser that drops mid-stream resumes with a cursor
  and receives exactly the frames it missed.
- **Visible failures.** A provider error is delivered as an error, not as an
  empty reply.

## Quickstart

### Prerequisites

Node.js 22 or newer, and a kind cluster with Agent Substrate installed
(`hack/install-ate-kind.sh --deploy-ate-system --credential-provider='{"name":"k8s.io"}'`),
a local registry on `localhost:5001`, and `kubectl-ate` on `PATH`.

### Run it against a real model

```sh
PROVIDER=tokenhub PI_MODEL=deepseek-v4-pro ./hack/deploy-local.sh
```

The script builds the actor image, creates a template from one provider in
`~/.pi/agent/models.json`, writes the API key to a Kubernetes Secret, and
prints the command to start the gateway. Paste the command, fill in your bot
token, and send the bot a message.

The key never enters the actor: the template carries a placeholder and the
egress gateway swaps in the real value on the way out.

### Run it against a mock model

No API key, no provider, no network:

```sh
./hack/e2e-kind.sh
```

This deploys a mock OpenAI-compatible server, runs the clustered end-to-end
suite, and exercises suspend, resume, streaming, replay, and metrics.

### Talk to it

**Telegram**

```sh
PI_TELEGRAM_TOKEN=123:abc PI_TELEGRAM_CHATS=42 \
  node dist/src/bin/web.js
```

Every chat becomes its own conversation (`telegram/<chat id>`), so a group and
a DM never share an actor. `PI_TELEGRAM_CHATS` restricts who gets an answer;
leaving it empty answers any chat. The bot skips the update backlog on startup,
so restarting it does not answer messages from an outage.

**curl**

```sh
curl -s localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","messageId":"...","text":"..."}
```

Attachments are base64 in an `attachments` array. A rejected turn is a non-2xx
status with `{"error": "..."}`.

**Browser**

Open `http://127.0.0.1:8788/`. The picker lists `PI_CONVERSATIONS` and any
conversation opened by another entry point; an unlisted id opens on first use.
The page streams replies, shows the actor's lifecycle state, and reconnects
without gaps.

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

The gateway and the actor are separate processes that only talk over a
WebSocket. The actor runs a bridge that exposes `pi --mode rpc` as JSONL
records; the gateway owns the conversation log, the delivery queue, and the
idle timer.

```text
IDLE ──prompt──> ACTIVE ──settled──> GRACE ──idle──> SUSPENDING ──> SUSPENDED
                                  ▲       │
                                  └───────┘ prompt cancels the timer
```

Two rules matter more than the rest. A suspend is never issued while a turn is
in flight, because substrate cancels in-flight work rather than draining it.
And nothing reconnects on its own: connecting wakes an actor, so an automatic
reconnect after a suspend would immediately undo it.

Design details, the delivery state machine, the protocol, and the reasoning
behind each choice are in [docs/architecture.md](docs/architecture.md).

## Development

```sh
npm install
npm test
```

`npm test` typechecks, builds, and runs the acceptance tests. They start real
`pi --mode rpc` children against a local mock provider, so no API key or
cluster is needed. `PI_E2E_LOG=1` prints actor and transport logs.

| Behaviour | Where it is verified |
|---|---|
| A channel turn is recorded and delivered exactly once | `test/gateway.test.ts` |
| Unfinished deliveries recover after a gateway restart | `test/gateway.test.ts` |
| The bridge streams a real `pi` reply over a WebSocket | `test/bridge.test.ts` |
| A message reaches `pi` through the gateway and streams back | `test/bridge-e2e.test.ts` |
| An idle actor suspends, and the next message resumes it | `test/idle-lifecycle.test.ts`, `hack/e2e-web.mjs` |
| A browser turn streams, and a reconnect replays only what was missed | `test/web-server.test.ts`, `hack/e2e-web.mjs` |
| `curl` gets the settled reply in the response | `test/entry-points.test.ts`, `hack/e2e-web.mjs` |
| A Telegram chat becomes a conversation and replies in place | `test/telegram.test.ts`, `test/entry-points.test.ts` |
| Two conversations map to two actors and two logs | `test/manager.test.ts`, `hack/e2e-web.mjs` |
| An upload survives the trip to `/workspace/incoming` | `test/uploads.test.ts` |
| A provider failure reaches the user, and the actor still idles | `test/bridge.test.ts`, `test/gateway-lifecycle.test.ts` |

Traps that cost real debugging time — egress rules, the trust bundle,
credential injection, template immutability, image digests — are in
[AGENTS.md](AGENTS.md). Read it before changing deployment manifests.

## Layout

```
src/gateway/       Gateway state machine, conversation layout, multi-conversation manager
src/lifecycle/     Idle-suspend state machine and the kubectl-ate control
src/channel/       Browser, curl, and Telegram channels; HTTP/WebSocket server; replay ring
src/backend/pi.ts  Backend over the actor bridge (idempotent per request id)
src/bridge/        Actor-side bridge: WebSocket <-> `pi --mode rpc`
src/protocol/      LF framing and the pinned RPC subset
src/transport/     WebSocket actor transport
src/metrics.ts     Counters and p50/p95 timings for the last 200 turns
src/bin/web.ts     Gateway entry point
images/actor/      Actor image: Node + pinned Pi + bridge
images/mock-llm/   OpenAI-compatible mock for the clustered e2e
deploy/            ActorTemplate, WorkerPool, egress policies
hack/              Deployment and clustered end-to-end scripts
test/              Acceptance tests, named for the behaviour they cover
third_party/       Vendored pi-chat runtime, see its README
```

## Status

Pre-1.0. Pi is pinned to the version in `package.json` (`piVersion`) and the
RPC subset the gateway reads is declared in `src/protocol/`. Upgrading Pi means
running the clustered smoke first.

Discord is not implemented. The channel interface is there; only Telegram,
`curl`, and the browser are wired up.

## License and provenance

Apache-2.0. The conversation runtime is a vendored pi-chat subset; see
[third_party/pi-chat/README.md](third_party/pi-chat/README.md) for the source
commit, copied files, and every modification. License texts are in `LICENSE`
and `THIRD_PARTY_NOTICES.md`.

This project is not affiliated with Pi, OpenClaw, Google, or Agent Substrate.
