# Always-on Pi agents on Agent Substrate

Reuse pi-chat's channels and conversation state, always-on-agent's idle
suspension policy, and Substrate's suspendable actors to run `pi --mode rpc`
inside an actor: a Pi agent that stays connected but only computes on demand.

## Problem

Personal agents are used in bursts. You talk for a few turns, leave, and come
back hours later. The agent is idle almost the whole time, but you want it to
stay online. Neither a resident local process (holds resources, dies with the
laptop, no isolation) nor Substrate's task-driven shape (synchronous HTTP
`/submit`, no streaming, no connection, explicit suspend) nor pi-chat (a local
micro-VM and tmux worker per channel, no suspension) covers that.

Three platform constraints compound this: Substrate has no exec/attach, so a
standard Pi or Claude TUI cannot reach a remote actor; the platform does not
detect idleness; and suspension drops connections, so a restore must reconnect
and re-align state.

## Design

| Layer | Role | Source |
|---|---|---|
| Channel | Where the human speaks | pi-chat's conversation runtime and renderer; the curl, browser, and Telegram adapters live here |
| Gateway | Connection keep-alive and lifecycle decisions | always-on-agent's `idle-suspender` idea |
| Platform | Scheduling, routing, snapshots, sandboxing | Substrate |
| Runtime | Agent loop and tool execution | `pi --mode rpc`, inside the actor |

Presence and cognition are separate concerns. The resident gateway is an
ordinary process, not an actor and not in a WorkerPool; it holds the channel
connections, the conversation mapping, and the chat log. Each conversation has
its own actor, which runs `pi --mode rpc` and holds `/workspace`, the session
files, and the process state. A message is forwarded to the actor, which the
router resumes if it was suspended; after `agent_settled` and an idle window
with no work in flight, the gateway suspends it again.

### State ownership

| State | Where | Why |
|---|---|---|
| Channel config, bot token, secrets | Gateway | Presence layer; must never enter a snapshot |
| `channel.jsonl`, queue, attachments | Gateway | Recovery, replay, and rebuild depend on it |
| memory, skills, code, session files | Actor's `/workspace` | Cognition layer; moves with the snapshot |
| Process memory, the running turn | Actor | A MEMORY snapshot restores a warm process |
| Placement, snapshot references, identity | Substrate | Platform responsibility |

### Goals

1. A channel message resumes a suspended actor and streams a reply.
2. After a turn and the idle window, the actor suspends and releases its worker.
3. A message hours later continues the conversation with context and workspace
   intact.
4. Several conversations share a small WorkerPool; idle ones hold no worker.
5. Model credentials never enter the sandbox; egress injects them.
6. One command from the README gets to a working conversation.

## Components

The gateway is a standalone process that does not run the agent: channel
adapters, the conversation runtime (queue, session lock, `channel.jsonl`,
attachments), conversation mapping (actor name from conversation id,
create-if-absent), the RPC relay, idle suspension, and the control-plane client.

The actor image is a WebSocket-to-stdio bridge in front of
`pi --mode rpc --session-dir /workspace/.pi`, on a pinned Node base image, with
`/workspace` declared as a durableDir for memory, skills, code, and session
files.

pi-chat's channel, rendering, config, and secrets modules and the Substrate core
are not modified.

## Core models

### Interface contracts

Gateway to actor: a WebSocket carrying JSONL records, routed by the
`ate-target-actor: <atespace>/<actor>` header. Commands: `prompt`, `get_state`,
`abort`, `clear_queue`, `new_session`. Events: `message_update`, `tool_call`,
`agent_settled`, and Pi's other session events. Commands carry an `id` that
responses echo; clients never depend on response ordering. The gateway must
keep reading so a slow socket cannot block the actor's stdout.

The bridge adds two extensions:

- `bridge_result` carries the `requestId` when a turn settles. Pi's own
  `agent_settled` does not identify the turn, so this is what the gateway
  settles on. It is sent before `agent_settled`, because the gateway settles on
  the first record it sees and a bare `agent_settled` would turn a provider
  failure into an empty reply.
- `bridge_get_state` and a `bridge_result` lookup let a reconnected client ask
  the bridge for a turn that settled while it was away, instead of resending
  the prompt.

Gateway to control plane: the ateapi over podcert mTLS or ServiceAccount
identity in production, the `kubectl-ate` subprocess locally. Operations:
CreateActor, ResumeActor, SuspendActor, GetActor.

Client to gateway: channel clients through their own adapters, the browser and
curl through the gateway's HTTP/WebSocket API, which relays prompts and events
and never touches an actor directly.

### Delivery state machine

Every turn is a job. The runtime appends `inbound -> job_queued ->
job_dispatched -> outbound -> job_completed` to `channel.jsonl`.
`job_dispatched` stores a request id stable for the job; the backend is
idempotent per request id and the channel per delivery id. On start the gateway
recovers jobs without a terminal record by position in the log:

| Crash point | State | Recovery |
|---|---|---|
| Before submit | `job_queued` | Submit again with the job id as the request id |
| After submit, before the response | `job_dispatched` | Retry the same request id; the backend returns the same turn |
| After the channel send, before `outbound` | `job_dispatched` | Retry the cached turn; the channel suppresses the duplicate delivery id |
| After `outbound`, before `job_completed` | `outbound` | Append the completion only |

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

- Only `agent_settled` permits entry to `GRACE`; an arriving prompt cancels the
  timer immediately.
- Suspension cancels in-flight work rather than draining it, so it must never
  fire mid-turn. The gateway leaves `GRACE` on `turnStarted()` and calls
  `turnSettled()` only after the turn is fully recorded.
- Any failure after `turnStarted()` must still settle once, or the in-flight
  count never returns to zero and the actor never suspends again.
- A prompt during `SUSPENDING` is left to the router's resume; no second
  suspend, and a late suspend result must not write `SUSPENDED` back.
- A failed suspend falls back to `GRACE` and restarts the idle window.
- An actor crash does not retry the turn. Session files stay; revert is the
  user's or the policy's decision.

Connecting wakes the actor, so the transport must not reconnect on its own: a reconnect after a suspend would wake the actor immediately and
produce a suspend/wake loop. The next turn's `connect()` is the only wake
action, and a disconnect clears the settled-result cache, since those results
lived in the bridge process the suspend removed.

### Conversation mapping

One conversation maps to one actor, named deterministically from the
conversation id (a legal Kubernetes name with a fixed `pi-` prefix). A missing
actor is created from the golden template; templates are immutable, so a change
needs a new name. Each conversation has its own actor, log, and lock.

### Snapshot policy

MEMORY (the default) captures process memory, rootfs changes, and durable data,
so a restore yields a warm process and a reconnecting client only needs
`get_state`. DATA plus session files is smaller and survives runtime changes,
but restores cold and must continue via `--session-id` or `--continue`. Either way the session files under `/workspace` must stay
readable, and the gateway never depends on memory captured in a snapshot. Since
the Pi child may be dead after a restore, the bridge starts it lazily and
restarts it on the same `--session-id` when a client connects.

### Reconnect and idempotence

The gateway assigns a request id per turn; a retry with the same id returns the
existing result. Disconnected clients get buffered events, then `get_state` and
the history before the live stream resumes. A suspend-caused disconnect does
not replay the last turn; the session file is the source of truth. The RPC
client has no built-in reconnect.

### Error propagation

A failure must be distinguishable from an empty reply, or the user sees
silence. Pi reports a provider failure through the final assistant message
(`stopReason: "error"` with `errorMessage`) and an exhausted retry through
`auto_retry_end` with `success: false` and `finalError`. The bridge folds both
into `bridge_result`, the backend puts them in `AgentResponse.error`, the
gateway records `job_failed`, and the channel's `sendError` delivers the
reason. Gateway failures such as a failed submit or a dropped transport take
the same path and settle the lifecycle on the way out.
