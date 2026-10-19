---
title: Always-on Pi agents on Agent Substrate
date: 2026-10-18
tags:
  - substrate
  - pi
  - always-on-agent
  - agent-runtime
  - design
  - spec
---

> **In one sentence**
> Reuse pi-chat's channels and conversation state, always-on-agent's idle
> suspension policy, and Substrate's suspendable actors to run
> `pi --mode rpc` inside an actor, giving a Pi agent that stays connected but
> only computes on demand.

## Problem

Personal agents are used in bursts. You talk for a few turns, leave, and come
back hours or days later. The agent is idle almost the whole time, but you
want it to stay online. None of the three existing paths covers that:

1. **A resident local process.** Simplest to implement, but it holds local
   resources forever, has no sandbox isolation, and dies when you close the
   laptop or quit the terminal. It also cannot multiplex several agents onto a
   small pool of compute.
2. **Substrate's task-driven shape.** Actors suspend and keep their state
   across a restore, but the entry point is a synchronous HTTP `/submit`. There
   is no streaming, no TUI, no connection to hold, and no idle detection, so
   every suspend has to be issued externally.
3. **pi-chat.** It has Discord/Telegram adapters, a conversation log, streaming
   rendering, attachments, and secret exchange, but it starts a local Gondolin
   micro-VM and a tmux worker per channel. There is no notion of suspension, and
   nothing can hand the work to Substrate.

Three platform constraints compound this:

- Substrate has no exec/attach, so a standard Pi or Claude TUI cannot reach a
  remote actor.
- The platform does not detect idleness; every suspend is explicit.
- Suspension drops connections. A memory snapshot restores the process, but the
  socket on the other side does not come back, so a restore must reconnect and
  re-align state.

The user is left choosing between two losses: give up the experience and use
only an API or a hand-rolled UI, or give up efficiency and keep the agent
resident on their machine.

## Design

Four layers, each with one job:

| Layer | Role | Source |
|---|---|---|
| Channel | Where the human speaks | pi-chat's conversation runtime and streaming renderer; this repository supplies the curl, browser, and Telegram adapters |
| Gateway | Connection keep-alive and lifecycle decisions | always-on-agent's `idle-suspender` idea |
| Platform | Scheduling, routing, snapshots, sandboxing | Substrate |
| Runtime | Agent loop and tool execution | `pi --mode rpc`, inside the actor |

The organizing principle is that presence and cognition are separate concerns:

- The resident gateway is an ordinary process. It is not in a WorkerPool and
  is not an actor. It holds the channel connections, the conversation mapping,
  and the chat log.
- Each conversation has its own Substrate actor. The actor runs
  `pi --mode rpc` and holds `/workspace`, the session files, and the process
  state.
- When a message arrives, the gateway forwards the turn to the actor. When the
  actor is suspended, `atenet-router` resumes it.
- Idle timing starts after `agent_settled`. When the window expires with no work
  in flight, the gateway suspends the actor.
- The next message repeats the cycle. The conversation continues from the
  session file and the snapshot.

### State ownership

| State | Where | Why |
|---|---|---|
| Channel config, bot token, secrets | Gateway | Presence layer; must never enter a snapshot |
| `channel.jsonl`, queue, attachments | Gateway | Recovery, replay, and conversation rebuild all depend on it |
| memory, skills, code, session files | Actor's `/workspace` | Cognition layer; moves with the snapshot |
| Process memory, the running turn | Actor | A MEMORY snapshot restores a warm process |
| Placement, snapshot references, identity | Substrate | Platform responsibility |

### Goals

1. A message from a channel resumes a suspended actor and streams a reply.
2. After a turn and the configured idle window, the actor suspends and releases
   its worker.
3. A message hours later continues the same conversation with context and
   workspace intact.
4. Several conversations share a small WorkerPool; idle ones hold no worker.
5. Real model credentials never enter the sandbox; the egress layer injects
   them.
6. On a fresh machine, one command from the README gets to a working
   conversation once a token is supplied.

## Components

### Gateway

A standalone process. It does not run the agent.

- **Channel adapters** turn an external message into one turn and deliver the
  reply the way that channel renders.
- **Conversation runtime**: message queue, session lock, `channel.jsonl`,
  attachment storage.
- **Conversation mapping**: derive the actor name from the conversation id and
  create the actor if it is absent.
- **RPC relay**: turn channel messages into Pi RPC commands, and Pi's events
  back into streaming output.
- **Idle suspension**: start a timer after `agent_settled`, cancel it when a
  prompt arrives.
- **Control-plane client**: create, resume, suspend.

### Actor image

- **WebSocket-to-stdio bridge**: each JSONL record arriving on the socket is
  written to `pi --mode rpc`'s stdin; stdout is framed back into records and
  pushed to the socket.
- **Entry point**: `pi --mode rpc --session-dir /workspace/.pi`, with the
  session id supplied by the gateway.
- **Base image** is Node, pinned to a version that satisfies Pi's `engines`
  requirement.
- **`/workspace`** is declared as a durableDir. Memory, skills, code, and
  session files all live there.

### What is not modified

- pi-chat's channel, rendering, config, and secrets modules.
- The Substrate core and router.

## Core models

### Interface contracts

#### Gateway to actor

- **Transport**: WebSocket carrying JSONL records, one JSON object per line.
- **Routing**: the `ate-target-actor: <atespace>/<actor>` header. URL and Host
  play no part in actor selection.
- **Commands**: `prompt`, `get_state`, `abort`, `clear_queue`, `new_session`.
- **Events**: `message_update`, `tool_call`, `agent_settled`, and Pi's other
  session events.
- **Correlation**: commands carry an `id` and responses echo it. Clients
  correlate by id and never depend on response ordering.
- **Backpressure**: the gateway must keep reading; a slow WebSocket must not
  block the actor's stdout.

The bridge adds two extensions on top of Pi's protocol:

- **`bridge_result`** is emitted by the bridge when a turn settles, carrying the
  `requestId`. Pi's own `agent_settled` does not identify the turn, so this is
  what the gateway settles on. It is sent before `agent_settled` because the
  gateway settles on the first record it sees, and a bare `agent_settled` would
  turn a provider failure into an empty reply.
- **`bridge_get_state` / `bridge_result` lookup** lets a reconnected client ask
  the bridge for a turn that settled while it was away, instead of resending the
  prompt.

#### Gateway to control plane

- **Production**: the ateapi, over podcert mTLS or ServiceAccount identity.
- **Local**: the `kubectl-ate` subprocess.
- **Operations**: CreateActor, ResumeActor, SuspendActor, GetActor.

#### Client to gateway

- Channel clients go through their own adapters.
- The browser and curl use the gateway's HTTP/WebSocket API, which relays
  prompts and events and never touches an actor directly.

### Delivery state machine

Every turn is a job. The runtime appends these records to `channel.jsonl`:

```
inbound -> job_queued -> job_dispatched -> outbound -> job_completed
```

`job_dispatched` stores a request id that stays stable for the job. The backend
is idempotent per request id and the channel is idempotent per delivery id. On
start, the gateway scans for jobs without a terminal record and recovers them by
their position in the log:

| Crash point | Recorded state | Recovery |
|---|---|---|
| Before submit | `job_queued` | Submit again with the job id as the request id |
| After submit, before the response | `job_dispatched` | Retry the same request id; the backend returns the same turn |
| After the channel send, before `outbound` | `job_dispatched` | Retry the cached turn; the channel suppresses the duplicate delivery id |
| After `outbound`, before `job_completed` | `outbound` | Append the completion only; call neither the backend nor the channel |

The recovery path never replays a completed turn.

### Lifecycle state machine

```text
IDLE --prompt--> ACTIVE --agent_settled--> GRACE
GRACE --prompt--> ACTIVE
GRACE --timeout with nothing in flight--> SUSPENDING
SUSPENDING --done--> SUSPENDED
SUSPENDED --prompt/attach--> RESUMING --ready--> ACTIVE
ACTIVE/GRACE --actor crash--> CRASHED (requires revert or recreate)
```

The constraints that matter:

- Only `agent_settled` permits entry to `GRACE`, and an arriving prompt cancels
  the timer immediately.
- Suspension cancels in-flight work rather than draining it, so it must never
  fire mid-turn. The gateway leaves `GRACE` on `turnStarted()` and calls
  `turnSettled()` only after the turn is fully recorded.
- Any failure after `turnStarted()` must still settle once. Otherwise the
  in-flight count never returns to zero, the state machine never reaches
  `GRACE`, and the actor never suspends again.
- A prompt arriving during `SUSPENDING` is left to the router's resume. The
  gateway does not issue a second suspend, and a late suspend result must not
  write the state back to `SUSPENDED`.
- A failed suspend falls back to `GRACE` and restarts the idle window rather
  than leaving the conversation stuck in `SUSPENDING`.
- An actor crash does not automatically retry the same turn. The session files
  stay; whether to revert is the user's or the policy's decision.

**Connecting wakes the actor.** The act of connecting to the bridge is itself a
wake signal. A transport therefore must not reconnect on its own: doing so after
a suspend would wake the actor immediately and produce a suspend/wake loop in
which the actor never sleeps through a full idle window. The next turn's
`connect()` is the only wake action. On disconnect the backend must also clear
its settled-result cache, because those results lived in the bridge process the
suspend removed.

### Conversation mapping

- One conversation maps to one actor. The actor name is derived
  deterministically from the conversation id: normalized into a legal
  Kubernetes name with a fixed `pi-` prefix.
- If the actor is absent, create it from the golden template. Templates are
  immutable; a change needs a new template.
- Actor names are unique within an atespace. Channels do not share an actor
  unless configured to.
- Each conversation has its own actor, log, and lock, so one conversation
  failing does not affect the others.

### Snapshot policy

- **MEMORY** (default): process memory plus rootfs changes plus durable data.
  The restore produces a warm process, and a reconnecting client only needs
  `get_state`.
- **DATA plus session files** (optional): a smaller snapshot that survives
  runtime changes, but the restore is cold and must continue via `--session-id`
  or `--continue`.
- Either policy must leave the session files under `/workspace` readable. The
  gateway never depends on memory captured in a snapshot.
- After a restore the Pi child process may be dead. The bridge starts Pi lazily
  and, when a client connects, restarts it on the same `--session-id` so Pi
  continues the session file instead of rerunning the previous turn.

### Reconnect and idempotence

- The gateway assigns a request id per turn. A retry with the same id returns
  the existing result rather than executing again.
- While a client is disconnected the gateway buffers events. On reconnect the
  client first fetches `get_state` and the conversation history, then resumes
  the live stream.
- A disconnect caused by suspension does not replay the last turn; the session
  file is the source of truth for what was committed.
- The RPC client has no built-in reconnect. Reconnection is the gateway's or
  the relay's responsibility.

### Error propagation

A failure must be distinguishable from an empty reply. Otherwise the user sees
silence and an operator cannot tell a model problem from a gateway problem.

- Pi reports a provider failure through the final assistant message:
  `stopReason: "error"` with `errorMessage`. An exhausted retry loop emits
  `auto_retry_end` with `success: false` and `finalError`.
- The bridge folds both signals into the turn result and sends it with
  `bridge_result`.
- The backend puts it in `AgentResponse.error`, the gateway records
  `job_failed`, and the channel's `sendError` delivers the reason to the user.
- The gateway's own failures, such as a failed submit or a dropped transport,
  take the same reporting path and settle the lifecycle on the way out.

## Deployment

### Shape and constraints

- One replica. Each bot token maintains a single active channel connection.
  Personal deployments use one replica with a restart policy and no leader
  election.
- A single-user deployment runs the gateway on the user's machine and reaches
  the router through a port-forward. An in-cluster deployment uses Service DNS
  to reach `atenet-router.ate-system.svc` directly.
- The bot token exists only on the gateway side. The model key never enters the
  actor; the egress layer injects it on the way out.
- Actors hold no control-plane credentials and cannot suspend themselves.
  Lifecycle decisions belong to the gateway.
- After a restart the gateway recovers unfinished deliveries from
  `channel.jsonl` and the conversation mapping without replaying committed
  turns.

### Portability

There is one deployment path. Local and cluster deployments share the same
manifests and differ only in storage, image registry, and sandbox class:

- **One manifest structure.** Deployment, ActorTemplate, WorkerPool, and
  ConfigMap/Secret carry the same fields; the differences live in an overlay.
- **One install script.** It builds or pulls images, creates the atespace and
  template, waits for the golden snapshot, deploys the gateway, and prints the
  channel setup steps.
- **One place for configuration.** Channel tokens, atespace, template, and the
  idle window are configured together. The model key goes through the
  credential provider and the egress policy.
- **No host-path dependency.** The gateway uses in-cluster Service DNS only.

## Cross-cutting concerns

### Timeouts and capacity

- `atenet-router`'s `--route-timeout` defaults to 10 seconds, too short for a
  full conversational turn. Raise it per deployment.
- `--parked-request-budget` defaults to 5 seconds. Cold nodes or large
  snapshots need more.
- Long-lived connections have a stream idle timeout; keep them alive or let a
  reconnect recover them.
- The WorkerPool's worker count caps concurrent conversations. When workers run
  out, a new actor parks or fails with a diagnosable error.

### Security

- The bot token and model key live only in the gateway or a Kubernetes Secret.
  The actor holds placeholders.
- Model calls get real credentials from the egress policy. Neither the actor
  nor a snapshot contains plaintext.
- Actors hold no control-plane credentials.
- Deployments are single-user or private; multi-tenant RBAC is out of scope.

### Compatibility

- Pin the Pi version and declare the set of RPC commands and events the gateway
  reads.
- RPC is version-sensitive. Upgrading Pi means running the smoke suite first,
  then rolling the actor image.
- ActorTemplates are immutable. A digest change rebuilds the golden snapshot.

## Testing

Good tests assert external behavior: given a channel message and a set of RPC
events, does the gateway forward, suspend, and reconnect correctly? They do not
reach into internal state objects or private methods.

### Seams

The highest seam sits at the gateway boundary. All three external dependencies
must be injectable:

- **Channel entry**: a fake channel injects messages, bypassing the real ones.
- **Actor transport**: a fake WebSocket replays RPC records.
- **Control-plane client**: a fake create/resume/suspend records call order and
  counts.

Assert the command sequence the gateway emits, the suspend calls, the rendered
output, and the state transitions, without touching internals. That covers
channels, conversation mapping, the RPC relay, idle policy, and reconnection
without a cluster or a real Pi.

The bridge has its own seam: replay JSONL through a fake `pi` stdio and verify
two-way forwarding, backpressure, and disconnects. Do not hand-write events;
record them from a pinned Pi as fixtures, covering strict LF framing, CRLF,
`U+2028`/`U+2029`, id correlation, protocol-only stdout, and stderr kept out of
the protocol stream.

The idle timer takes an injectable clock, and the control client's suspend can
be held open, which is what makes the prompt-during-`SUSPENDING` race testable.

### End to end

Three layers with different jobs.

**Core path in CI.** A real actor and a real `pi --mode rpc` in a cluster, with
an OpenAI-compatible mock returning fixed content and tool calls, so the run is
repeatable and costs nothing. Assertions: the reply streams, the agent writes a
file under `/workspace`, the actor suspends with no manual command, the next
message resumes it, and both the file and the session continue.

**Real channel smoke, manual or nightly.** A dedicated test bot and test chat
validate the channel adapter and a real provider: streaming edit-in-place,
chunking and rate limits, automatic suspend and resume, attachments, and the
control commands.

**Failure and capacity.** Queuing and errors when workers run out, injected
resume failures, session survival after an actor crash, the gateway restart
matrix, and a contract test for the pinned Pi version.

### Acceptance thresholds

| Metric | Target | Notes |
|---|---|---|
| Automatic suspend | Idle window + ≤5s | No manual command |
| Resume to first token | P50 ≤5s, P95 ≤10s | Calibrate per machine |
| Reconnect | 0 duplicate frames, 0 gaps | Verified at three disconnect points |
| 100 suspend/resume cycles | No growth trend in connections or memory; stable session entries and file hashes | Soak |
| Credential leakage | Zero hits for real tokens or keys in actor env, snapshots, or logs | Security |
| Density | With 2 conversations and 1 worker, both suspend when idle | Resources |

## Out of scope

- Native remote attach for the standard Pi or Claude Code TUI. Pi's TUI is not
  an RPC client, and Claude has no public RPC or attach mode.
- Reusing OpenClaw or ACP. Only always-on-agent's lifecycle ideas are borrowed;
  there is no dependency on OpenClaw.
- Multi-tenant authentication, RBAC, quotas, and billing.
- A productized frontend or mobile app. The browser page exists to observe
  conversations and replay; the real entry points are curl and Telegram.
- Model routing, A/B tests, and automatic provider selection.
- Online migration or cross-cluster scheduling.

## References

- `agent-substrate/always-on-agent`: `extensions/substrate/idle-suspender.ts`,
  `actor-router.ts`, `actor-provisioner.ts`, `manifests/actortemplate.yaml`
  (the MEMORY snapshot trade-off and "restoring a warm, already-thinking
  agent").
- `earendil-works/pi-chat`: `src/live`, `src/services`, `src/runtime.ts`,
  `src/render`, `src/gondolin.ts` (the sandbox layer this project replaces).
- `earendil-works/pi`: `packages/coding-agent/docs/rpc.md`,
  `rpc-commands.md`, `cli.md`, `src/modes/rpc/rpc-client.ts`.
- Substrate: `docs/architecture.md`, `cmd/atenet/internal/router/xds.go`
  (WebSocket upgrade and idle timeout), `docs/integration-repos.md`,
  `docs/egress-credential-injection.md`, `docs/egress-trust-bundle.md`.
- Substrate's kind e2e (`hack/run-e2e-kind.sh`, `internal/e2e`) and
  always-on-agent's smoke scripts, as models for how assertions are organized.
