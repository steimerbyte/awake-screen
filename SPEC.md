# Awake Screen — implementation contract

Chrome/Chromium extension (MV3). Goal: websites must not be able to tell that the
tab is hidden, unfocused or on a turned-off screen, so media keeps playing in the
background.

Extension ID (pinned by `key` in `manifest.json`, do not change):
`mgjpkcpohocclkjkggoaphjdodgmhaja`

## File ownership

| File | Owner |
|---|---|
| `manifest.json` | integration (do not edit) |
| `src/main-world.js` | worker `mainworld` |
| `src/bridge.js`, `popup/popup.html`, `popup/popup.css`, `popup/popup.js` | worker `bridgeui` |
| `icons/*.png`, `tools/make-icons.py`, `README.md` | worker `assets` |
| `test/page.html`, `test/verify.mjs` | integration |

Plain ES2020 in content scripts, no modules, no bundler, no build step. Files are
loaded verbatim by Chrome.

## Storage contract (`chrome.storage.sync`)

```json
{
  "enabled": true,
  "strictFocus": true,
  "resumeGuard": true,
  "batterySpoof": true,
  "blocklist": []
}
```

All keys optional; missing means the default shown above. `blocklist` is an array
of bare hostnames (`example.com`, no scheme, no wildcard) where protection is
**off**. A host matches a blocklist entry when it equals it or ends with
`"." + entry`.

## Bridge → main world contract

`src/bridge.js` (ISOLATED world, `document_start`, all frames) computes the
effective config for `location.hostname`:

```
active       = enabled !== false && !blocked(hostname)
strictFocus  = strictFocus !== false
resumeGuard  = resumeGuard !== false
batterySpoof = batterySpoof !== false
```

and publishes exactly this JSON to the page's main world:

```js
document.documentElement.dataset.awakeCfg = JSON.stringify({
  active, strictFocus, resumeGuard, batterySpoof
});
document.dispatchEvent(new Event("awake:cfg"));
```

Why an attribute and not `CustomEvent.detail`: attribute strings cross the
isolated/main world boundary reliably, object payloads do not.

The bridge re-publishes on `chrome.storage.onChanged`, on `pageshow` (bfcache
restore) and on `DOMContentLoaded` (in case `<html>` did not exist yet at
`document_start` — if it did not, retry in a `MutationObserver`/immediate loop
until it does). It must never throw: wrap the whole body in try/catch.

## Main world contract (`src/main-world.js`)

Single IIFE, idempotent (`if (window.__AWAKE__) return;`). It installs the
guards **immediately** at `document_start` with `active: true` defaults, then
applies the bridge config when it arrives (and re-applies on every later event).
Every getter and hook reads the live `state` object, so toggling on/off takes
effect without a reload.

Capture the native accessors before patching and expose:

```js
window.__AWAKE__ = {
  version: "1.0.0",
  state,                       // live config object
  realHidden() { ... },        // native document.hidden, unpatched
  realVisibilityState() { ... },// native document.visibilityState, unpatched
  status() { return { active, visibilityState, hidden, hasFocus, real: {hidden, visibilityState} }; }
};
```

Guards, in this precedence order:

1. **Always installed** (used by every guard, independent of config):
   store `originalHidden` / `originalVisibilityState` getters from
   `Object.getOwnPropertyDescriptor(Document.prototype, "hidden" | "visibilityState")`
   (also the `webkit` prefixed ones when present).
2. **`active`** — patch on `Document.prototype`:
   - `hidden` → `false`, `visibilityState` → `"visible"`
   - `webkitHidden` → `false`, `webkitVisibilityState` → `"visible"` (only if the
     native accessor exists)
   - `hasFocus()` on `Document.prototype` → `true`
   - `wasDiscarded` on `Document.prototype` → `false` (only if native exists)
   The patched getter must return the native value when `!state.active`.
   Mask the fakes: give each patched function an own `toString` that returns
   `function get hidden() { [native code] }` (respective name) so a naive
   `String(document.__lookupGetter__("hidden"))` does not leak the patch.
3. **`strictFocus`** — drop the hidden/focus event pipeline:
   - one capture-phase listener on `window` for
     `visibilitychange`, `webkitvisibilitychange`, `mozvisibilitychange`,
     `msvisibilitychange`, `pagehide`, `freeze` → `stopImmediatePropagation()`
     plus `preventDefault()`; registered at `document_start` so it runs before
     any page listener.
   - same for `blur` and `focusout` **only** when
     `e.target === window || e.target === document` — never for element events,
     otherwise input validation and menus break.
   - `document.onvisibilitychange` / `window.onpagehide` assignment is left
     alone; suppressing dispatch is enough.
   Only active while `state.active && state.strictFocus`.
4. **`resumeGuard`** — resume media that was paused because the document is
   hidden. Chrome suspends background media itself, firing `pause` on the
   element without dispatching any event the page can observe, so the trigger
   must be real play state, not timing:
   - document-level capture listeners for `play`, `playing` and `pause` on media
     elements (media events do not bubble but they do capture).
   - `wasPlaying` WeakSet: added on `play`/`playing`, removed on the first
     `pause`. Only an element currently believed to be playing is resumed, so a
     pause the user can see is never fought.
   - on `pause`, when `state.active && state.resumeGuard && realHidden()` and
     `!el.ended`, re-call `el.play().catch(() => {})` in `setTimeout(..., 0)`
     (never synchronously inside the pause handler).
   - `strikes` WeakMap: if an element is still `paused` 1200 ms after a resume,
     count a strike; three strikes retire the element. `playing` clears strikes.
   - a `userPausedAt` timestamp suppresses resuming for 1500 ms.
4b. **`resumeGuard`, Media Session half** — wrap
   `MediaSession.prototype.setActionHandler` so the page's own `pause`/`stop`
   handler stamps `userPausedAt` before it runs. That is what makes a lock-screen
   or headset pause win over the resume guard. The wrapper must forward the
   original handler's return value and mask as native.
5. **`batterySpoof`** — many players (Netflix) pause on low battery:
   define `navigator.getBattery` / `Navigator.prototype.getBattery` to resolve a
   `BatteryManager`-shaped object: `charging: true`, `level: 1`,
   `chargingTime: 0`, `dischargingTime: Infinity`, plus `onchargingchange`,
   `onlevelchange`, `onchargingtimechange`, `ondischargingtimechange` null
   properties and `addEventListener`/`removeEventListener` (an `EventTarget`
   subclass instance is the simplest way). Return the real promise when
   `!state.active || !state.batterySpoof`.

Rules for all guards: never throw, never break the original semantics when a
guard is off, no `setInterval`, no polling, no network access, no `console.log`
in the happy path.

## Popup contract (`popup/`)

Read/write `chrome.storage.sync` directly, no service worker, no messaging
needed (the bridge reacts to `storage.onChanged`).

- Header: icon + "Awake Screen" + short subtitle.
- Master switch: `enabled`.
- Current-site row: hostname from
  `chrome.tabs.query({active: true, currentWindow: true})` (`tab.url`); a switch
  that adds/removes the host from `blocklist`. When `url` is unavailable
  (chrome://, file://, store pages) render the row disabled with the note
  "not applicable on this page".
- Advanced switches: `strictFocus`, `resumeGuard`, `batterySpoof`, each with one
  short explanatory line.
- Footer: "Applied on next page load and live on open tabs." + version from
  `chrome.runtime.getManifest().version`.
- Writes are debounced-free, direct `chrome.storage.sync.set({key: value})` on
  toggle; the UI state is the source of truth after a `get` on `DOMContentLoaded`.
- Dark UI, system font stack, no external resources, no inline event handlers
  (CSP: MV3 forbids inline scripts). Width ~320px.

## Icons

`tools/make-icons.py` (Pillow, available) generates `icons/16.png`,
`32.png`, `48.png`, `128.png`: a rounded square in `#0B1220`-ish dark with a
crescent/sun motif in `#22D3EE`, transparent background outside the rounded
square. Running the script twice must produce byte-identical files (no
timestamps: pass no PNG metadata chunks).

## Verification (integration, not a worker task)

`test/verify.mjs` launches the real Chromium with `--load-extension`, serves
`test/page.html` from two hosts (one blocklisted, one allowed), backgrounds the
tabs through CDP and compares what each page can observe. It must stay honest:
every assertion measures the running browser, none reads the extension's own
opinion about its state.
