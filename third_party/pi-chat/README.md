# pi-chat (vendored subset)

- Source: https://github.com/earendil-works/pi-chat
- Commit: `9adbd29b40ee27ff1decf0fc87cbe180b40924f5`
- License: Apache-2.0 (see `LICENSE` and `NOTICE` in this directory)
- The upstream README still says MIT, but the LICENSE file added in the pinned
  commit and `package.json` both say Apache-2.0. The LICENSE file governs.

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
`src/live/common.ts`, `src/live/index.ts`) are not copied: only the channel
interface is needed, and this repository's own adapters implement it under
`src/channel/`. `src/services`, `src/gondolin.ts`, `src/secrets.ts`, and the TUI
are not copied.

## Modifications

`src/core/config-types.ts`

- Adds the `"test"` service and `TestAccountConfig` so test-channel
  conversations use the runtime unchanged. The test adapter itself lives under
  `test/support/` and is not part of the shipped source.

`src/core/runtime-types.ts`

- Adds `JobDispatchedRecord`, `JobDeliveryState`, and the corresponding unions.
  A dispatch record stores the request id that survives a gateway restart.

`src/render/format.ts`

- Keeps the upstream Vercel Chat SDK attribution comment and points at the
  full MIT notice in the repository's `THIRD_PARTY_NOTICES.md`.

`src/runtime.ts`

- `ingestInbound` returns the queued `PendingJob`.
- Adds `beginJob`, `listUnfinishedJobs`, `getJobState`, `appendJobDispatched`,
  `recordOutbound`, `recordJobCompleted`, `acknowledgeJobCompleted`, and
  `recordJobFailed`.
- Splits `completeActiveJob` into an outbound write and a completion write so a
  crash between them can be reproduced and recovered.
