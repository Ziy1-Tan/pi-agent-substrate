# Third-Party Notices

This project is licensed under Apache-2.0 (see `LICENSE`). The notices below
cover code copied into this repository. They do not modify the upstream
licenses.

## pi-chat

- Repository: https://github.com/earendil-works/pi-chat
- Commit: `9adbd29b40ee27ff1decf0fc87cbe180b40924f5`
- License: Apache-2.0. The pinned commit added `LICENSE` and set
  `package.json` to Apache-2.0; its README still says MIT, but the LICENSE file
  is the authoritative text.
- Derived code: `src/host/conversation/store.ts` adapts the conversation log,
  lock, and attachment handling from that commit's `src/runtime.ts` and
  `src/log.ts`, and says so at the top of the file. The log record format in
  `src/host/conversation/records.ts` stays readable from logs that runtime
  wrote. Nothing else from pi-chat remains in this repository.

## always-on-agent

Not vendored. `src/host/substrate/` follows its split into an actor
provisioner, an idle suspender, and a control-plane client, but shares no code
with it.
