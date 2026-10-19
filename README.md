# pi-agent-substrate

Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate):
a standalone gateway keeps the chat presence, while each conversation's
cognition runs in a suspendable Substrate actor.

This repository is at milestone **M4**. The gateway, the conversation log, the
restart recovery path, the actor bridge, the idle lifecycle, and the browser
channel all run and are tested on a workstation; the actor bridge, automatic
suspend/resume, and the browser channel also run on a kind cluster.

## Design

The design baseline, including implementation status, is
[docs/pi-always-on-agent.md](docs/pi-always-on-agent.md).

## Scope

M1 extracts the channel and conversation runtime from pi-chat into a standalone
gateway. M2 adds the actor side: a bridge that exposes `pi --mode rpc` as a
WebSocket inside a Substrate actor, and a gateway backend that drives it. M3
adds the idle lifecycle: the gateway suspends an actor that has no turn in
flight and the router resumes it on the next message. M4 adds the browser
channel, one actor per conversation, attachments, reconnect replay, and
latency metrics.

| Exit criterion | Where it is verified |
|---|---|
| A test channel echoes a message, with streaming edits | `test/m1.test.ts` |
| After a gateway restart, unfinished deliveries resume from `channel.jsonl` | `test/m1.test.ts` |
| The bridge forwards prompts to real `pi` and streams its reply | `test/m2-bridge.test.ts` |
| A channel message reaches `pi` through the gateway and streams back | `test/m2-e2e.test.ts` |
| Manually suspending the actor resumes on the next message, session and files intact | `hack/e2e-kind.sh` |
| An idle actor suspends with no command, and the next message resumes it | `test/m3-idle.test.ts`, `hack/e2e-idle.mjs` |
| A browser turn streams, and a reconnect with `since` replays only what was missed | `test/m4-server.test.ts`, `hack/e2e-web.mjs` |
| Two conversations map to two actors and two logs | `test/m4-web.test.ts`, `hack/e2e-web.mjs` |
| An upload survives the trip to `/workspace/incoming` | `test/m4-web.test.ts` |

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

To try the echo gateway by hand:

```sh
npm run demo:echo
```

The demo prints the `channel.jsonl` path and echoes each line you type.

To drive a real actor from this machine, forward the router and run the gateway
entry point. Each stdin line is one message; replies are framed on stdout.

```sh
kubectl -n ate-system port-forward svc/atenet-router 8000:80 &
PI_ACTOR_URL=ws://127.0.0.1:8000 PI_ACTOR=pi-agents/pi-actor-1 \
  PI_IDLE_SECONDS=60 node dist/src/bin/gateway.js
```

`PI_IDLE_SECONDS=0` disables the idle lifecycle. `PI_ACTOR_TEMPLATE` and the
`KUBECTL_ATE` / `KUBE_CONTEXT` variables configure actor creation.

## Layout

```
src/gateway/          Gateway state machine, conversation layout, multi-conversation manager
src/lifecycle/        Idle-suspend state machine and the kubectl-ate control
src/channel/          Browser channel, HTTP/WebSocket server, replay ring, page
src/backend/echo.ts   Deterministic, idempotent echo backend
src/backend/pi.ts     Backend over the actor bridge (idempotent per request id)
src/bridge/           Actor-side bridge: WebSocket <-> `pi --mode rpc`
src/protocol/         LF framing and the pinned RPC subset
src/transport/        WebSocket actor transport with reconnect
src/metrics.ts        Counters and p50/p95 timings for the last 200 turns
src/bin/gateway.ts    Local gateway entry point, driven over stdin/stdout
src/bin/web.ts        Browser gateway: page, /events, /metrics
images/actor/         Actor image: Node + pinned Pi + bridge
images/mock-llm/      OpenAI-compatible mock for the clustered e2e
deploy/test/          WorkerPool, ActorTemplate, mock LLM, egress policy
hack/e2e-kind.sh      Build, deploy, and run the clustered e2e
hack/e2e-idle.mjs     Clustered automatic suspend/resume e2e
hack/e2e-web.mjs      Clustered browser-channel e2e
test/                 Acceptance tests, M1 through M4
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

`hack/e2e-kind.sh` also runs `hack/e2e-idle.mjs`: the gateway reports turn
boundaries to the idle lifecycle, waits out `IDLE_SECONDS` (default 15) with no
manual command, observes `ACTOR_STATE_SUSPENDED`, then prompts again. It asserts
that the router resumed the actor, that the file written before the suspend is
still there, and prints the resumed turn's latency.

The last scenario, `hack/e2e-web.mjs`, starts the browser gateway against the
same port-forward. It streams a reply over `/events`, drops the socket
mid-stream, reconnects with `since`, and asserts that replay starts right after
the last seen frame with no duplicate. It then waits for the idle window to
suspend the actor, prompts again to prove the resume, opens a second
conversation to show it gets its own actor and log, and reads `/metrics` for
the turn and resume latencies.

## Browser channel

```sh
KUBECTL_ATE=kubectl-ate KUBE_CONTEXT=kind-kind \
PI_ACTOR_URL=ws://127.0.0.1:8000 PI_CONVERSATIONS=local/chat \
  node dist/src/bin/web.js
```

Then open `http://127.0.0.1:8788/`. Each stdin-free conversation tab talks to
its own actor; `PI_CONVERSATIONS` only pre-populates the picker, and any
`account/channel` id opens on first use.

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
applied on creation. Without it the turn completes with an empty reply rather
than a visible error, because Pi retries the provider connection and settles.

The gateway depends on three injected pieces, so tests do not need a cluster or
a real model:

- `Channel`: sends messages, updates a streaming preview, clears it.
- `AgentBackend`: submits a turn and streams deltas.
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
