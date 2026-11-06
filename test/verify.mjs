#!/usr/bin/env bun
// End-to-end proof for the Awake Screen extension.
//
// Runs the real Chromium from the Playwright cache with --load-extension, serves
// test/page.html under two hostnames of one origin server, and compares them:
//
//   localhost   -> protection ON   (default config)
//   127.0.0.1   -> protection OFF  (seeded into the blocklist via the popup page)
//
// Both tabs are driven through raw CDP. Only one tab per window is genuinely
// visible, so the blocked tab always reports the *real* state and the protected
// tab must keep reporting the fake one. That differential is the proof; nothing
// here depends on the extension's own opinion about its state.
//
// Usage: bun test/verify.mjs [--headed]
//        EXT_DIR=/path/to/unpacked bun test/verify.mjs   (verify a packaged build)

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
// Optional: verify a packaged artifact instead of the working tree.
const EXT_DIR = process.env.EXT_DIR || ROOT;
const EXT_ID = "mgjpkcpohocclkjkggoaphjdodgmhaja";
const HEADED = process.argv.includes("--headed");
const MEDIA = join(tmpdir(), "awake-ext-loop.webm");
const BLOCKED_HOST = "127.0.0.1";
const OPEN_HOST = "localhost";

const results = [];
function check(name, got, want, note = "") {
  const ok = typeof want === "function" ? want(got) : Object.is(got, want);
  results.push({ name, got, want: typeof want === "function" ? "predicate" : want, ok, note });
  return ok;
}
const predicate = (label, fn) => Object.assign(fn, { toString: () => label });

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(process.env.HOME || "/root", ".cache/ms-playwright");
  if (!existsSync(base)) throw new Error(`no Playwright cache at ${base}`);
  const dirs = readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const p = join(base, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("no chromium binary found");
}
// ---------- media fixture: a real, file-backed, audible, looping clip ----------
const ffmpeg = Bun.spawnSync([
  "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
  "-c:a", "libopus", "-b:a", "24k", MEDIA,
]);
if (ffmpeg.exitCode !== 0) {
  throw new Error(`ffmpeg failed: ${ffmpeg.stderr.toString()}`);
}
const media = await readFile(MEDIA);

// ---------- static server ----------
const page = await readFile(join(ROOT, "test/page.html"));
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/page.html") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/loop.webm") {
      return new Response(media, { headers: { "content-type": "video/webm" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const PORT = server.port;

// ---------- CDP client ----------
class Conn {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      }
      if (msg.method === "Log.entryAdded") this.logs.push(msg.params.entry);
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.logs.push({
          source: "console",
          level: "error",
          text: msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
          url: msg.params.stackTrace?.callFrames?.[0]?.url || "",
        });
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 20000);
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(new Conn(ws)));
    ws.addEventListener("error", (e) => reject(new Error(`ws failed: ${e.message || url}`)));
  });
}

async function waitFor(fn, { timeout = 20000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${label}`);
    await Bun.sleep(interval);
  }
}

// ---------- run ----------
const chrome = findChrome();
const profile = await mkdtemp(join(tmpdir(), "awake-ext-"));
const args = [
  HEADED ? "--headless=false" : "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--autoplay-policy=no-user-gesture-required",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  "about:blank",
];

let proc, conn;
const tabs = {};
try {
  proc = Bun.spawn([chrome, ...args], { stdout: "pipe", stderr: "pipe" });
  const portFile = join(profile, "DevToolsActivePort");
  const [port, browserPath] = await waitFor(
    async () => {
      if (!existsSync(portFile)) return null;
      const text = await readFile(portFile, "utf8");
      const [p, b] = text.trim().split("\n");
      return p && b ? [p, b] : null;
    },
    { label: "DevToolsActivePort", timeout: 30000 },
  );
  conn = await connect(`ws://127.0.0.1:${port}${browserPath}`);

  async function openTab(url) {
    const { targetId } = await conn.send("Target.createTarget", { url, newWindow: false });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Runtime.enable", {}, sessionId);
    await conn.send("Log.enable", {}, sessionId);
    await conn.send("Emulation.setDeviceMetricsOverride",
      { width: 420, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    return { targetId, sessionId };
  }
  const evalIn = async (tab, expression, awaitPromise = false) => {
    const r = await conn.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      tab.sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result.value;
  };
  const waitLoaded = (tab) =>
    waitFor(async () => {
      try {
        return (await evalIn(tab, "document.readyState")) === "complete" ? true : null;
      } catch {
        return null;
      }
    }, { label: "document load" });

  // 1. seed the blocklist through a page that has extension privileges
  const popup = await openTab(`chrome-extension://${EXT_ID}/popup/popup.html`);
  await waitLoaded(popup);
  await evalIn(popup, `chrome.storage.sync.clear()`);
  await evalIn(
    popup,
    `chrome.storage.sync.set({ blocklist: ["${BLOCKED_HOST}"] })`,
    true,
  );
  const seeded = await evalIn(popup, `chrome.storage.sync.get(null)`, true);
  check("storage seeded", seeded, predicate("blocklist contains 127.0.0.1", (v) =>
    Array.isArray(v?.blocklist) && v.blocklist.includes("127.0.0.1")));

  // 2. the control tab (protection off) and the protected tab
  tabs.blocked = await openTab(`http://${BLOCKED_HOST}:${PORT}/page.html`);
  tabs.open = await openTab(`http://${OPEN_HOST}:${PORT}/page.html`);
  await waitLoaded(tabs.blocked);
  await waitLoaded(tabs.open);
  await Bun.sleep(600);

  const awakeBlocked = await evalIn(tabs.blocked, "Boolean(window.__AWAKE__)");
  check("main-world script ran on blocked host", awakeBlocked, true,
    "content script still injects; it must report active:false");
  const blockedState = await evalIn(tabs.blocked, "JSON.parse(JSON.stringify(window.__AWAKE__.state))");
  check("blocked host resolves active:false", blockedState.active, false);

  const awakeOpen = await evalIn(tabs.open, "Boolean(window.__AWAKE__)");
  check("main-world script ran on protected host", awakeOpen, true);
  const openState = await evalIn(tabs.open, "JSON.parse(JSON.stringify(window.__AWAKE__.state))");
  check("protected host resolves active:true", openState.active, true);

  // 3. background the control tab: Chrome must report it hidden (environment sanity)
  await conn.send("Target.activateTarget", { targetId: tabs.open.targetId });
  await Bun.sleep(1500);
  const control = await evalIn(tabs.blocked, "JSON.parse(JSON.stringify(window.__snapshot()))");
  check("control: real visibilityState is hidden", control.visibilityState, "hidden",
    "proves the browser really backgrounds a non-active tab");
  check("control: document.hidden is true", control.hidden, true);
  check("control: visibilitychange reached the page", control.vcFired,
    predicate(">= 1", (v) => v >= 1));
  check("control: site could pause its own media", control.videoPaused, true);

  // 4. background the protected tab and read what the site can see
  await conn.send("Target.activateTarget", { targetId: tabs.blocked.targetId });
  await Bun.sleep(2000);
  const prot = await evalIn(tabs.open, "JSON.parse(JSON.stringify(window.__snapshot()))");
  check("protected: native state really is hidden", prot.realHidden, true,
    "the underlying document is hidden; only the public API is spoofed");
  check("protected: document.visibilityState", prot.visibilityState, "visible");
  check("protected: document.hidden", prot.hidden, false);
  check("protected: document.webkitHidden", prot.webkitHidden, false);
  check("protected: document.hasFocus()", prot.hasFocus, true);
  check("protected: document.wasDiscarded", prot.wasDiscarded, false);
  check("protected: visibilitychange never reached the page", prot.vcFired, 0);
  check("protected: window blur never reached the page", prot.winBlurFired, 0);
  check("protected: media still playing", prot.videoPaused, false);
  check("protected: media time advanced", prot.videoTime,
    predicate("> 0", (v) => v > 0),
    `paused=${prot.videoPaused} readyState=${prot.videoReadyState}`);
  check("protected: patched getter masks as native", prot.getterLooksNative, true);

  // Regression for the defect this harness found: Chrome suspends background
  // media natively ~2 s after the tab is hidden, firing `pause` with no event the
  // page ever sees. The guard must produce a `play` after that `pause`.
  const timeline = prot.timeline.split(" ").filter(Boolean);
  const pausedAt = timeline.findIndex((t) => t.startsWith("pause@"));
  check("protected: hide-transition pause was compensated",
    timeline.slice(pausedAt + 1).some((t) => t.startsWith("play@")),
    true, `timeline: ${prot.timeline}`);
  check("protected: __AWAKE__ present", prot.awake, true);
  check("protected: version", prot.awakeVersion, "1.0.0");

  const battery = await evalIn(tabs.open,
    "window.__readBattery().then(b => JSON.parse(JSON.stringify(b)))", true);
  check("protected: getBattery reports charging", battery.charging, true);
  check("protected: getBattery reports full level", battery.level, 1);
  check("protected: getBattery reports Infinity dischargingTime",
    battery.dischargingTime, "Infinity");

  // 5. a pause the user can see must never be fought
  await conn.send("Target.activateTarget", { targetId: tabs.open.targetId });
  await Bun.sleep(500);
  const visible = await evalIn(tabs.open, "document.visibilityState");
  check("foregrounded tab reports visible", visible, "visible");
  await evalIn(tabs.open, "document.getElementById('vid').pause()");
  await Bun.sleep(900);
  const afterPause = await evalIn(tabs.open,
    "JSON.parse(JSON.stringify({ paused: document.getElementById('vid').paused," +
    " time: document.getElementById('vid').currentTime }))");
  check("visible pause is not resurrected", afterPause.paused, true,
    `time: ${afterPause.time}`);

  // 6. media session handler registration stays callable and disguised
  const msInstalled = await evalIn(tabs.open,
    "typeof navigator.mediaSession.setActionHandler === 'function' &&" +
    " (navigator.mediaSession.setActionHandler('pause', () => {}), true) &&" +
    " /\\[native code\\]/.test(String(navigator.mediaSession.setActionHandler))");
  check("media session pause handler registers, patch masked", msInstalled, true);

  // 7. popup page: renders the required controls and writes storage
  const popupText = await evalIn(popup, "document.body.innerText");
  for (const label of ["Protect all sites", "Hide focus and blur", "Resume paused media",
                       "Report full battery"]) {
    check(`popup shows "${label}"`, popupText.includes(label), true);
  }
  check("popup shows the extension version", popupText.includes("1.0.0"), true);

  const boxes = await evalIn(popup,
    "Array.from(document.querySelectorAll('input[type=checkbox]')).length");
  check("popup renders its switches", boxes, predicate(">= 5", (v) => v >= 5));

  const fmt = (s) => JSON.stringify(s, Object.keys(s).sort());
  const stateBefore = fmt(await evalIn(popup, "chrome.storage.sync.get(null)", true));
  await evalIn(popup, "document.querySelector('input[type=checkbox]').click()");
  await Bun.sleep(250);
  const stateAfter = fmt(await evalIn(popup, "chrome.storage.sync.get(null)", true));
  check("popup switch persists to chrome.storage.sync", stateBefore !== stateAfter, true);
  await evalIn(popup, "document.querySelector('input[type=checkbox]').click()");
  await Bun.sleep(250);

  const restored = await evalIn(popup, "chrome.storage.sync.get(null)", true);
  check("popup restored the master switch", restored.enabled, true);
  check("popup left the blocklist untouched",
    JSON.stringify(restored.blocklist), JSON.stringify(["127.0.0.1"]));

  // 8. current-site row: opened with a stubbed chrome.tabs.query so the popup
  // believes it belongs to a normal https tab. Exercises the blocklist path that
  // the popup-as-a-tab rendering above cannot reach.
  const siteTab = await openTab("about:blank");
  await conn.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const stub = () => Promise.resolve([
        { url: "https://www.example.com/watch?v=abc", active: true }
      ]);
      try {
        Object.defineProperty(chrome.tabs, "query", {
          value: stub, configurable: true, writable: true
        });
      } catch (e) {
        try { chrome.tabs.query = stub; } catch (e2) {}
      }
    })();`,
  }, siteTab.sessionId);
  await conn.send("Page.navigate",
    { url: `chrome-extension://${EXT_ID}/popup/popup.html` }, siteTab.sessionId);
  await waitLoaded(siteTab);
  await Bun.sleep(500);

  const siteText = await evalIn(siteTab, "document.body.innerText");
  check("popup shows the current site host", siteText.includes("www.example.com"), true);
  check("popup hides the not-applicable note",
    await evalIn(siteTab, "document.getElementById('siteNote').hidden"), true);
  check("site switch reflects protection being on",
    await evalIn(siteTab, "document.getElementById('siteOff').checked"), false);

  await evalIn(siteTab, "document.getElementById('siteOff').click()");
  await Bun.sleep(300);
  const offFor = await evalIn(siteTab, "chrome.storage.sync.get(null)", true);
  check("site switch adds the host to the blocklist",
    (offFor.blocklist || []).includes("www.example.com"), true,
    JSON.stringify(offFor.blocklist));

  await evalIn(siteTab, "document.getElementById('siteOff').click()");
  await Bun.sleep(300);
  const onAgain = await evalIn(siteTab, "chrome.storage.sync.get(null)", true);
  check("site switch removes the host again",
    (onAgain.blocklist || []).includes("www.example.com"), false,
    JSON.stringify(onAgain.blocklist));

  // 9. extension-side errors
  const extLogs = conn.logs.filter((l) => (l.url || "").includes("chrome-extension://"));
  check("no extension errors in the log", extLogs.length, 0,
    extLogs.map((l) => l.text).join(" | ").slice(0, 300));

  // 10. screenshot of the popup for visual review
  await conn.send("Target.activateTarget", { targetId: popup.targetId });
  await Bun.sleep(400);
  const shot = await conn.send("Page.captureScreenshot", { format: "png" }, popup.sessionId);
  await writeFile(join(ROOT, "docs/screenshots/01-popup.png"), Buffer.from(shot.data, "base64"));
} finally {
  try { conn?.ws.close(); } catch {}
  try { proc?.kill(); } catch {}
  try { await server.stop(true); } catch {}
  try { await rm(profile, { recursive: true, force: true }); } catch {}
  try { await rm(MEDIA, { force: true }); } catch {}
}

// ---------- report ----------
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const width = Math.max(...results.map((r) => r.name.length)) + 2;
console.log("");
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  const got = JSON.stringify(r.got) ?? String(r.got);
  console.log(`${mark}  ${pad(r.name, width)} ${got}${r.ok ? "" : `   (wanted ${r.want})`}`);
  if (!r.ok && r.note) console.log(`      note: ${r.note}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
