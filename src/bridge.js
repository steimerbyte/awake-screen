// Isolated-world bridge: publishes the effective config for this frame's host to
// the main world. The main world cannot reach chrome.storage, so the config
// travels as a DOM attribute — strings cross the world boundary reliably, objects
// do not.
(() => {
  "use strict";

  try {
    const host = location.hostname;
    let current = {};
    let rootWatcher = null;

    function isBlocked() {
      const list = current.blocklist;
      if (!Array.isArray(list)) return false;
      for (let i = 0; i < list.length; i++) {
        if (typeof list[i] !== "string") continue;
        const entry = list[i].trim().toLowerCase();
        if (!entry) continue;
        // Equality or a real label boundary: "notexample.com" must not match "example.com".
        if (host === entry || host.endsWith("." + entry)) return true;
      }
      return false;
    }

    // Single write point. Guarded here so every caller can stay plain.
    function publish() {
      try {
        const root = document.documentElement;
        if (!root) {
          watchRoot();
          return;
        }
        root.dataset.awakeCfg = JSON.stringify({
          active: current.enabled !== false && !isBlocked(),
          strictFocus: current.strictFocus !== false,
          resumeGuard: current.resumeGuard !== false,
          batterySpoof: current.batterySpoof !== false
        });
        document.dispatchEvent(new Event("awake:cfg"));
      } catch (_) {
        // A broken bridge must never break the page.
      }
    }

    // document_start can run before <html> exists; publish as soon as it does.
    function watchRoot() {
      if (rootWatcher) return;
      try {
        const observer = new MutationObserver(() => {
          if (!document.documentElement) return;
          observer.disconnect();
          if (rootWatcher === observer) rootWatcher = null;
          publish();
        });
        observer.observe(document, { childList: true, subtree: true });
        rootWatcher = observer;
      } catch (_) {
        // DOMContentLoaded still publishes when observing is impossible.
      }
    }

    function adopt(values) {
      current = values && typeof values === "object" ? values : {};
      publish();
    }

    function load() {
      try {
        const pending = chrome.storage.sync.get(null);
        // Chrome 139+ returns a promise, older releases take a callback only.
        if (pending && typeof pending.then === "function") {
          pending.then(adopt, () => adopt(null));
        } else {
          adopt(null);
        }
      } catch (_) {
        adopt(null); // Defaults are still worth publishing.
      }
    }

    function onStorageChanged(changes, area) {
      try {
        if (area !== "sync") return;
        for (const key in changes) current[key] = changes[key].newValue;
      } catch (_) {
        current = {};
      }
      publish();
    }

    load();

    try {
      chrome.storage.onChanged.addListener(onStorageChanged);
    } catch (_) {
      // No storage API: keep the defaults published by load().
    }

    window.addEventListener("pageshow", publish);
    document.addEventListener("DOMContentLoaded", publish);
  } catch (_) {
    // Last resort: never leave an exception behind at document_start.
  }
})();
