# Source provenance

Project: https://github.com/samuelmaddock/electron-browser-shell

Commit: 3817c4236f8511156086eb4541f364679b277b40

Source: packages/shell/browser/tabs.js, Tab class.

License: MIT, Copyright (c) 2021 Samuel Maddock. Full text in LICENSE.

pageView.ts retains the upstream WebContentsView adoption, parent ownership,
resize listener, layout and disposal design. Changes: TypeScript; single page;
content-area geometry; variable toolbar height; no synthetic destroyed event;
use public webContents.close API; idempotent cleanup. No extensions are bundled.

The original chrome.tabs-based UI cannot run without the upstream extension
emulation. The local toolbar uses the existing host's narrowly scoped IPC instead.
