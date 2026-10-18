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
- Location: `third_party/pi-chat/`
- Vendored files and changes: see `third_party/pi-chat/README.md`
- Upstream NOTICE file: none. `third_party/pi-chat/NOTICE` records the source
  and the pinned commit.

## Vercel Chat SDK (MIT)

`third_party/pi-chat/src/render/format.ts` contains formatting logic adapted
from Vercel Chat SDK. The file retains the upstream attribution comment.

MIT License

Copyright (c) 2026 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## always-on-agent

Not vendored yet. The lifecycle components (`idle-suspender`, `actor-router`,
`actor-provisioner`, control-plane client) are planned for a later milestone.
