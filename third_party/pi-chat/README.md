# pi-chat (vendored subset)

- Source: https://github.com/earendil-works/pi-chat
- Commit: `9adbd29b40ee27ff1decf0fc87cbe180b40924f5`
- License: Apache-2.0 (see `LICENSE` in this directory)

This directory carries the conversation runtime that pi-agent-substrate builds
on. Files are copied verbatim unless listed below. Modified files start with a
`Modified from ...` comment.

## Copied files

```
types.ts
src/core/config-types.ts      modified
src/core/runtime-types.ts     modified
src/core/discovery-types.ts
src/config.ts
src/log.ts
src/runtime.ts                modified
src/live/types.ts
src/render/chunking.ts
src/render/format.ts
```

The Discord and Telegram adapters (`src/live/discord.ts`, `src/live/telegram.ts`,
`src/live/common.ts`, `src/live/index.ts`) are not copied yet. M1 only needs the
channel interface; the real adapters arrive with the channel milestone.
`src/services`, `src/gondolin.ts`, `src/secrets.ts`, and the TUI are not copied.

## Modifications

`src/core/config-types.ts`

- Adds the `"test"` service and `TestAccountConfig` so test-channel
  conversations use the runtime unchanged. The test adapter itself lives under
  `test/support/` and is not part of the shipped source.

`src/core/runtime-types.ts`

- Adds `JobDispatchedRecord`, `JobDeliveryState`, and the corresponding unions.
  A dispatch record stores the request id that survives a gateway restart.

`src/runtime.ts`

- `ingestInbound` returns the queued `PendingJob`.
- Adds `beginJob`, `listUnfinishedJobs`, `getJobState`, `appendJobDispatched`,
  `recordOutbound`, `recordJobCompleted`, `acknowledgeJobCompleted`, and
  `recordJobFailed`.
- Splits `completeActiveJob` into an outbound write and a completion write so a
  crash between them can be reproduced and recovered.
