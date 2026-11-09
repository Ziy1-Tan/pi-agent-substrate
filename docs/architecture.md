# Always-on Pi agents on Agent Substrate

Combine always-on-agent's idle suspension policy with Substrate's suspendable
actors to run a pi-durable Harness inside an actor: a Pi agent that stays reachable
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

| Layer    | Role                                       | Source                                                                      |
| -------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Channel  | Where the human speaks                     | The HTTP adapter in `src/gateway/http.ts`                                   |
| Gateway  | Turn relay and lifecycle decisions         | `src/gateway/`; the idle lifecycle follows always-on-agent's idle suspender |
| Platform | Scheduling, routing, snapshots, sandboxing | Substrate                                                                   |
| Runtime  | Agent loop and tool execution              | pi-durable Harness, in-process in the actor                                 |

Presence and cognition are separate concerns. The resident gateway is an
ordinary process, not an actor and not in a WorkerPool; it answers HTTP
requests and maps a conversation id to an actor. The local deployment runs it
as a Deployment in the cluster next to the workers. Each conversation has its
own actor, which runs the Harness and holds `/workspace`, the session
files, and the process state. A message is forwarded to the actor, which the
router resumes if it was suspended; after the turn settles and an idle window
with no work in flight, the gateway suspends it again.

### State ownership

| State                                    | Where                | Why                                                          |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------ |
| Provider secret                          | Kubernetes Secret    | Injected on egress; must never enter a snapshot              |
| Turn in flight                           | Gateway memory       | The reply is the HTTP response; nothing outlives the request |
| memory, skills, code, session files      | Actor's `/workspace` | Cognition layer; moves with the snapshot                     |
| Process memory, the running turn         | Actor                | A MEMORY snapshot restores a warm process                    |
| Placement, snapshot references, identity | Substrate            | Platform responsibility                                      |

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
WebSocket, and owns the idle lifecycle. Everything it asks of Substrate
(create, suspend, apply egress) is a gRPC call to ate-api.

The actor image is a WebSocket bridge in front of the Harness over JSONL
storage in `/workspace/.pi-durable`, on a pinned Node base image, with
`/workspace` declared as a durableDir for memory, skills, code, and session
files.

The Substrate core is not modified.

## Core models

### Interface contracts

Gateway to actor: one WebSocket per turn. The gateway dials atenet-router
with its pod certificate and selects the actor with the
`ate-target-actor: <atespace>/<actor>` header. It sends `{id, prompt}`; the
bridge answers on the same socket with `{id, text}`, or `{id, text: "",
error}` when the turn failed, and the gateway closes the socket. The connection
lives only as long as the turn, because connecting is what wakes the actor.

Gateway to control plane: ate-api's `Control` service over gRPC at
`api.ate-system.svc:443`, authenticated by the same pod certificate. ate-api
sees the gateway as its SPIFFE ID, which the atespace's access policy makes an
`editor`. Operations: CreateActor, CreateActorEgressPolicy, SuspendActor.
Resume is not a call: the router wakes the actor when the next turn connects.

Client to gateway: `POST /messages` with a conversation id and text. The
gateway relays the prompt and the reply and never lets the caller touch an
actor directly.

### Turn handling

A turn is one HTTP request. The gateway serializes turns within a
conversation, connects to the actor (which the router resumes), sends one
prompt, and returns the result's text in the response. Nothing is
written to disk on the gateway side: if the gateway or the connection dies
mid-turn, that request fails and the caller retries. The actor's session file
is what carries the conversation forward, not a gateway queue.

### Lifecycle state machine

```text
OPENING --ensure + egress--> IDLE      (a failed open is forgotten; the next message retries)
IDLE --prompt--> ACTIVE --turn settled--> GRACE
GRACE --prompt--> ACTIVE
GRACE --timeout with nothing in flight--> SUSPENDING
SUSPENDING --done--> SUSPENDED
SUSPENDING --failed--> GRACE            (the idle window restarts)
SUSPENDED/SUSPENDING --prompt--> ACTIVE (the router resumes the actor on connect)
```

`GET /metrics` reports each conversation's state, its in-flight count, and the
last suspend error. These are the gateway's own states; `SUSPENDED` means the
gateway asked for a suspend, and ate-api's `RESUMING` or `CRASHED` are not
tracked here.

- Only a settled turn permits entry to `GRACE`; an arriving prompt cancels the
  timer immediately.
- Suspension cancels in-flight work rather than draining it, so it must never
  fire mid-turn. The gateway leaves `GRACE` on `turnStarted()` and calls
  `turnSettled()` only after the turn is fully recorded.
- Any failure after `turnStarted()` must still settle once, or the in-flight
  count never returns to zero and the actor never suspends again.
- A prompt during `SUSPENDING` is left to the router's resume; no second
  suspend, and a late suspend result must not write `SUSPENDED` back.

### Turn phases

A turn is in `connect` until the WebSocket opens and in `turn` after the prompt
is sent. A failure carries its phase and, when the router refused the
upgrade, the router's status and reason (`router answered 404: actor
pi-agents/pi-x not found`), which the HTTP entry point returns in its 502.

Only one failure is retried. A 404 in `connect` means the actor was deleted
after the conversation opened; the prompt never left the gateway, so the
gateway recreates the actor, reapplies its egress policy, and sends the turn
once more. The recreated actor starts with no history, and `actors_recreated`
counts it. A failure in `turn` is never retried, because the actor may already
be running the prompt. A crashed actor surfaces as the router's 503 and is left
to the operator.

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
survives runtime changes, but restores cold. Either way the JSONL storage under
`/workspace/.pi-durable` must stay readable, and the gateway never depends on
memory captured in a snapshot. After a restore the bridge opens the Harness over
that storage again; the Harness adopts any unfinished work from the log.

### Error propagation

A failure must be distinguishable from an empty reply, or the user sees
silence. The Harness reports a failed model call as an unanswered submission;
the bridge puts its reason in the result's `error`, and the HTTP entry point
answers with a 502 and that reason. Gateway failures such as a failed connect
or a dropped connection take the same path and settle the lifecycle on the way
out.
