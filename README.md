# pi-agent-substrate

Always-on Pi agents on [Agent Substrate](https://github.com/agent-substrate/substrate):
a standalone gateway keeps the chat presence, while each conversation's
cognition runs in a suspendable Substrate actor.

This repository is at milestone **M1**. It does not need a cluster yet: the
gateway, the conversation log, and the restart recovery path run and are tested
on a workstation.

## Design

The design baseline, including implementation status, is
[docs/pi-always-on-agent.md](docs/pi-always-on-agent.md).

## M1 scope

M1 extracts the channel and conversation runtime from pi-chat into a standalone
gateway and proves two things:

| Exit criterion | Where it is verified |
|---|---|
| A test channel can echo a message, with streaming edits | `test/m1.test.ts` test 1 |
| After a gateway restart, unfinished deliveries resume from `channel.jsonl` | `test/m1.test.ts` tests 2 to 5 |

The backend is a deterministic echo service. A real `pi --mode rpc` backend and
the Discord/Telegram adapters are M2 and later.

## Run

```sh
npm install
npm test
```

Requires Node.js 22 or newer. `npm test` typechecks, builds, and runs the
acceptance tests.

To try the echo gateway by hand:

```sh
npm run demo:echo
```

The demo prints the `channel.jsonl` path and echoes each line you type.

## Layout

```
src/gateway/        Gateway state machine and injectable boundaries
src/backend/echo.ts Deterministic, idempotent echo backend
test/m1.test.ts     M1 acceptance tests
test/support/       Test channel and test conversation layout (test builds only)
third_party/pi-chat Vendored conversation runtime, see its README
```

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

## Test channel

`test/support/test-channel.ts` refuses to construct unless `NODE_ENV=test`. It
is not imported by anything under `src/`, so production entry points cannot
reach it.

## License

Apache-2.0. Vendored code and the notices that ship with it are listed in
`THIRD_PARTY_NOTICES.md`.

## Provenance

The conversation runtime is a vendored pi-chat subset. See
`third_party/pi-chat/README.md` for the source commit, copied files, and every
modification. License texts are in `LICENSE` and `THIRD_PARTY_NOTICES.md`.

This project is not affiliated with Pi, OpenClaw, Google, or Agent Substrate.
