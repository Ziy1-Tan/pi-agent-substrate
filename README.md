# pi-agent-substrate

Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate):
a standalone gateway keeps the chat presence, while each conversation's
cognition runs in a suspendable Substrate actor.

The gateway is reachable two ways: `curl` against `POST /messages`, or a
Telegram bot that turns every chat into its own conversation. Both go through
the same conversation log, actor mapping, and idle lifecycle.

## Design

The design baseline, including implementation status, is
[docs/pi-always-on-agent.md](docs/pi-always-on-agent.md).

## What it does

The channel and conversation runtime from pi-chat runs as a standalone
gateway. A bridge exposes `pi --mode rpc` as a WebSocket inside a Substrate
actor, and a gateway backend drives it. The idle lifecycle suspends an actor
that has no turn in flight, and the router resumes it on the next message.
Each conversation gets its own actor, attachments, reconnect replay, and
latency metrics. The entry points are a browser page, `curl`, and Telegram;
an incoming message is the only thing that wakes an actor.

| Behaviour | Where it is verified |
|---|---|
| A test channel echoes a message, with streaming edits | `test/gateway.test.ts` |
| After a gateway restart, unfinished deliveries resume from `channel.jsonl` | `test/gateway.test.ts` |
| The bridge forwards prompts to real `pi` and streams its reply | `test/bridge.test.ts` |
| A channel message reaches `pi` through the gateway and streams back | `test/bridge-e2e.test.ts` |
| Manually suspending the actor resumes on the next message, session and files intact | `hack/e2e-kind.sh` |
| An idle actor suspends with no command, and the next message resumes it | `test/idle-lifecycle.test.ts`, `hack/e2e-web.mjs` |
| A browser turn streams, and a reconnect with `since` replays only what was missed | `test/web-server.test.ts`, `hack/e2e-web.mjs` |
| `curl` gets the settled reply in the HTTP response | `test/entry-points.test.ts`, `hack/e2e-web.mjs` |
| A Telegram chat becomes a conversation and the reply lands in the chat | `test/telegram.test.ts`, `test/entry-points.test.ts` |
| Two conversations map to two actors and two logs | `test/manager.test.ts`, `hack/e2e-web.mjs` |
| An upload survives the trip to `/workspace/incoming` | `test/uploads.test.ts` |
| A provider failure reaches the user as an error, and the actor still idles | `test/bridge.test.ts`, `test/gateway-lifecycle.test.ts` |

## Run

```sh
npm install
npm test
```

Requires Node.js 22 or newer, and a `pi` on `PATH` (or `PI_BIN` pointing at
one). The bridge tests start real `pi --mode rpc` children against a local mock
OpenAI-compatible server; no API key or cluster is needed.

`npm test` typechecks, builds, and runs the acceptance tests. `PI_E2E_LOG=1`
prints the actor and transport logs.

To drive a real actor from this machine, forward the router and start the
gateway.

```sh
kubectl -n ate-system port-forward svc/atenet-router 8000:80 &
PI_ACTOR_URL=ws://127.0.0.1:8000 PI_IDLE_SECONDS=60 \
  node dist/src/bin/web.js
```

`PI_IDLE_SECONDS=0` disables the idle lifecycle. `PI_ACTOR_TEMPLATE`,
`PI_EGRESS_POLICY`, and `KUBECTL_ATE` / `KUBE_CONTEXT` configure actor creation.
The page listens on `127.0.0.1` by default; set `PI_WEB_HOST=0.0.0.0` to reach it
from another device, and remember it has no authentication.

For a single-user setup that talks to a real provider, `hack/deploy-local.sh`
builds the actor image, creates a template from one provider in
`~/.pi/agent/models.json`, and prints the gateway command:

```sh
PROVIDER=tokenhub PI_MODEL=deepseek-v4-pro ./hack/deploy-local.sh
```

A template pins its image by the digest of the **platform** manifest, not the
multi-arch index: a node that pulls the index can end up with a partial image
whose container never starts, and the only symptom is a crash and a wakeup
probe timeout. The script resolves the child digest for you.

The API key is not put in the template. The script writes it to a Kubernetes
Secret (`pi-provider` in the atespace) and the template carries the placeholder
`egress-injected`; the egress policy replaces the `Authorization` header on the
way out, so the key never reaches the actor spec, its environment, or a
snapshot. That needs the Kubernetes Secrets credential provider, which a
standard install deploys, and the atespace-to-namespace grant the script adds
to `k8s-credential-provider-namespace-policy` when it is missing.

The gateway must be told the same template: `PI_ACTOR_TEMPLATE` defaults to
`pi-actor`, and the local template is `pi-local`. The command the script prints
already includes it.

## Layout

```
src/gateway/          Gateway state machine, conversation layout, multi-conversation manager
src/lifecycle/        Idle-suspend state machine and the kubectl-ate control
src/channel/          Browser, curl, and Telegram channels; HTTP/WebSocket server; replay ring
src/backend/pi.ts     Backend over the actor bridge (idempotent per request id)
src/bridge/           Actor-side bridge: WebSocket <-> `pi --mode rpc`
src/protocol/         LF framing and the pinned RPC subset
src/transport/        WebSocket actor transport with reconnect
src/metrics.ts        Counters and p50/p95 timings for the last 200 turns
src/bin/web.ts        Gateway entry point: page, /events, POST /messages, Telegram poll
images/actor/         Actor image: Node + pinned Pi + bridge
images/mock-llm/      OpenAI-compatible mock for the clustered e2e
deploy/test/          WorkerPool, ActorTemplate, mock LLM, egress policy
hack/e2e-kind.sh      Build, deploy, and run the clustered e2e
hack/e2e-web.mjs      Clustered curl + browser + suspend/resume e2e
test/                 Acceptance tests, named for the behaviour they cover
test/support/         Test channel and test conversation layout (test builds only)
third_party/pi-chat   Vendored conversation runtime, see its README
```

## Clustered end-to-end

Requires a kind cluster with Agent Substrate installed, a local registry on
`localhost:5001`, and `kubectl-ate` on `PATH` (or `KUBECTL_ATE`).

```sh
ONLY=deploy ./hack/e2e-kind.sh   # build, push, template, actor
./hack/e2e-kind.sh               # the same, then run the e2e
```

The e2e drives `test process -> atenet-router -> actor -> bridge -> pi -> mock
LLM`, then suspends the actor through the control plane and prompts again. It
asserts that the router resumes the actor, that a file written before the
suspend is still readable, and that the session continues rather than restarting.

`hack/e2e-kind.sh` also runs `hack/e2e-web.mjs`, which starts the gateway
against the same port-forward. It answers a `POST /messages` request with the
settled reply, streams a browser reply over `/events`, drops the socket
mid-stream and reconnects with `since` to prove replay starts right after the
last seen frame with no duplicate. It then waits out `IDLE_SECONDS` for an
automatic suspend, prompts again to prove the resume, opens a second
conversation to show it gets its own actor and log, and reads `/metrics` for
the turn and resume latencies.

## Entry points

One process, three ways in. A conversation id is `<account>/<channel>`, and
each one owns an actor and a `channel.jsonl`.

**curl**: one request, one turn, the settled reply in the response.

```sh
curl -s localhost:8788/messages \
  -H 'content-type: application/json' \
  -d '{"conversation":"local/chat","text":"say hello"}'
# {"conversation":"local/chat","messageId":"...","text":"..."}
```

Attachments are base64 in an `attachments` array, the same shape the browser
sends. A rejected turn is a non-2xx status with `{"error": "..."}`.

**Telegram**: set `PI_TELEGRAM_TOKEN` and the bot long-polls for messages. Each
chat maps to `telegram/<chat id>`, so a group and a DM never share an actor.
A reply streams as edits of one message, and a reply longer than 4096
characters arrives as several messages. `PI_TELEGRAM_CHATS` restricts which
chats are answered; an empty list answers any chat that messages the bot.
The bot skips the update backlog on startup, so a restart does not answer
messages from an outage.

```sh
PI_TELEGRAM_TOKEN=123:abc PI_TELEGRAM_CHATS=42 \
  node dist/src/bin/web.js
```

**Browser**: open `http://127.0.0.1:8788/`. The picker lists
`PI_CONVERSATIONS` and any conversation opened by another entry point; an
unlisted `account/channel` id opens on first use.

- `GET /events?conversation=<id>&since=<seq>` upgrades to a WebSocket.
- Client commands: `message` (with optional `attachments` as base64), `stop`,
  `new`, `status`, `history`.
- Server frames: `hello`, `preview` (the accumulated reply so far), `final`,
  `state`, `status`, `history`, `error`. Every frame that carries a `seq` is
  replayable; the client drops anything at or below the last sequence it saw.
- `GET /metrics` reports counters and p50/p95/max for `turn_millis`,
  `first_token_millis`, and `resume_millis` over the last 200 turns.

Egress policies are per actor, so a newly created actor needs one before its
first turn; `PI_EGRESS_POLICY` (default `deploy/test/egress-policy.yaml`) is
applied on creation. Without it the provider call is denied, and the turn now
fails with the provider's error instead of an empty reply.

The gateway depends on three injected pieces, so tests do not need a cluster or
a real model:

- `Channel`: sends messages, updates a streaming preview, clears it, and
  optionally delivers a turn failure through `sendError`.
- `AgentBackend`: submits a turn and streams deltas. A response may carry an
  `error`, which the gateway records as `job_failed`.
- `ResolvedConversation`: storage layout and conversation identity.

## Delivery state and restart recovery

Every turn is a job. The runtime appends these records to `channel.jsonl`:

```
inbound -> job_queued -> job_dispatched -> outbound -> job_completed
```

`job_dispatched` stores a request id that is stable for the job. The backend is
idempotent per request id, and the channel is idempotent per delivery id.

On start, the gateway scans for jobs without a terminal record and recovers
them by position in the log:

| Crash point | State in `channel.jsonl` | Recovery |
|---|---|---|
| Before submit | `job_queued` | Submit with the job id as request id |
| After submit, before response | `job_dispatched` | Retry the same request id; the backend returns the same turn |
| After the channel send, before `outbound` | `job_dispatched` | Retry the cached turn; the channel suppresses the duplicate delivery id |
| After `outbound`, before `job_completed` | `outbound` | Append the completion; do not call the backend or the channel again |

The recovery path never replays a completed turn.

## Idle lifecycle

`IdleLifecycle` (`src/lifecycle/idle.ts`) owns one conversation's actor state:

```
IDLE -prompt-> ACTIVE -settled-> GRACE -idle-> SUSPENDING -done-> SUSPENDED
```

A prompt in `GRACE` or `SUSPENDING` cancels the pending suspend and returns to
`ACTIVE`; the router resumes the actor when the turn connects. A suspend is
never issued mid-turn, because substrate's suspend cancels in-flight work
instead of draining it. The gateway reports boundaries only after
`job_completed`, so a crash between the outbound record and the completion does
not start the idle clock.

Nothing reconnects on its own. Connecting to the bridge wakes the actor, so an
automatic reconnect after a suspend would immediately undo the idle window and
the actor would never stay asleep. The next turn is the only thing that opens
the connection; `PiBackend` drops its settled-result cache on disconnect,
because those results lived in the bridge process that the suspend removed.

`KubectlAteControl` (`src/lifecycle/kubectl.ts`) is the control plane client.
The local gateway takes the actor ref from `PI_ACTOR`; `ensure()` treats an
already-existing actor as success.

## Test channel

`test/support/test-channel.ts` refuses to construct unless `NODE_ENV=test`.
Nothing under `src/` imports it, so production entry points cannot reach it.

## License

Apache-2.0. Vendored code and the notices that ship with it are listed in
`THIRD_PARTY_NOTICES.md`.

## Provenance

The conversation runtime is a vendored pi-chat subset. See
`third_party/pi-chat/README.md` for the source commit, copied files, and every
modification. License texts are in `LICENSE` and `THIRD_PARTY_NOTICES.md`.

This project is not affiliated with Pi, OpenClaw, Google, or Agent Substrate.
