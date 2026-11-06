# Changelog

## 1.0.0 — 2026-11-06

First release.

- Visibility spoof on `Document.prototype`: `hidden`, `visibilityState`, the `webkit` accessors, `hasFocus()` and `wasDiscarded`, with the native accessors captured first and restored when protection is off.
- Capture-phase suppression of `visibilitychange` (all vendor prefixes), `pagehide`, `freeze`, and window/document-level `blur` and `focusout`.
- Media resume guard that tracks real play state. Fixes the defect the harness found: Chrome suspends background media natively and fires `pause` with no event the page can observe (measured `pause@2123`), so a timing-based guard never fired. Resumes are capped at three failed attempts per element.
- Media Session guard: the page's own `pause`/`stop` action handler is wrapped, so a lock-screen or headset pause is honoured.
- Battery spoof via `navigator.getBattery()`.
- Popup with master switch, current-site blocklist switch and three advanced guards; no service worker, changes propagate through `chrome.storage.onChanged`.
- Verification harness: 44 assertions against real Chromium, two hostnames of one server, both tabs backgrounded through raw CDP.
