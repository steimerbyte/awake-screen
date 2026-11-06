// Popup: reads and writes chrome.storage.sync directly. Every bridge instance in
// every tab reacts to storage.onChanged, so no messaging and no service worker.
(() => {
  "use strict";

  // Storage contract: a missing key means "on", so only an explicit false turns a switch off.
  const SWITCH_KEYS = ["enabled", "strictFocus", "resumeGuard", "batterySpoof"];

  const el = {};
  let blocklist = [];
  let host = "";

  function byId(id) {
    return document.getElementById(id);
  }

  function save(values) {
    try {
      const pending = chrome.storage.sync.set(values);
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {
      // Storage unavailable: leave the UI as the user left it.
    }
  }

  function renderEnabled() {
    document.body.classList.toggle("off", !el.enabled.checked);
  }

  function renderSite() {
    const usable = host !== "";
    el.siteHost.textContent = usable ? host : "This page";
    el.siteHost.title = usable ? host : "";
    el.siteNote.hidden = usable;
    el.siteRow.classList.toggle("inert", !usable);
    el.siteOff.disabled = !usable;
    el.siteOff.checked = usable && blocklist.indexOf(host) !== -1;
  }

  function toggleSite(blocked) {
    if (host === "") return;
    blocklist = blocklist.filter((entry) => entry !== host);
    if (blocked) blocklist.push(host);
    el.siteOff.checked = blocked;
    save({ blocklist: blocklist });
  }

  // Only http(s) points at a host the bridge can act on: chrome://, file://,
  // extension pages and the Web Store get the disabled row.
  function readHost(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return parsed.hostname.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  async function currentHost() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      return tab && tab.url ? readHost(tab.url) : "";
    } catch (_) {
      return "";
    }
  }

  async function init() {
    el.enabled = byId("enabled");
    el.siteRow = byId("siteRow");
    el.siteHost = byId("siteHost");
    el.siteNote = byId("siteNote");
    el.siteOff = byId("siteOff");
    el.strictFocus = byId("strictFocus");
    el.resumeGuard = byId("resumeGuard");
    el.batterySpoof = byId("batterySpoof");

    el.enabled.addEventListener("change", () => {
      save({ enabled: el.enabled.checked });
      renderEnabled();
    });
    for (const key of ["strictFocus", "resumeGuard", "batterySpoof"]) {
      el[key].addEventListener("change", () => save({ [key]: el[key].checked }));
    }
    el.siteOff.addEventListener("change", () => toggleSite(el.siteOff.checked));

    let stored = {};
    try {
      stored = (await chrome.storage.sync.get(null)) || {};
    } catch (_) {
      stored = {};
    }

    for (const key of SWITCH_KEYS) el[key].checked = stored[key] !== false;
    blocklist = Array.isArray(stored.blocklist)
      ? stored.blocklist.filter((entry) => typeof entry === "string")
      : [];

    renderEnabled();
    renderSite();
    byId("version").textContent = chrome.runtime.getManifest().version;

    const resolved = await currentHost();
    if (resolved) {
      host = resolved;
      renderSite();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
