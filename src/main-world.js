/* Awake Screen — main-world guards. Runs at document_start, before page scripts. */
(function () {
  "use strict";

  try {
    if (window.__AWAKE__) return;

    var VERSION = "1.0.0";

    // Mutated in place: every getter below closes over this object.
    var state = {
      active: true,
      strictFocus: true,
      resumeGuard: true,
      batterySpoof: true
    };

    var docProto = Document.prototype;

    // Guard 1: native accessors, captured before any patch.
    var hiddenDesc = Object.getOwnPropertyDescriptor(docProto, "hidden") || null;
    var visibilityDesc = Object.getOwnPropertyDescriptor(docProto, "visibilityState") || null;
    var webkitHiddenDesc = Object.getOwnPropertyDescriptor(docProto, "webkitHidden") || null;
    var webkitVisibilityDesc =
      Object.getOwnPropertyDescriptor(docProto, "webkitVisibilityState") || null;
    var wasDiscardedDesc = Object.getOwnPropertyDescriptor(docProto, "wasDiscarded") || null;
    var hasFocusDesc = Object.getOwnPropertyDescriptor(docProto, "hasFocus") || null;

    function realHidden() {
      try {
        if (hiddenDesc && typeof hiddenDesc.get === "function") {
          return !!hiddenDesc.get.call(document);
        }
      } catch (e) {
        /* fall through */
      }
      return false;
    }

    function realVisibilityState() {
      try {
        if (visibilityDesc && typeof visibilityDesc.get === "function") {
          return visibilityDesc.get.call(document);
        }
      } catch (e) {
        /* fall through */
      }
      return "visible";
    }

    // Hides the patch from String(fn) and fn.name.
    function mask(fn, nativeName) {
      Object.defineProperty(fn, "toString", {
        configurable: true,
        writable: true,
        value: function () {
          return "function " + nativeName + "() { [native code] }";
        }
      });
      try {
        fn.name = nativeName;
      } catch (e) {
        /* name is not always configurable */
      }
      return fn;
    }

    // Reports fakeValue while state.active, the native value otherwise.
    // Skips prototypes that lack the accessor instead of defining a broken one.
    function patchGetter(proto, name, desc, fakeValue) {
      if (!desc || typeof desc.get !== "function") return;
      var get = mask(function () {
        if (state.active) return fakeValue;
        return desc.get.call(this);
      }, "get " + name);
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: desc.enumerable,
        get: get,
        set: desc.set
      });
    }

    // Guard 2: the page never sees a hidden document.
    function installVisibilityGuard() {
      patchGetter(docProto, "hidden", hiddenDesc, false);
      patchGetter(docProto, "visibilityState", visibilityDesc, "visible");
      patchGetter(docProto, "webkitHidden", webkitHiddenDesc, false);
      patchGetter(docProto, "webkitVisibilityState", webkitVisibilityDesc, "visible");
      patchGetter(docProto, "wasDiscarded", wasDiscardedDesc, false);

      if (hasFocusDesc && typeof hasFocusDesc.value === "function") {
        var nativeHasFocus = hasFocusDesc.value;
        var hasFocus = mask(function () {
          if (state.active) return true;
          return nativeHasFocus.apply(this, arguments);
        }, "hasFocus");
        Object.defineProperty(docProto, "hasFocus", {
          configurable: true,
          enumerable: hasFocusDesc.enumerable,
          writable: hasFocusDesc.writable,
          value: hasFocus
        });
      }
    }

    // Guard 3: drop the visibility/focus event pipeline in capture phase.
    function installFocusGuard() {
      var visibilityEvents = [
        "visibilitychange",
        "webkitvisibilitychange",
        "mozvisibilitychange",
        "msvisibilitychange",
        "pagehide",
        "freeze"
      ];

      var block = function (e) {
        if (!state.active || !state.strictFocus) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      };
      for (var i = 0; i < visibilityEvents.length; i++) {
        window.addEventListener(visibilityEvents[i], block, true);
      }

      // Window-level focus loss only: element blur/focusout must keep working.
      var blockWindowFocus = function (e) {
        if (!state.active || !state.strictFocus) return;
        if (e.target !== window && e.target !== document) return;
        e.stopImmediatePropagation();
        e.preventDefault();
      };
      window.addEventListener("blur", blockWindowFocus, true);
      window.addEventListener("focusout", blockWindowFocus, true);
    }

    // Set when the page's own Media Session "pause"/"stop" handler runs, so a
    // lock-screen pause is never fought by the resume guard.
    var userPausedAt = 0;

    // Guard 4: resume media that was paused because the document is hidden.
    // Chrome suspends background media natively: it fires `pause` on the element
    // without any event the page could observe, so tracking real play state is
    // the only reliable trigger. Measured need: a pause 2.2 s after the tab was
    // backgrounded must be resumed.
    function installResumeGuard() {
      var wasPlaying = new WeakSet();
      var strikes = new WeakMap();
      var recheckTimers = new WeakMap();

      var resume = function (el) {
        var p;
        try {
          p = el.play();
        } catch (e) {
          return;
        }
        if (p && typeof p.catch === "function") p.catch(function () {});
        recheckTimers.set(
          el,
          setTimeout(function () {
            recheckTimers.delete(el);
            if (!el.paused) return;
            // The resume did not stick: three strikes and the element is left alone.
            strikes.set(el, (strikes.get(el) || 0) + 1);
          }, 1200)
        );
      };

      document.addEventListener(
        "play",
        function (e) {
          if (e.target instanceof HTMLMediaElement) wasPlaying.add(e.target);
        },
        true
      );

      document.addEventListener(
        "playing",
        function (e) {
          var el = e.target;
          if (!(el instanceof HTMLMediaElement)) return;
          wasPlaying.add(el);
          strikes.delete(el);
          var t = recheckTimers.get(el);
          if (t) {
            clearTimeout(t);
            recheckTimers.delete(el);
          }
        },
        true
      );

      document.addEventListener(
        "pause",
        function (e) {
          var el = e.target;
          if (!(el instanceof HTMLMediaElement)) return;
          if (!wasPlaying.has(el)) return;
          wasPlaying.delete(el);
          if (!state.active || !state.resumeGuard) return;
          if (!realHidden() || el.ended) return;
          if (Date.now() - userPausedAt < 1500) return;
          if ((strikes.get(el) || 0) >= 3) return;
          // Deferred: calling play() inside the pause handler is racy.
          setTimeout(function () {
            resume(el);
          }, 0);
        },
        true
      );
    }

    // Guard 4b: the user's own pause (lock screen, headset button) must win.
    function installMediaSessionGuard() {
      var session = navigator.mediaSession;
      if (!session) return;
      var proto = Object.getPrototypeOf(session);
      var desc = proto && Object.getOwnPropertyDescriptor(proto, "setActionHandler");
      if (!desc || typeof desc.value !== "function") return;
      var nativeSetActionHandler = desc.value;

      var setActionHandler = mask(function (action, handler) {
        if (typeof handler === "function" && (action === "pause" || action === "stop")) {
          var wrapped = function () {
            userPausedAt = Date.now();
            return handler.apply(this, arguments);
          };
          return nativeSetActionHandler.call(this, action, wrapped);
        }
        return nativeSetActionHandler.apply(this, arguments);
      }, "setActionHandler");

      Object.defineProperty(proto, "setActionHandler", {
        configurable: true,
        enumerable: desc.enumerable,
        writable: desc.writable,
        value: setActionHandler
      });
    }

    // Guard 5: players that throttle on battery state.
    function installBatteryGuard() {
      var protoDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, "getBattery") || null;
      var target = null;
      var desc = null;

      if (protoDesc && typeof protoDesc.value === "function") {
        target = Navigator.prototype;
        desc = protoDesc;
      } else {
        var ownDesc = Object.getOwnPropertyDescriptor(navigator, "getBattery") || null;
        if (ownDesc && typeof ownDesc.value === "function") {
          target = navigator;
          desc = ownDesc;
        }
      }
      if (!target) return;

      var nativeGetBattery = desc.value;

      class FakeBatteryManager extends EventTarget {
        get charging() {
          return true;
        }
        get level() {
          return 1;
        }
        get chargingTime() {
          return 0;
        }
        get dischargingTime() {
          return Infinity;
        }
      }

      var fakeGetters = ["charging", "level", "chargingTime", "dischargingTime"];
      for (var i = 0; i < fakeGetters.length; i++) {
        var fakeDesc = Object.getOwnPropertyDescriptor(
          FakeBatteryManager.prototype,
          fakeGetters[i]
        );
        if (fakeDesc && typeof fakeDesc.get === "function") {
          mask(fakeDesc.get, "get " + fakeGetters[i]);
        }
      }

      var handlers = [
        "onchargingchange",
        "onlevelchange",
        "onchargingtimechange",
        "ondischargingtimechange"
      ];
      for (var j = 0; j < handlers.length; j++) {
        Object.defineProperty(FakeBatteryManager.prototype, handlers[j], {
          configurable: true,
          enumerable: true,
          writable: true,
          value: null
        });
      }

      var fakeBattery = null;
      var getBattery = mask(function () {
        if (!state.active || !state.batterySpoof) return nativeGetBattery.apply(this, arguments);
        if (!fakeBattery) fakeBattery = new FakeBatteryManager();
        return Promise.resolve(fakeBattery);
      }, "getBattery");

      Object.defineProperty(target, "getBattery", {
        configurable: true,
        enumerable: desc.enumerable,
        writable: desc.writable,
        value: getBattery
      });
    }

    try {
      installVisibilityGuard();
    } catch (e) {
      /* one failing guard must not block the others */
    }
    try {
      installFocusGuard();
    } catch (e) {
      /* ignore */
    }
    try {
      installResumeGuard();
    } catch (e) {
      /* ignore */
    }
    try {
      installMediaSessionGuard();
    } catch (e) {
      /* ignore */
    }
    try {
      installBatteryGuard();
    } catch (e) {
      /* ignore */
    }

    // Bridge config: attribute first, then re-read on every notification.
    function applyConfig(raw) {
      if (!raw || typeof raw !== "object") return;
      if (typeof raw.active === "boolean") state.active = raw.active;
      if (typeof raw.strictFocus === "boolean") state.strictFocus = raw.strictFocus;
      if (typeof raw.resumeGuard === "boolean") state.resumeGuard = raw.resumeGuard;
      if (typeof raw.batterySpoof === "boolean") state.batterySpoof = raw.batterySpoof;
    }

    function readConfigAttribute() {
      try {
        var root = document.documentElement;
        if (!root || !root.dataset) return;
        var raw = root.dataset.awakeCfg;
        if (!raw) return;
        applyConfig(JSON.parse(raw));
      } catch (e) {
        /* malformed JSON or missing <html> */
      }
    }

    window.__AWAKE__ = {
      version: VERSION,
      state: state,
      realHidden: realHidden,
      realVisibilityState: realVisibilityState,
      status: function () {
        return {
          active: state.active,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          hasFocus: document.hasFocus(),
          real: {
            hidden: realHidden(),
            visibilityState: realVisibilityState()
          }
        };
      }
    };

    readConfigAttribute();
    document.addEventListener("awake:cfg", readConfigAttribute);
  } catch (e) {
    /* a hostile page must never observe this failing */
  }
})();
