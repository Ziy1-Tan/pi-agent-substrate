# Always-on Pi agents on Agent Substrate

Combine always-on-agent's idle suspension policy with Substrate's suspendable
actors to run `pi --mode rpc` inside an actor: a Pi agent that stays reachable
but only computes on demand.

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
| Channel | Where the human speaks | The HTTP adapter in `src/gateway/server.ts` |
| Gateway | Turn relay and lifecycle decisions | `src/gateway/substrate/` follows always-on-agent's provisioner and idle-suspender split |
| Platform | Scheduling, routing, snapshots, sandboxing | Substrate |
| Runtime | Agent loop and tool execution | `pi --mode rpc`, inside the actor |

Presence and cognition are separate concerns. The resident gateway is an
ordinary process, not an actor and not in a WorkerPool; it answers HTTP
requests and maps a conversation id to an actor. The local deployment runs it
as a Deployment in the cluster next to the workers. Each conversation has its
own actor, which runs `pi --mode rpc` and holds `/workspace`, the session
files, and the process state. A message is forwarded to the actor, which the
router resumes if it was suspended; after `agent_settled` and an idle window
with no work in flight, the gateway suspends it again.

### State ownership

| State | Where | Why |
|---|---|---|
| Provider secret | Kubernetes Secret | Injected on egress; must never enter a snapshot |
| Turn in flight | Gateway memory | The reply is the HTTP response; nothing outlives the request |
| memory, skills, code, session files | Actor's `/workspace` | Cognition layer; moves with the snapshot |
| Process memory, the running turn | Actor | A MEMORY snapshot restores a warm process |
| Placement, snapshot references, identity | Substrate | Platform responsibility |

### Goals

1. An HTTP message resumes a suspended actor and returns its reply.
2. After a turn and the idle window, the actor suspends and releases its worker.
3. A message hours later continues the conversation with context and workspace
   intact.
4. Several conversations share a small WorkerPool; idle ones hold no worker.
5. Model credentials never enter the sandbox; egress injects them.
6. One command from the README gets to a working conversation.

## Components

The gateway is a standalone process that does not run the agent. It accepts
`POST /messages`, maps a conversation id to an actor, relays one turn over a
WebSocket, and owns the idle lifecycle. Everything it asks of Substrate —
create, suspend, apply egress — goes through one control interface.

The actor image is a WebSocket-to-stdio bridge in front of
`pi --mode rpc --session-dir /workspace/.pi`, on a pinned Node base image, with
`/workspace` declared as a durableDir for memory, skills, code, and session
files.

The Substrate core is not modified.

## Core models

### Interface contracts

Gateway to actor: a WebSocket carrying JSONL records. It dials atenet-router
with a client certificate and selects the actor with the
`ate-target-actor: <atespace>/<actor>` header. The gateway sends `prompt`; the
bridge relays Pi's other commands unchanged. Events: `message_update`,
`tool_call`, `agent_settled`, and Pi's other session events. Commands carry an
`id` that responses echo; clients never depend on response ordering. The
gateway must keep reading so a slow socket cannot block the actor's stdout.

The bridge adds one extension: `bridge_result` carries the `requestId` when a
turn settles. Pi's own `agent_settled` does not identify the turn, so this is
what the gateway settles on. It is sent before `agent_settled`, because the
gateway settles on the first record it sees and a bare `agent_settled` would
turn a provider failure into an empty reply.

Gateway to control plane: the ateapi over podcert mTLS or ServiceAccount
identity in production, the `kubectl-ate` subprocess locally. Operations:
CreateActor, SuspendActor, GetActor. Resume is not a call: the router wakes the
actor when the next turn connects.

Client to gateway: `POST /messages` with a conversation id and text. The
gateway relays the prompt and the reply and never lets the caller touch an
actor directly.

### Turn handling

A turn is one HTTP request. The gateway serializes turns within a
conversation, connects to the actor (which the router resumes), sends one
prompt, and returns the `bridge_result` text in the response. Nothing is
written to disk on the gateway side: if the gateway or the connection dies
mid-turn, that request fails and the caller retries. The actor's session file
is what carries the conversation forward, not a gateway queue.

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

Connecting wakes the actor, so the transport must not reconnect on its own: a
reconnect after a suspend would wake the actor immediately and produce a
suspend/wake loop. The next turn's `connect()` is the only wake action.

### Conversation mapping

One conversation maps to one actor, named deterministically from the
conversation id (a legal Kubernetes name with a fixed `pi-` prefix). A missing
actor is created from the golden template; templates are immutable, so a change
needs a new name. Each conversation has its own actor.

### Snapshot policy

MEMORY (the default) captures process memory, rootfs changes, and durable data,
so a restore yields a warm process. DATA plus session files is smaller and
survives runtime changes, but restores cold and must continue via `--session-id`
or `--continue`. Either way the session files under `/workspace` must stay
readable, and the gateway never depends on memory captured in a snapshot. Since
the Pi child may be dead after a restore, the bridge starts it lazily and
restarts it on the same `--session-id` when a client connects.

### Error propagation

A failure must be distinguishable from an empty reply, or the user sees
silence. Pi reports a provider failure through the final assistant message
(`stopReason: "error"` with `errorMessage`) and an exhausted retry through
`auto_retry_end` with `success: false` and `finalError`. The bridge folds both
into `bridge_result`, the backend puts them in `AgentResponse.error`, and the
HTTP entry point answers with a 502 and the reason. Gateway failures such as a
failed connect or a dropped transport take the same path and settle the
lifecycle on the way out.
