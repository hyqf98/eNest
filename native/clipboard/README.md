# Bundled clipboard helpers

`npm run native:build` builds the helper for the current build platform. `npm run dev` and `npm run build` invoke it automatically. `electron-builder.yml` copies only the target platform's files from `native/bin` into the app's `native` resources directory; the after-pack hook rejects missing/wrong binary architectures. A macOS helper cannot stand in for the Linux ELF bundle. End users do not install helper tools themselves. Build tools are development/CI dependencies only.

The host owns a long-lived subprocess using newline-delimited JSON. Commands are a fixed whitelist (`capabilities`, `requestPermission`, `target`, `source`, `readFiles`, `writeFiles`, `paste`); clipboard contents never become executable code. Every request has a deadline. Timeout kills the helper so an expired paste cannot run later. App exit closes it. While a portal permission request is pending, background polls pause instead of timing out and terminating the authorization flow.

`target` returns an opaque token for the helper's captured window. Plugins never receive or provide it. The host captures before showing Quick and sends only that token back. The host rejects an old target after 30 minutes. Helper restart invalidates all tokens. If paste fails after Quick was hidden, its current plugin view is restored so the manual-paste message remains visible.

| Platform | File references | Reliable source | Paste target |
| --- | --- | --- | --- |
| macOS | NSPasteboard file URLs | No public reliable owner API; unknown | AX focused window and element, application launch identity; Cmd+V only after original window is restored |
| Windows | WinForms file-drop list | GetClipboardOwner process when readable | Captured HWND + process start time; foreground HWND verified before SendInput; UIPI failure degrades |
| Linux X11 | URI MIME / selection transfer | Selection owner / WM_CLASS when available | Captured XID + PID start identity; XTest only after restoring and checking focus |
| Linux Wayland | Electron MIME or authorized Clipboard/FileTransfer portal | Unknown | Manual paste; general portals do not expose original window identity and restoration |

Source detection and file references are independent of paste authorization. Invalid files remain visible as stale references, and file deletion is never performed by history cleanup. macOS prompts for Accessibility only when explicitly requested. Windows elevated targets may refuse SendInput. For Linux backend requirements and bundle instructions see [LINUX.md](LINUX.md).

macOS builds use Objective-C and system frameworks, producing a universal arm64/x86_64 executable. Windows uses the packaged fixed PowerShell script with the operating system's Windows PowerShell/.NET, not arbitrary submitted scripts. Linux builds must run on the intended architecture and an appropriately old compatible glibc builder; cross-packing a macOS helper into Linux is unsupported.

## Validation

- `ENEST_NATIVE_CLIPBOARD=1 node --test native/clipboard/tests/mac.integration.test.mjs`: real Cocoa fixture, file clipboard read/write, two windows in the same app, verified paste into the original window, rejected unknown/destroyed targets. It restores the pre-test clipboard and prior active app; it never pastes into a user document.
- `node --test src/main/clipboard/clipboardFormats.test.mjs`: Unicode URI encoding, shell-like filenames as data, invalid URL and DROPFILES boundaries.
- Linux Xvfb and private D-Bus portal commands are documented in `LINUX.md`. They exercise actual X server/IPC protocols, but do not claim GNOME/KDE/Wayland end-user desktop acceptance.

On 2026-10-13, the macOS native fixture passed. Windows real desktop and Linux real desktop permission/focus checks remain required before claiming full platform acceptance. Helper capabilities intentionally report degraded behavior rather than guessing unavailable origins or windows.
