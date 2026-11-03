// TV home page, tvOS style: Keep watching on top, a grid of apps below, one screen, no scrolling.
// Runs inside the launcher's WebView (window.TVOS is the native side) or in any browser for
// development: ?mock=1 uses mock.js for everything, ?preview=1 uses mock apps with the real bridge.
(function () {
  "use strict";

  var TV = window.TVOS || null;
  var Q = location.search;
  var MOCK = /[?&]mock\b/.test(Q);
  var PREVIEW = /[?&]preview\b/.test(Q);
  var API = decodeURIComponent((Q.match(/[?&]api=([^&]+)/) || [])[1] || "");
  // which TV this page is on (the launcher adds ?tv=<id> on any TV that is not the default); none = living room
  var TV_ID = (Q.match(/[?&]tv=([a-z-]+)/) || [])[1] || "";
  // The launcher's saved copy of this page, opened when the computer is off (or when there is no
  // computer at all): scenes, clock, weather straight from Open-Meteo and the apps in the saved
  // order; nothing that needs the bridge.
  var OFFLINE = /[?&]offline=1/.test(Q);
  // No computer at all (option A): the launcher's built-in copy is the home, so there is no
  // "computer is off" note to show.
  var ALONE = OFFLINE && /[?&]alone=1/.test(Q);
  if (OFFLINE) document.documentElement.classList.add("offline");
  var CACHE_KEY = "tvhome.cache.v2";

  // Settings from the bridge's config.json (served as config.js, and saved with the offline copy),
  // read in readConfig() once the page starts (mock.js fills them in for previews). See docs/CONFIG.md.
  var CFG = {}, HOME = {}, TVCFG = {}, QUICK = [], SET = {}, SCENES_ALL = [];
  var WXCFG = { lat: -33.8688, lon: 151.2093, place: "Sydney", timezone: "Australia/Sydney" };
  var QUICK_ALL = ["sleep", "picture", "input", "picpage", "game", "ask", "settings"];
  var CLOCK24 = false;

  // What this TV keeps for itself (app order, people order, new apps). Written to the
  // page's storage and to the launcher (TVOS.keep), so the live page and the saved copy share it.
  var PFX = MOCK || PREVIEW ? "mock:" : "";
  function kept(key) {
    var v = null;
    try { if (TV && TV.kept) v = TV.kept(PFX + key); } catch (e) {}
    if (v == null) try { v = localStorage.getItem(PFX + key); } catch (e) {}
    try { return v == null ? null : JSON.parse(v); } catch (e) { return null; }
  }
  function keep(key, value, noSync) {
    var j = JSON.stringify(value);
    try { localStorage.setItem(PFX + key, j); } catch (e) {}
    try { if (TV && TV.keep) TV.keep(PFX + key, j); } catch (e) {}
    if (!noSync) syncPush(key, j);
  }

  // What this TV keeps is also copied to the bridge (/api/tv-state), so a backup holds it and a
  // restore (or a fresh install) brings it back. tvhome.rev is the version of the copy this TV has.
  var SYNC = !(MOCK || PREVIEW || OFFLINE);
  var SYNC_KEYS = ["tvhome.settings", "tvhome.people.order", "tvhome.order.tv", "tvhome.apps.new", "tvhome.apps.seen"];
  var syncQueue = {}, syncTimer = null;
  function syncPush(key, j) {
    if (!SYNC || SYNC_KEYS.indexOf(key) < 0) return;
    syncQueue[key] = j;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncFlush, 800);
  }
  function syncFlush() {
    var vals = syncQueue; syncQueue = {};
    if (!Object.keys(vals).length) return;
    api("POST", "/api/tv-state", { values: vals }).then(function (j) { if (j.rev) keep("tvhome.rev", j.rev, true); }, function () {
      Object.keys(vals).forEach(function (k) { if (!(k in syncQueue)) syncQueue[k] = vals[k]; });
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncFlush, 15000);
    });
  }
  // Resolves true when this TV took newer settings from the bridge (the page then starts again).
  function syncDown() {
    if (!SYNC) return Promise.resolve(false);
    return api("GET", "/api/tv-state").then(function (j) {
      var mine = +kept("tvhome.rev") || 0, vals = j.values || {};
      var local = SYNC_KEYS.filter(function (k) { return kept(k) != null; });
      if (mine === 0 && local.length) { local.forEach(function (k) { syncPush(k, JSON.stringify(kept(k))); }); return false; }
      if (j.rev < mine) { local.forEach(function (k) { syncPush(k, JSON.stringify(kept(k))); }); return false; }
      if (j.rev === mine) return false;
      var changed = false;
      SYNC_KEYS.forEach(function (k) {
        var theirs = vals[k] == null ? null : JSON.parse(vals[k]);
        if (JSON.stringify(theirs) !== JSON.stringify(kept(k))) { keep(k, theirs, true); changed = true; }
      });
      keep("tvhome.rev", j.rev, true);
      return changed;
    }, function () { return false; });
  }

  // Default order: YouTube, then Netflix, then the rest the way a household reaches for them.
  var APP_ORDER = [
    "com.google.android.youtube.tv", "com.netflix.ninja", "au.net.abc.iview", "com.disney.disneyplus",
    "au.com.stan.and", "au.com.streamotion.ares.tv", "com.amazon.amazonvideo.livingroom",
    "com.sbs.ondemand.tv", "com.apple.atve.androidtv.appletv", "com.cbs.ca", "au.com.ninenow.ctv",
    "com.swm.live", "au.com.tenplay", "au.com.kayosports.tv", "au.com.foxtel.atv", "com.wbd.stream",
    "com.spotify.tv.android", "com.google.android.youtube.tvmusic"
  ];
  // The TV's own tools go last, in this order, just before the screens.
  var APP_LAST = ["com.mediatek.wwtv.tvcenter", "com.android.vending", "com.android.tv.settings"];
  // Kept behind the "More apps" tile on every TV (apps most people rarely open).
  var TUCKED = ["com.mediatek.wwtv.tvcenter", "com.google.android.youtube.tvmusic", "com.spotify.tv.android"];
  // The same tools on other makers' TVs, by name.
  var TUCKED_NAMES = /^(screen ?shar|live ?tv|usb|media ?cent|browser|device assistant)/i;
  // The Play Store, under the name most people know it by.
  var RENAME = { "com.android.vending": "App Store" };
  // Never shown: home screens, store and system clutter, and Moonlight (a screen tile opens it).
  // A maker's own clutter (help apps, file browsers) is listed per house in config.json,
  // home.hide_packages, and added to this list in readConfig().
  var HIDDEN = [
    "com.google.android.apps.tv.launcherx", "com.google.android.tvlauncher", "app.couchtv.launcher",
    "com.limelight", "com.google.android.play.games", "com.google.android.videos"
  ];
  var GRID_COLS = 12;
  var DOCK_APPS = 10;   // Night: apps in the dock before Settings and More apps (home.dock_size)
  var SETTINGS_PKG = "com.android.tv.settings";
  // The Play Store: always the first tile of More apps, never in the dock's order.
  var STORE_PKG = "com.android.vending";
  var HOLD_MS = 600;    // how long OK is held to pick something up

  var ICONS = {
    screen: '<svg viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    game: '<svg viewBox="0 0 24 24"><rect x="2.5" y="7" width="19" height="10" rx="5"/><path d="M7.5 10v4M5.5 12h4"/><circle cx="15.5" cy="11" r=".6" class="fill"/><circle cx="17.5" cy="13" r=".6" class="fill"/></svg>',
    picture: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" class="fill"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>',
    ask: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/><path d="M12 6.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" class="fill"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    input: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8M12 7.5v6M9.5 11l2.5 2.5 2.5-2.5"/></svg>',
    store: '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    updown: '<svg viewBox="0 0 24 24"><path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4"/></svg>'
  };
  // weather glyphs for the date line, by Open-Meteo's WMO code
  var WX = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24"><path d="M17.5 19H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19.4 12a3.5 3.5 0 0 1-1.9 7z"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M17.5 15H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19.4 8a3.5 3.5 0 0 1-1.9 7z"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5"/></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M17.5 15H8a4 4 0 1 1 .9-7.9A5.5 5.5 0 0 1 19.4 8a3.5 3.5 0 0 1-1.9 7z"/><path d="M12.5 15.5 10.5 19h3l-2 3.5"/></svg>'
  };
  function wxIcon(w) {
    var c = w.code;
    if (c >= 95) return WX.storm;
    if (c >= 51) return WX.rain;
    if (c >= 3 || c === 45 || c === 48) return WX.cloud;
    return w.is_day ? WX.sun : WX.moon;
  }

  var $ = function (id) { return document.getElementById(id); };

  // What the Debug page can show: the last console lines, the errors, and how long the page's own calls took.
  // Always on and small (200 lines at most); nothing leaves this TV unless Send diagnostics is used.
  var DBG = { logs: [], errs: [], api: [], started: Date.now() };
  (function () {
    function cap(list, kind, args) {
      var t;
      try { t = Array.prototype.map.call(args, function (a) { return typeof a === "string" ? a : (a && a.stack) || JSON.stringify(a); }).join(" "); } catch (e) { t = String(args[0]); }
      list.push({ t: Date.now(), k: kind, m: String(t).slice(0, 300) });
      if (list.length > 200) list.shift();
    }
    ["log", "info", "warn", "error"].forEach(function (k) {
      var orig = console[k];
      if (!orig) return;
      console[k] = function () { cap(DBG.logs, k, arguments); if (k === "error") cap(DBG.errs, k, arguments); return orig.apply(console, arguments); };
    });
    window.addEventListener("error", function (e) { cap(DBG.errs, "error", [e.message + " @" + String(e.filename || "").split("/").pop() + ":" + e.lineno]); });
    window.addEventListener("unhandledrejection", function (e) { cap(DBG.errs, "error", ["unhandled: " + String(e.reason && (e.reason.message || e.reason))]); });
  })();
  var data = { shows: [], showsBy: {}, apps: [], screens: [], bridge: null };
  var WEB = [];   // web apps: websites that open full screen in this launcher, popups blocked (bridge/webapps.py)
  // Whose Keep watching is showing. Remembered on this TV. Any number of people: none or one shows
  // no switcher, two the pill switch, three or more a round head icon that opens a list.
  // With nobody set up, everything is shown ("both" to the bridge).
  var PEOPLE = [], NOBODY = false, who = null, pi = 0;
  try { who = localStorage.getItem("tvhome.who"); } catch (e) {}
  var zone = "grid", s = 0, g = 0;   // focus: zone, shelf index, grid index
  var shelfEls = [], gridEls = [], gridItems = [];
  var touched = false, expanded = false;
  var retryTimer = null, retryMs = 2500, statusTimer = null;
  var pmi = 0, plift = false;        // the people list: focused row, and whether that row is picked up
  var lift = null;                   // the dock app picked up to move: {pkg}
  var newApps = [];                  // apps installed since this TV first saw its apps, until opened once

  function setPeople(list) {
    PEOPLE = (list || []).filter(function (p) { return p && p.id && p.name; });
    NOBODY = !PEOPLE.length;
    if (NOBODY) PEOPLE = [{ id: "both", name: "everyone" }];
    PEOPLE.forEach(function (p) { if (!data.showsBy[p.id]) data.showsBy[p.id] = []; });
    if (!PEOPLE.some(function (p) { return p.id === who; })) who = PEOPLE[0].id;
  }
  // An order made on this TV with no bridge to keep it (or before the bridge heard about it).
  function localPeopleOrder(list, always) {
    var lo = kept("tvhome.people.order");
    if (!lo || !lo.ids || !(always || lo.pending)) return list;
    var by = {};
    list.forEach(function (p) { by[p.id] = p; });
    var out = lo.ids.filter(function (id) { return by[id]; }).map(function (id) { return by[id]; });
    return out.concat(list.filter(function (p) { return lo.ids.indexOf(p.id) < 0; }));
  }

  function readConfig() {
    CFG = window.COUCH_CONFIG || {};
    WEB = (kept("tvhome.webapps") || CFG.webapps || []).slice();
    if (CFG.weather) WXCFG = CFG.weather;
    HOME = CFG.home || {};
    var mine = TV_ID || CFG.default_tv;
    TVCFG = (CFG.tvs || []).filter(function (t) { return t.id === mine; })[0] || (CFG.tvs || [])[0] || {};
    // no "quick" from an older bridge: the sleep timer, and the picture switch where the TV has one
    QUICK = (TVCFG.quick || ["sleep", "picture"]).filter(function (q, i, a) { return QUICK_ALL.indexOf(q) >= 0 && a.indexOf(q) === i; });
    // What was chosen on this TV in Settings wins over config.json.
    SET = kept("tvhome.settings") || {};
    if (SET.hide && SET.hide.length) QUICK = QUICK.filter(function (q) { return SET.hide.indexOf(q) < 0; });
    // Ask Claude shows whenever the bridge has it switched on (unless hidden in Settings)
    if (CFG.ask && CFG.ask.enabled && QUICK.indexOf("ask") < 0 && !(SET.hide && SET.hide.indexOf("ask") >= 0)) QUICK.push("ask");
    if (QUICK.indexOf("settings") < 0) QUICK.push("settings");   // always there, so there is always a way back in
    // One look: the Night scenes. Old saved looks (tvhome.look, tvhome.look.hold, settings look/auto, home.look) are ignored.
    document.documentElement.classList.add("theme-night");
    GRID_COLS = 12;
    DOCK_APPS = Math.max(1, Math.min(10, parseInt(SET.dock || HOME.dock_size, 10) || 10));
    CLOCK24 = (SET.clock || HOME.clock) === "24h";
    (Array.isArray(HOME.hide_packages) ? HOME.hide_packages : []).forEach(function (p) {
      if (typeof p === "string" && HIDDEN.indexOf(p) < 0) HIDDEN.push(p);
    });
    var ids = SCENES.map(function (x) { return x.id; });
    SCENES_ALL = SCENES.slice();
    var pick = (SET.scenes || HOME.scenes || []).filter(function (id, i, a) { return ids.indexOf(id) >= 0 && a.indexOf(id) === i; });
    if (pick.length) SCENES = pick.map(function (id) { return SCENES[ids.indexOf(id)]; });
    SCENE_MS = Math.max(5, parseInt(SET.secs || HOME.scene_seconds, 10) || 20) * 1000;
    var people = CFG.people || [{ id: "person1", name: "Person 1" }, { id: "person2", name: "Person 2" }];
    setPeople(localPeopleOrder(people, OFFLINE));
    newApps = kept("tvhome.apps.new") || [];
  }

  // ---------------- helpers ----------------
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  // The saved copy has its own storage, so the app order is also kept by the launcher (TVOS.keep).
  function load() {
    if (MOCK || PREVIEW) return null;
    try {
      if (OFFLINE) return TV && TV.kept ? { order: (JSON.parse(TV.kept(CACHE_KEY) || "null") || {}).order || null } : null;
      return JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    } catch (e) { return null; }
  }
  function save() {
    if (MOCK || PREVIEW || OFFLINE) return;
    var j = JSON.stringify({ showsBy: data.showsBy, screens: data.screens, order: data.order });
    try { localStorage.setItem(CACHE_KEY, j); } catch (e) {}
    try { if (TV && TV.keep) TV.keep(CACHE_KEY, j); } catch (e) {}
  }
  function mark(name) { try { performance.mark(name); } catch (e) {} }

  function api(method, path, body, timeoutMs) {
    if (TV_ID) {
      if (method === "GET") path += (path.indexOf("?") < 0 ? "?" : "&") + "tv=" + TV_ID;
      else body = Object.assign({ tv: TV_ID }, body || {});
    }
    if (MOCK && window.MOCK_API) return window.MOCK_API(method, path, body);
    // previews on a computer read the real bridge but never change it
    if (PREVIEW && method !== "GET") return Promise.resolve({ ok: true, note: "" });
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, API + path);
      x.timeout = timeoutMs || 6000;
      x.setRequestHeader("Content-Type", "application/json");
      x.onload = function () {
        var j = null;
        try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j && j.ok !== false) resolve(j);
        else reject(new Error((j && j.error) || "The bridge said no (" + x.status + ")."));
      };
      x.onerror = function () { reject(new Error("The bridge isn't answering.")); };
      x.ontimeout = function () { reject(new Error("The bridge took too long to answer.")); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  function status(text, sticky) {
    clearTimeout(statusTimer);
    $("status").textContent = text || "";
    if (text && !sticky) statusTimer = setTimeout(function () { status(data.bridge === false && !ALONE ? "Computer not answering. Apps still work." : "", true); }, 6000);
  }

  function iconUrl(pkg) {
    if (!pkg) return null;
    if (TV) return "http://tvos.invalid/icon/" + pkg;
    return window.MOCK_ICON ? window.MOCK_ICON(pkg) : null;
  }

  // ---------------- the clock and the date ----------------
  function clock() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    var mm = (m < 10 ? "0" : "") + m;
    var hm = CLOCK24 ? (h < 10 ? "0" : "") + h + ":" + mm : (h % 12 || 12) + ":" + mm;
    $("time").innerHTML = hm + (CLOCK24 ? "" : "<small>" + (h < 12 ? "am" : "pm") + "</small>");
    if (clock._hm !== hm) { if (clock._hm) pulse($("time"), "tick"); clock._hm = hm; }
    var day = dateStyle() === "us"
      ? d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
      : d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" }).replace(",", "");
    var w = data.weather && data.weather.temp != null ? data.weather : null;
    $("date").innerHTML = esc(day) + (w ? '<span class="wx">' + wxIcon(w) + esc(shownTemp(w.temp) + "° " + w.text) + "</span>" : (wxPending ? '<span class="wx wxs skel"></span>' : ""));
    document.body.classList.toggle("night", h >= 21 || h < 6);
    glassClock(hm);
    if (quickReady) renderQuick();
  }

  // Night: five lock screen scenes take turns every 20 s (home.scenes picks which and in what
  // order, home.scene_seconds how long each stays). Each has its own photo,
  // a big glass clock and (most) a cut-out of the photo that stands in front of the clock. The clock's
  // fill is the frosted copy of the photo exactly behind each digit, so it is re-aligned whenever the
  // time changes or a scene is about to show. Only the scene showing and the next one are drawn.
  // Files: backgrounds/<photo>.jpg (and optionally -fg.webp).
  var SCENES = [
    // Photos are the generated scene-*.jpg set in backgrounds/. Drop your own 1920x1080 JPEGs in there
    // and name them here. A cut-out for the clock to sit behind is optional: set fg: true and add
    // backgrounds/<photo>-fg.webp (a transparent copy of the foreground).
    { id: "night", photo: "scene-night", fg: false },
    { id: "golden", photo: "scene-golden", fg: false },
    { id: "water", photo: "scene-water", fg: false },
    { id: "fog", photo: "scene-fog", fg: false },
    { id: "dawn", photo: "scene-dawn", fg: false }
  ];
  var SCENE_MS = 20000;
  var scene = 0, sceneEls = [], glassShown = "", sceneTimer = null;

  function buildScenes() {
    var box = $("scenes");
    sceneEls = SCENES.map(function (s) {
      var el = document.createElement("div");
      el.className = "scene s-" + s.id;
      el.innerHTML = '<img class="sbg" alt=""><div class="shade"></div><div class="gclock"></div>' +
        (s.water ? '<div class="gclock under"></div>' : "") + (s.fg ? '<img class="fg" alt="">' : "");
      box.appendChild(el);
      return el;
    });
  }

  // draw a scene (load its pictures, place its clock) so it can fade in
  function readyScene(i) {
    var s = SCENES[i], el = sceneEls[i];
    if (!el.classList.contains("ready")) {
      el.querySelector(".sbg").src = "backgrounds/" + s.photo + ".jpg";
      if (s.fg) el.querySelector(".fg").src = "backgrounds/" + s.photo + "-fg.webp";
      el.classList.add("ready");
    }
    drawClocks(el, s, glassShown);
  }

  function drawClocks(el, s, hm) {
    if (!hm) return;
    var cs = el.querySelectorAll(".gclock");
    for (var k = 0; k < cs.length; k++) {
      var c = cs[k];
      c.innerHTML = '<span class="fill">' + hm + '</span><span class="sheen">' + hm + '</span><span class="rim">' + hm + "</span>";
      var f = c.firstChild;
      f.style.backgroundImage = "url(backgrounds/" + s.photo + ".jpg)";
      f.style.backgroundPosition = -(c.offsetLeft + f.offsetLeft) + "px " + -(c.offsetTop + f.offsetTop) + "px";
    }
    if (s.water) {   // above the waterline sharp, below it the blurred reflection
      // The digits hang below the clock's box (its line height is tight), so the clips reach past
      // the box on the open sides; a plain inset cut the bottom of the numbers off .
      var line = innerHeight * s.water - cs[0].offsetTop, out = "-50%";
      cs[0].style.clipPath = "inset(" + out + " " + out + " " + (cs[0].offsetHeight - line) + "px " + out + ")";
      cs[1].style.clipPath = "inset(" + line + "px " + out + " " + out + " " + out + ")";
    }
  }

  function glassClock(hm) {
    if (hm === glassShown) return;
    var had = !!glassShown;
    glassShown = hm;
    sceneEls.forEach(function (el, i) {
      if (!el.classList.contains("ready")) return;
      drawClocks(el, SCENES[i], hm);
      if (had && el.classList.contains("on")) Array.prototype.forEach.call(el.querySelectorAll(".gclock"), function (g) { pulse(g, "tick"); });
    });
  }

  function showScene(i) {
    var prev = scene;
    scene = i;
    readyScene(i);
    var date = $("date");
    date.classList.add("swap");
    setTimeout(function () {
      document.documentElement.className = document.documentElement.className.replace(/\bscene-\w+/g, "").trim() + " scene-" + SCENES[i].id;
      date.classList.remove("swap");
    }, 600);
    sceneEls[i].classList.add("on");
    if (prev !== i) sceneEls[prev].classList.remove("on");
    // after the fade, stop drawing the old one and get the next one ready
    setTimeout(function () {
      var next = (scene + 1) % SCENES.length;
      sceneEls.forEach(function (el, k) { if (k !== scene && k !== next) el.classList.remove("ready"); });
      readyScene(next);
    }, 2000);
  }

  function nextScene() { showScene((scene + 1) % SCENES.length); }

  // ---------------- live settings: every choice shows at once, behind the panel ----------------
  // Other features register their own handler: window.TVOS_LIVE["row key"] = function (value) { ... }.
  var LIVE_HOOKS = window.TVOS_LIVE = window.TVOS_LIVE || {};
  var REDUCED = false;
  try { REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}
  function retrigger(el) { if (!el) return; el.style.animation = "none"; void el.offsetWidth; el.style.animation = ""; }
  function restartSceneTimer() {
    clearInterval(sceneTimer); sceneTimer = null;
    if (SCENES.length > 1) sceneTimer = setInterval(nextScene, SCENE_MS);
  }
  function rebuildScenes() {
    var cur = sceneEls[scene] && (sceneEls[scene].className.match(/\bs-(\w+)/) || [])[1];
    clearInterval(sceneTimer); sceneTimer = null;
    $("scenes").innerHTML = ""; sceneEls = []; scene = 0; glassShown = "";
    buildScenes();
    var ids = SCENES.map(function (x) { return x.id; }), at = ids.indexOf(cur);
    showScene(at < 0 ? 0 : at);
    pulse($("scenes"), "refade");
    restartSceneTimer();
    clock();
  }
  function computeQuick() {   // the same rules readConfig uses, so a button can come back where it was
    var q = (TVCFG.quick || ["sleep", "picture"]).filter(function (x, i, a) { return QUICK_ALL.indexOf(x) >= 0 && a.indexOf(x) === i; });
    if (SET.hide && SET.hide.length) q = q.filter(function (x) { return SET.hide.indexOf(x) < 0; });
    if (CFG.ask && CFG.ask.enabled && q.indexOf("ask") < 0 && !(SET.hide && SET.hide.indexOf("ask") >= 0)) q.push("ask");
    if (q.indexOf("settings") < 0) q.push("settings");
    return q;
  }
  // read every setting again and show it (after Put all of these back, a restore, or a change made elsewhere)
  function reapplyAll() {
    SCENES = SCENES_ALL.slice();
    readConfig();
    rebuildScenes();
    refreshWeather();
    renderQuick(); renderShelf(); renderGrid(); paintFocus();
    Array.prototype.forEach.call(document.querySelectorAll(".top, .shelf, .grid"), retrigger);
    restartSceneTimer();
  }
  function liveRender() { renderGrid(); paintFocus(); }

  function refreshWeather() {
    var done = function () { wxPending = false; clock(); };
    if (OFFLINE) return weatherDirect().then(function (j) { data.weather = j; done(); }, done);
    return api("GET", "/api/weather").then(function (j) { data.weather = j; done(); }, done);
  }

  // Offline: the same Open-Meteo call the bridge makes (free, no key), for the place in config.json.
  var WMO_TEXT = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog",
    51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 56: "Drizzle", 57: "Drizzle", 61: "Light rain", 63: "Rain",
    65: "Heavy rain", 66: "Rain", 67: "Rain", 80: "Showers", 81: "Showers", 82: "Heavy showers",
    95: "Storms", 96: "Storms", 99: "Storms" };
  function weatherDirect() {
    var url = "https://api.open-meteo.com/v1/forecast?latitude=" + WXCFG.lat + "&longitude=" + WXCFG.lon +
      "&current=temperature_2m,weather_code,is_day&timezone=" + encodeURIComponent(WXCFG.timezone || "auto") + "&forecast_days=1";
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var c = j.current, code = Math.round(c.weather_code);
      return { temp: Math.round(c.temperature_2m), code: code, text: WMO_TEXT[code] || "", is_day: !!c.is_day };
    });
  }

  // ---------------- quick buttons: from tvs[].quick in config.json, in that order ----------------
  // sleep: the sleep timer. picture: flip between the TV's two picture modes. input: the TV's input list. A button that cannot work right now is left out (no bridge
  // for the sleep timer, a TV with no picture setting, an input list nobody can open).
  var SLEEP_CHOICES = [15, 30, 60, 90, 0];   // 0 = off
  // picture mode only exists where the bridge says this TV supports it
  var sleepEnds = null, picMode = null, picCanSet = false, picShown = false, picBusy = false, picModes = null;
  var qi = 0, menuI = 0, noteTimer = null, quickReady = false, quickEls = [];

  function note(text) {
    clearTimeout(noteTimer);
    $("quick-note").textContent = text || "";
    if (text) pulse($("quick-note"), "pop");
    if (text) noteTimer = setTimeout(function () { $("quick-note").textContent = ""; }, 6000);
  }
  function minutesLeft() {
    if (!sleepEnds) return 0;
    var m = Math.ceil((sleepEnds - Date.now()) / 60000);
    if (m <= 0) { sleepEnds = null; return 0; }
    return m;
  }
  function nativeInputs() {
    try { return !!(TV && TV.canOpenInputs && TV.canOpenInputs()); } catch (e) { return false; }
  }
  function quickVisible() {
    return QUICK.filter(function (q) {
      if (q === "sleep") return !OFFLINE;
      if (q === "picture") return !OFFLINE && picShown;
      if (q === "settings") return true;
      if (q === "ask") return askOn();
      if (q === "picpage" || q === "game") return !OFFLINE;
      if (q === "input") return !OFFLINE || nativeInputs();
      return false;
    });
  }
  function hasQuick() { return quickVisible().length > 0; }
  function picLabel() {
    if (picBusy) return "Switching…";
    var names = picModes || (TVCFG.picture_modes || []).map(function (n) { return { id: null, name: n }; });
    var hit = names.filter(function (m) { return m.id === picMode; })[0];
    if (hit) return hit.name;
    if (picMode && picMode !== "other") return picMode.charAt(0).toUpperCase() + picMode.slice(1).replace(/-/g, " ");
    return "Picture mode";
  }
  function renderQuick() {
    quickReady = true;
    var box = $("qbtns"), vis = quickVisible(), key = vis.join(",");
    var oldK = box.getAttribute("data-k");
    if (oldK !== key) {
      box.innerHTML = vis.map(function (q) { return '<span class="qbtn" id="q-' + q + '"></span>'; }).join("");
      box.setAttribute("data-k", key);
      if (oldK) vis.forEach(function (q) { if (oldK.split(",").indexOf(q) < 0) pulse($("q-" + q), "fresh"); });
    }
    $("quick").classList.toggle("none", !vis.length);
    quickEls = vis.map(function (q) { return $("q-" + q); });
    var m = minutesLeft();
    vis.forEach(function (q) {
      var el = $("q-" + q);
      if (q === "sleep") {
        el.innerHTML = ICONS.moon + "<span>" + (m ? "Off in " + m + " min" : "Sleep timer") + "</span>";
        el.classList.toggle("set", !!m);
      } else if (q === "picture") {
        el.innerHTML = ICONS.picture + "<span>" + esc(picLabel()) + "</span>";
        el.classList.toggle("off", !picCanSet);
      } else if (q === "input") {
        el.innerHTML = ICONS.input + "<span>Input</span>";
      } else if (q === "picpage") {
        el.innerHTML = ICONS.picture + "<span>Picture settings</span>";
      } else if (q === "game") {
        el.innerHTML = ICONS.game + "<span>Game mode</span>";
      } else if (q === "ask") {
        el.innerHTML = ICONS.ask + "<span>Ask Claude</span>";
      } else if (q === "settings") {
        el.innerHTML = ICONS.gear + "<span>Settings</span>";
      }
    });
    if (qi >= vis.length) qi = Math.max(0, vis.length - 1);
  }
  function renderMenu() {
    var menu = $("sleep-menu");
    if (menu.children.length !== SLEEP_CHOICES.length) {
      menu.innerHTML = SLEEP_CHOICES.map(function (c) { return '<span class="opt">' + (c ? c + " min" : "Off") + "</span>"; }).join("");
    }
    Array.prototype.forEach.call(menu.children, function (el, i) { el.classList.toggle("focus", i === menuI); });
  }
  // opening and closing the panels: a short motion in, a shorter one out (a quick re-open cancels the exit)
  function enter(el) { clearTimeout(el._lv); el.classList.remove("out"); el.classList.add("on"); }
  function leave(el) { clearTimeout(el._lv); el.classList.remove("on", "out"); }   // the CSS transition plays the exit
  function pulse(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  function openMenu() {
    var m = minutesLeft();
    menuI = m ? SLEEP_CHOICES.length - 1 : 1;   // a timer is running: start on Off; otherwise 30 min
    zone = "menu";
    enter($("sleep-menu"));
    renderMenu();
  }
  function closeMenu() {
    leave($("sleep-menu"));
    zone = "quick";
  }
  function setSleep(minutes) {
    closeMenu();
    sleepEnds = minutes ? Date.now() + minutes * 60000 : null;   // show it straight away
    renderQuick();
    api("POST", "/api/sleep", { minutes: minutes })
      .then(function (j) { if (j.ends !== undefined) sleepEnds = j.ends ? Date.parse(j.ends) : null; renderQuick(); })
      .catch(function (e) { note(e.message); refreshQuick(); });
  }
  function togglePicture() {
    if (!picCanSet) { note("Switching picture mode from here isn't ready yet."); return; }
    // A picture switch can take several seconds. Extra presses meanwhile would switch it straight back,
    // so they do nothing, and the label says what the TV actually ended on, not a guess.
    if (picBusy) return;
    picBusy = true;
    renderQuick();
    api("POST", "/api/picture", { mode: "toggle" }, 20000)
      .then(function (j) { if (j.mode) picMode = j.mode; })
      .catch(function (e) { note(e.message); })
      .then(function () { picBusy = false; renderQuick(); });
  }
  // The TV's own input list (HDMI, a console, a set top box): the TV_INPUT key through the bridge,
  // or straight from the launcher when there is no bridge (only where the TV has such a screen).
  function openInputs() {
    var native = function () { try { return !!(TV && TV.openInputs && TV.openInputs()); } catch (e) { return false; } };
    if (OFFLINE) { if (!native()) note("This TV has no input list to open."); return; }
    api("POST", "/api/key", { key: "input" })
      .catch(function (e) { if (!native()) note(e.message); });
  }
  // the TV's own picture settings page / game bar (the bridge starts them by intent)
  function openTvPage(what) {
    if (OFFLINE) { note("Needs the bridge on the computer."); return; }
    api("POST", "/api/tvpage", { what: what }).catch(function (e) { note(e.message); });
  }
  function quickAction() {
    var q = quickVisible()[qi];
    if (q === "sleep") openMenu();
    else if (q === "picture") togglePicture();
    else if (q === "input") openInputs();
    else if (q === "picpage") openTvPage("picture");
    else if (q === "game") openTvPage("game");
    else if (q === "ask") openAsk();
    else if (q === "settings") openSettings();
  }
  // ---------------- Ask Claude, on the TV ----------------
  // Up and down pick a suggestion, OK asks it. A question typed in the phone remote's Ask tab shows here too:
  // the bridge keeps the latest ask for this TV (/api/ask/state) and this screen follows it while it is open.
  var ASK_PROMPTS = ["What's the weather?", "Will it rain this week?", "What should we watch tonight?", "Tell me a joke"];
  var askPaint = "";   // what the answer box shows now, so a poll that changes nothing does not restart the dots
  var askI = 0,askState = null, askIgnore = null, askTimer = null, askDots = 0, askHint = "", askClock = 0, askKey = "";
  function askOn() { return !OFFLINE && !!(CFG.ask && CFG.ask.enabled); }
  function askView() {
    var s = askState;
    if (!s || (!s.local && s.id === askIgnore)) return "menu";
    if (s.status === "pending") return "wait";
    return "answer";
  }
  function askRows() {
    var v = askView(), rows = [];
    if (v === "menu") {
      ASK_PROMPTS.forEach(function (p) { rows.push({ k: "send", label: p, text: p }); });
      rows.push({ k: "close", label: "Close" });
    } else if (v === "wait") {
      rows.push({ k: "close", label: "Hide (it keeps working)" });
    } else {
      rows.push({ k: "answer" });
      if (askState.status === "done") (askState.options || []).forEach(function (o) { rows.push({ k: "send", label: o.label, text: o.text }); });
      rows.push({ k: "menu", label: "Ask something else" });
      rows.push({ k: "close", label: "Done" });
    }
    return rows;
  }
  function askScrollable() { var a = $("ask-a"); return a.scrollHeight > a.clientHeight + 2; }
  function renderAsk() {
    var v = askView(), rows = askRows(), a = $("ask-a"), s = askState;
    askI = Math.max(0, Math.min(rows.length - 1, askI));
    $("ask-q").textContent = v !== "menu" && s && s.text ? "“" + s.text + "”" : "";
    a.style.display = v === "menu" ? "none" : "";
    a.classList.toggle("wait", v === "wait");
    var paint = v === "wait" ? "w|" + (s && s.reply || "") : v === "answer" ? "a|" + (s.reply || "No answer came back.") : "";
    if (paint !== askPaint) {
      var fadeIn = v === "answer" && /^w\|/.test(askPaint);
      askPaint = paint;
      if (v === "wait") {   // the answer grows here while Claude is still working; dots only fade (opacity)
        a.innerHTML = (s && s.reply ? esc(s.reply) + " " : '<span class="sk-lines"><i class="skel"></i><i class="skel"></i><i class="skel"></i></span>') + '<span class="tdots"><i></i><i></i><i></i></span>';
      } else if (v === "answer") { a.textContent = s.reply || "No answer came back."; if (fadeIn) pulse(a, "fadein"); }
    }
    a.classList.toggle("focus", !!rows[askI] && rows[askI].k === "answer" && askScrollable());
    $("ask-list").innerHTML = rows.map(function (r, i) {
      if (r.k === "answer") return "";
      return '<div class="srow' + (i === askI ? " focus" : "") + '"><span class="sl">' + esc(r.label) + "</span></div>";
    }).join("");
    $("ask-note").textContent = (s && s.status === "error") || v === "menu" ? askHint : "";
    $("ask-help").textContent = v === "menu"
      ? "OK to ask. You can also type a question in the Ask tab on your phone remote and the answer shows here. Back to close."
      : v === "wait" ? "Back to hide this. The answer shows when it is ready."
      : (askScrollable() ? "Up and down to read. OK to choose. Back to close." : "OK to choose. Back to close.");
  }
  function askApply(j) {
    askHint = j.hint || "";
    var s = j.state;
    if (j.enabled === false) askHint = "Ask Claude is switched off on the computer (ask.enabled in config.json).";
    if (s) {
      var age = (j.now || 0) - (s.ts || 0);
      if (askClock === 0) {   // first look after opening: an old answer is not shown again
        askClock = 1;
        if (s.status !== "pending" && age > 600) askIgnore = s.id;
      }
      if (!askState || !askState.local || s.text === askState.text) {
        var now = s.id + s.status, changed = askKey !== now;
        askState = s; askKey = now;
        if (changed) { askI = 0; if (askView() === "answer") { renderAsk(); askI = askScrollable() ? 0 : Math.min(1, askRows().length - 1); } }
      }
    }
    renderAsk();
  }
  function askPoll() {
    clearTimeout(askTimer);
    if (zone !== "ask") return;
    askDots++;
    api("GET", "/api/ask/state").then(askApply, function (e) {
      askHint = e.message; renderAsk();
    }).then(function () { askTimer = setTimeout(askPoll, askView() === "wait" ? 500 : 2000); });
  }
  function openAsk() {
    zone = "ask"; askI = 0; askClock = 0; askHint = ""; askDots = 0;
    enter($("ask"));
    renderAsk();
    askPoll();
    paintFocus();
  }
  function closeAsk() {
    clearTimeout(askTimer);
    leave($("ask"));
    zone = "quick";
    paintFocus();
  }
  function askSend(text) {
    askKey = "";
    askState = { id: "local" + Date.now(), local: true, text: text, status: "pending", reply: "", options: [] };
    askI = 0;
    renderAsk();
    api("POST", "/api/ask", { text: text, who: who }, 95000).then(function (j) {
      if (askState && askState.local && askState.text === text) {
        askState = { id: "r" + Date.now(), text: text, status: "done", reply: j.say || j.reply || "", options: j.options || [] };
        renderAsk(); askI = askScrollable() ? 0 : 1; renderAsk();
      }
    }, function (e) {
      if (askState && askState.local && askState.text === text) {
        askState = { id: "e" + Date.now(), text: text, status: "error", reply: e.message, options: [] };
        askI = 1; renderAsk();
      }
    });
  }
  function askMove(dy) {
    var rows = askRows(), a = $("ask-a");
    if (rows[askI] && rows[askI].k === "answer" && askScrollable()) {
      var atEnd = a.scrollTop + a.clientHeight >= a.scrollHeight - 2;
      if (dy < 0 && a.scrollTop > 0) { a.scrollTop = Math.max(0, a.scrollTop - 84); return; }
      if (dy > 0 && !atEnd) { a.scrollTop += 84; return; }
    }
    askI = Math.max(0, Math.min(rows.length - 1, askI + dy));
    renderAsk();
    var f = $("ask-list").querySelector(".focus");
    if (f && f.scrollIntoView) f.scrollIntoView({ block: "nearest" });
  }
  function askActivate() {
    var r = askRows()[askI];
    if (!r || r.k === "answer") return;
    if (r.k === "send") askSend(r.text);
    else if (r.k === "menu") { askIgnore = askState && askState.id; askState = null; askI = 0; renderAsk(); }
    else closeAsk();
  }

  // ---------------- Settings PIN ----------------
  // 4 digits, asked before Settings opens and before Restart / Reboot / Back up / Restore / Reset. Only a salted, stretched
  // SHA-256 is kept (inside tvhome.settings, so it is backed up and synced as a hash, never the digits). After a right PIN
  // the sensitive actions stay unlocked for 2 minutes. 5 wrong tries lock the PIN screen for 30 seconds.
  // Forgot it: on the computer, POST /api/pin/reset (run reset-pin.cmd next to run-bridge.cmd).
  var PIN_OPEN_MS = 120000, PIN_TRIES = 5, PIN_LOCK_MS = 30000;
  var pinS = null, pinUnlockedAt = 0, pinTick = null;
  var PIN_GUARDED = ["!rhome", "!reboot", "!backup", "!restore", "!reset", "!android"];
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mp = Math.pow, mw = mp(2, 32), i, j, result = "", words = [], abl = ascii.length * 8;
    var hash = sha256.h = sha256.h || [], k = sha256.k = sha256.k || [], pc = k.length, ic = {};
    for (var c = 2; pc < 64; c++) {
      if (!ic[c]) {
        for (i = 0; i < 313; i += c) ic[i] = c;
        hash[pc] = (mp(c, 0.5) * mw) | 0;
        k[pc++] = (mp(c, 1 / 3) * mw) | 0;
      }
    }
    ascii += "\x80";
    while (ascii.length % 64 - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) { j = ascii.charCodeAt(i); words[i >> 2] |= (j & 255) << ((3 - i) % 4) * 8; }
    words[words.length] = (abl / mw) | 0;
    words[words.length] = abl;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), old = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
          (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; result += (b < 16 ? "0" : "") + b.toString(16); }
    return result;
  }
  function pinHash(pin, salt) { var h = salt + ":" + pin; for (var i = 0; i < 400; i++) h = sha256(salt + h); return h; }
  function pinRandom() {
    var s = "";
    try { var a = new Uint8Array(8); crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16); return s; } catch (e) {}
    for (var j = 0; j < 16; j++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }
  function pinOn() { return !!(SET.pin && SET.pin.h && SET.pin.s); }
  function pinNeeded() { return pinOn() && Date.now() - pinUnlockedAt > PIN_OPEN_MS; }
  function pinLockLeft() { var l = kept("tvhome.pin.lock"); return l && l.until > Date.now() ? Math.ceil((l.until - Date.now()) / 1000) : 0; }
  function openPin(mode, then) {
    pinS = { mode: mode, d: [0, 0, 0, 0], at: 0, then: then, back: zone, first: "", msg: "" };
    if (zone === "settings") $("settings").classList.add("behind");
    zone = "pin";
    enter($("pin"));
    renderPin();
  }
  function closePin() {
    clearInterval(pinTick); pinTick = null;
    leave($("pin"));
    $("settings").classList.remove("behind");
    var s = pinS; pinS = null;
    if (s) zone = s.back;
    return s;
  }
  function pinCancel() { closePin(); paintFocus(); }
  function renderPin() {
    if (!pinS) return;
    var titles = { check: "Enter PIN", "new": "Choose a new PIN", confirm: "Enter it again" };
    $("pin-title").textContent = titles[pinS.mode] || "Enter PIN";
    $("pin-boxes").innerHTML = pinS.d.map(function (n, i) {
      return '<div class="pin-box' + (i === pinS.at ? " focus" : "") + '">' + (i === pinS.at ? n : "•") + "</div>";
    }).join("");
    var left = pinLockLeft();
    $("pin-note").textContent = left ? "Too many tries. Try again in " + left + " s." : pinS.msg;
    if (left && !pinTick) pinTick = setInterval(function () {
      if (zone === "pin") renderPin();
      if (!pinLockLeft()) { clearInterval(pinTick); pinTick = null; }
    }, 1000);
  }
  function pinMove(dx, dy) {
    if (!pinS) return;
    if (dy) pinS.d[pinS.at] = (pinS.d[pinS.at] - dy + 10) % 10;
    if (dx) pinS.at = Math.max(0, Math.min(3, pinS.at + dx));
    pinS.msg = "";
    renderPin();
  }
  function pinType(n) {
    if (!pinS) return;
    pinS.d[pinS.at] = n;
    if (pinS.at < 3) pinS.at++;
    pinS.msg = "";
    renderPin();
  }
  function pinShake(msg) {
    pinS.msg = msg; pinS.d = [0, 0, 0, 0]; pinS.at = 0;
    renderPin();
    var p = $("pin-panel");
    p.classList.remove("shake"); void p.offsetWidth; p.classList.add("shake");
  }
  function pinSubmit() {
    if (!pinS) return;
    if (pinLockLeft()) { renderPin(); return; }
    var pin = pinS.d.join("");
    if (pinS.mode === "check") {
      if (pinOn() && pinHash(pin, SET.pin.s) === SET.pin.h) {
        keep("tvhome.pin.lock", null, true);
        pinUnlockedAt = Date.now();
        var s = closePin();
        paintFocus();
        if (s && s.then) s.then();
        return;
      }
      var l = kept("tvhome.pin.lock") || {}, n = (l.n || 0) + 1;
      if (n >= PIN_TRIES) { keep("tvhome.pin.lock", { n: 0, until: Date.now() + PIN_LOCK_MS }, true); pinShake(""); }
      else { keep("tvhome.pin.lock", { n: n, until: 0 }, true); pinShake("Wrong PIN. " + (PIN_TRIES - n) + (PIN_TRIES - n === 1 ? " try" : " tries") + " left."); }
    } else if (pinS.mode === "new") {
      pinS.first = pin; pinS.mode = "confirm"; pinS.d = [0, 0, 0, 0]; pinS.at = 0; pinS.msg = "";
      renderPin();
    } else {
      if (pin !== pinS.first) { pinS.mode = "new"; pinShake("They didn’t match. Choose it again."); return; }
      var salt = pinRandom();
      SET.pin = { s: salt, h: pinHash(pin, salt) };
      keep("tvhome.settings", SET);
      pinUnlockedAt = Date.now();
      var done = closePin();
      paintFocus();
      if (done && done.then) done.then();
    }
  }
  function pinDigit(e) {
    if (e.key && e.key.length === 1 && e.key >= "0" && e.key <= "9") return +e.key;
    if (e.keyCode >= 48 && e.keyCode <= 57) return e.keyCode - 48;
    if (e.keyCode >= 96 && e.keyCode <= 105) return e.keyCode - 96;
    return null;
  }

  // ---------------- Developer mode and the Debug page ----------------
  // Developer mode lives only in memory: it is off after every restart, reload or boot, on purpose. To turn it
  // on (or off): About, then OK on the version line seven times within four seconds. Rows in the Developer group
  // of Settings say what they do; the Debug page itself only reads.
  var DEV = false, DEVS = { fps: false, guides: false, level: "warn" };
  var devTaps = 0, devFirst = 0, devHintT = null;
  function dpad(n) { return n < 10 ? "0" + n : "" + n; }
  function withParam(url, k, v) {
    var u = url.replace(new RegExp("([?&])" + k + "=[^&#]*&?"), "$1").replace(/[?&]$/, "");
    return v == null ? u : u + (u.indexOf("?") < 0 ? "?" : "&") + k + "=" + encodeURIComponent(v);
  }
  function devApply() {
    document.body.classList.toggle("dev-guides", !!DEVS.guides);
    $("fpsbox").classList.toggle("on", !!DEVS.fps);
    fpsSync();
  }
  function setDev(on) {
    DEV = !!on;
    if (!DEV) { DEVS.fps = false; DEVS.guides = false; DEVS.level = "warn"; devApply(); }
    $("devbadge").classList.toggle("on", DEV);
    var el = $("about-dev");
    if (el) { el.textContent = DEV ? "Developer mode is on until this page restarts." : "Developer mode is off."; el.classList.add("on"); }
  }
  function aboutDevReset() {
    devTaps = 0; devFirst = 0;
    var el = $("about-dev");
    if (el) { el.textContent = ""; el.classList.remove("on"); }
  }
  function aboutTap() {
    var now = Date.now();
    if (!devFirst || now - devFirst > 4000) { devFirst = now; devTaps = 0; }
    devTaps++;
    clearTimeout(devHintT);
    var el = $("about-dev");
    if (devTaps >= 7) {
      devTaps = 0; devFirst = 0;
      setDev(!DEV);
      devHintT = setTimeout(aboutDevReset, 4000);
      return;
    }
    devHintT = setTimeout(aboutDevReset, 4200);
    if (el && devTaps >= 3) {
      var left = 7 - devTaps;
      el.textContent = left + (left === 1 ? " more tap" : " more taps") + (DEV ? " to turn developer mode off" : " to turn on developer mode");
      el.classList.add("on");
    }
  }

  // the page's own calls to the bridge, timed (the table in the report)
  var apiRaw = api;
  api = function (method, path) {
    var t0 = performance.now(), p = apiRaw.apply(this, arguments);
    function rec(ok) {
      DBG.api.push({ m: method, p: String(path).split("?")[0], ms: Math.round(performance.now() - t0), ok: ok, at: Date.now() });
      if (DBG.api.length > 60) DBG.api.shift();
    }
    p.then(function () { rec(true); }, function () { rec(false); });
    return p;
  };

  // frame counter: only runs while the Debug page or the FPS overlay is open (it costs a little itself)
  var fpsM = { raf: 0, last: 0, t0: 0, frames: 0, now: 0, long: 0, worst: 0, sum: 0, n: 0 };
  function fpsTick(t) {
    if (fpsM.last) {
      var d = t - fpsM.last;
      fpsM.frames++;
      if (d > 50) fpsM.long++;
      if (d > fpsM.worst) fpsM.worst = d;
    }
    fpsM.last = t;
    if (!fpsM.t0) fpsM.t0 = t;
    if (t - fpsM.t0 >= 1000) { fpsM.now = Math.round(fpsM.frames * 1000 / (t - fpsM.t0)); fpsM.sum += fpsM.now; fpsM.n++; fpsM.frames = 0; fpsM.t0 = t; }
    fpsM.raf = requestAnimationFrame(fpsTick);
  }
  function fpsSync() {
    var want = DEVS.fps || zone === "debug" || diagR.running;
    if (want && !fpsM.raf) { fpsM.last = 0; fpsM.t0 = 0; fpsM.frames = 0; fpsM.raf = requestAnimationFrame(fpsTick); }
    else if (!want && fpsM.raf) { cancelAnimationFrame(fpsM.raf); fpsM.raf = 0; }
    clearInterval(fpsSync._t);
    if (want) fpsSync._t = setInterval(fpsPaint, 1000);
  }
  function fpsPaint() {
    if (DEVS.fps) $("fpsbox").textContent = fpsM.now + " fps \u00b7 " + fpsM.long + " long \u00b7 worst " + Math.round(fpsM.worst) + " ms";
    if (zone === "debug") renderDebugPane();
  }
  function fpsAvg() { return fpsM.n ? Math.round(fpsM.sum / fpsM.n) : null; }

  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + " s" : s < 3600 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : Math.floor(s / 3600) + " h " + Math.floor(s % 3600 / 60) + " min";
  }
  function storageInfo() {
    var keys = [], total = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i), n = (k.length + (localStorage.getItem(k) || "").length) * 2;
        keys.push({ key: k, bytes: n }); total += n;
      }
    } catch (e) {}
    keys.sort(function (a, b) { return b.bytes - a.bytes; });
    return { keys: keys, total: total };
  }
  function safeSettings() {
    var o = {};
    try { o = JSON.parse(JSON.stringify(SET || {})); } catch (e) {}
    if (o.pin) o.pin = "(set)";
    return o;
  }
  function pageInfo() {
    var m = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || "unknown";
    var mem = window.performance && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    var app = "browser";
    try { if (TV && TV.version) app = "TV app " + TV.version(); } catch (e) {}
    return { webview: m, ua: navigator.userAgent, screen: screen.width + "x" + screen.height, viewport: innerWidth + "x" + innerHeight,
      dpr: window.devicePixelRatio, online: navigator.onLine, heap_mb: mem, uptime_s: Math.round((Date.now() - DBG.started) / 1000),
      url: location.href.replace(/[?#].*/, ""), zone: zone, app: app,
      mode: MOCK ? "mock data" : PREVIEW ? "preview" : OFFLINE ? "saved offline copy" : "live" };
  }
  function phoneUrl() {
    var base = API || (/^https?:/.test(location.protocol) && !/\.invalid$/.test(location.hostname) ? location.origin : "");
    return (base || "the computer's address:5400").replace(/^https?:\/\//, "") + "/diag/latest";
  }

  var DBG_MENU = [["live", "Live"], ["run", "Run diagnostics"], ["console", "Console"], ["errors", "Errors"], ["screen", "Screen on/off log"], ["storage", "Storage"],
    ["settings", "Settings"], ["page", "This page"], ["send", "Send diagnostics"], ["phone", "Open on a phone"], ["close", "Close"]];
  var dbgI = 0, dbgFlash = "", dbgSent = null, diagR = { running: false, items: [] };
  function dbgTable(rows) {
    return '<table class="dbg-t">' + rows.map(function (r) {
      return "<tr><th>" + esc(r[0]) + "</th><td" + (r[2] ? ' class="' + r[2] + '"' : "") + ">" + esc(r[1]) + "</td></tr>";
    }).join("") + "</table>";
  }
  function dbgLines(list) {
    var rank = { error: 3, warn: 2, info: 1, log: 1 }, min = DEVS.level === "error" ? 3 : DEVS.level === "warn" ? 2 : 0;
    var rows = list.filter(function (x) { return (rank[x.k] || 1) >= min; }).slice(-13);
    if (!rows.length) return '<p class="dbg-empty">Nothing at this log level.</p>';
    return '<div class="dbg-log">' + rows.map(function (x) {
      var d = new Date(x.t);
      return '<div class="' + x.k + '"><b>' + dpad(d.getHours()) + ":" + dpad(d.getMinutes()) + ":" + dpad(d.getSeconds()) + "</b> " + esc(x.m) + "</div>";
    }).join("") + "</div>";
  }
  function dbgResults() {
    var h = "";
    if (diagR.running) h += '<div class="dbg-skel"><i></i><i></i><i></i></div>';
    h += '<div class="dbg-res">' + diagR.items.map(function (r) {
      return '<div class="' + r.status + '"><span class="dot"></span><b>' + esc(r.name) + "</b><span>" + esc(r.detail) + "</span></div>";
    }).join("") + "</div>";
    if (!diagR.running && !diagR.items.length) h = '<p class="dbg-empty">Press OK to run the checks. It takes about ten seconds.</p>';
    return h;
  }
  function renderDebugPane() {
    var key = DBG_MENU[dbgI][0], h = "";
    if (key === "live") {
      var p = pageInfo(), last = DBG.api.slice(-4).reverse();
      h = dbgTable([["Frame rate", fpsM.now + " fps" + (fpsAvg() ? " (average " + fpsAvg() + ")" : "")],
        ["Long frames (over 50 ms)", String(fpsM.long), fpsM.long > 20 ? "warn" : ""], ["Worst frame", Math.round(fpsM.worst) + " ms"],
        ["JS memory", p.heap_mb == null ? "n/a" : p.heap_mb + " MB"], ["This page has run", ago(p.uptime_s * 1000)],
        ["Bridge", last.length ? (last[0].ok ? "ok, last call " + last[0].ms + " ms" : "last call failed") : "no calls yet", last.length && !last[0].ok ? "bad" : ""],
        ["Focus", p.zone], ["Mode", p.mode]]);
      h += '<div class="dbg-sub">Recent calls</div>' + (last.length ? dbgTable(last.map(function (c) { return [c.m + " " + c.p, (c.ok ? "" : "failed \u00b7 ") + c.ms + " ms", c.ok ? "" : "bad"]; })) : '<p class="dbg-empty">None yet.</p>');
    } else if (key === "run") h = dbgResults();
    else if (key === "console") h = '<div class="dbg-sub">Console \u00b7 level: ' + esc(DEVS.level) + "</div>" + dbgLines(DBG.logs);
    else if (key === "screen") {
      var sl = [];
      try { sl = JSON.parse(window.TVOS && TVOS.screenLog ? TVOS.screenLog() : "[]"); } catch (e) {}
      h = '<div class="dbg-sub">When the screen went off and on, and which app was in front (? = usage access not granted)</div>' +
        (sl.length ? '<div class="dbg-log">' + sl.slice(-13).map(function (x) {
          var d = new Date(x.t);
          return '<div class="info"><b>' + dpad(d.getMonth() + 1) + "/" + dpad(d.getDate()) + " " + dpad(d.getHours()) + ":" + dpad(d.getMinutes()) + ":" + dpad(d.getSeconds()) + "</b> " + esc(x.e + " " + (x.d || "")) + "</div>";
        }).join("") + "</div>" : '<p class="dbg-empty">Nothing recorded yet (needs the new app version).</p>');
    }
    else if (key === "errors") h = '<div class="dbg-sub">Errors since this page started</div>' + dbgLines(DBG.errs.map(function (x) { return x; }));
    else if (key === "storage") {
      var st = storageInfo();
      h = dbgTable([["Stored on this TV", fmtBytes(st.total) + " in " + st.keys.length + " keys"]].concat(st.keys.slice(0, 9).map(function (k) { return [k.key, fmtBytes(k.bytes)]; })));
    } else if (key === "settings") h = '<pre class="dbg-pre">' + esc(JSON.stringify(safeSettings(), null, 1)) + "</pre>";
    else if (key === "page") {
      var pi = pageInfo();
      h = dbgTable([["App", pi.app], ["WebView", "Chrome " + pi.webview], ["Screen", pi.screen + " @ " + pi.dpr + "x"], ["Window", pi.viewport],
        ["Online", pi.online ? "yes" : "no"], ["Loaded from", pi.mode], ["Address", pi.url]]);
    } else if (key === "send") {
      h = '<p class="dbg-p">OK sends everything this page knows to the computer: the checks, the console, the errors, the settings (the PIN is never included).</p>' +
        (dbgSent ? dbgTable([["Last sent", dbgSent.name], ["Saved at", dbgSent.path]]) : "");
    } else if (key === "phone") {
      h = '<p class="dbg-p">Open this on a phone on the same Wi-Fi to read the latest report:</p><div class="dbg-url">' + esc(phoneUrl()) + "</div>" +
        '<p class="dbg-p">Send diagnostics first, then open it.</p>';
    } else h = '<p class="dbg-p">Back to Settings.</p>';
    var pane = $("debug-pane"), keep0 = pane.scrollTop;
    pane.innerHTML = h;
    pane.scrollTop = key === "run" && diagR.running ? pane.scrollHeight : keep0;   // while it runs, follow the newest line
  }
  function renderDebug() {
    $("debug-menu").innerHTML = DBG_MENU.map(function (m, i) {
      return '<div class="srow dbg-item' + (i === dbgI ? " focus" : "") + '"><span class="sl">' + esc(m[1]) + "</span></div>";
    }).join("");
    renderDebugPane();
    $("debug-note").textContent = dbgFlash;
  }
  function openDebug() {
    zone = "debug"; dbgI = 0; dbgFlash = "";
    fpsM.long = 0; fpsM.worst = 0;
    enter($("debug"));
    renderDebug();
    fpsSync();
  }
  function closeDebug() {
    leave($("debug"));
    zone = "settings";
    fpsSync();
    paintFocus();
  }
  function debugMove(dy) { dbgI = Math.max(0, Math.min(DBG_MENU.length - 1, dbgI + dy)); dbgFlash = ""; renderDebug(); $("debug-pane").scrollTop = 0; }
  function debugOk() {
    var k = DBG_MENU[dbgI][0];
    if (k === "run") runDiag();
    else if (k === "send") sendDiag();
    else if (k === "close") closeDebug();
  }

  function dres(name, status, detail, ms) {
    diagR.items.push({ name: name, status: status, detail: detail, ms: ms == null ? null : Math.round(ms) });
    if (zone === "debug") renderDebugPane();
  }
  function timed(path) {
    var t0 = performance.now();
    return api("GET", path, null, 8000).then(function (j) { return { ok: true, ms: performance.now() - t0, j: j }; },
      function (e) { return { ok: false, ms: performance.now() - t0, err: (e && e.message) || "failed" }; });
  }
  function runDiag() {
    if (diagR.running) return diagR.promise;
    diagR = { running: true, items: [], at: Date.now(), system: null, ping: null };
    dbgFlash = "";
    fpsSync();
    if (zone === "debug") renderDebug();
    var pings = [];
    function pingN(n) { return n ? timed("/api/diag/ping").then(function (r) { pings.push(r); return pingN(n - 1); }) : null; }
    diagR.promise = pingN(5).then(function () {
      var good = pings.filter(function (p) { return p.ok; }), ms = good.map(function (p) { return p.ms; });
      if (!good.length) dres("Bridge", "fail", "No answer from the computer" + (pings[0] && pings[0].err ? ": " + pings[0].err : ""));
      else {
        var avg = ms.reduce(function (a, b) { return a + b; }, 0) / ms.length;
        diagR.ping = Math.round(avg);
        dres("Bridge", avg > 400 ? "warn" : "ok", "ping " + Math.round(avg) + " ms on average (best " + Math.round(Math.min.apply(null, ms)) + ", worst " + Math.round(Math.max.apply(null, ms)) + ")" + (good.length < 5 ? ", " + (5 - good.length) + " lost" : ""), avg);
      }
      return timed("/api/diag/system");
    }).then(function (r) {
      if (!r.ok) { dres("TV over ADB", "fail", r.err, r.ms); return; }
      var tv = r.j.tv || {}, br = r.j.bridge || {};
      diagR.system = r.j;
      dres("TV over ADB", tv.adb_ok ? "ok" : "fail", tv.adb_ok ? "connected" : (tv.adb_error || "not connected"), r.ms);
      if (tv.model) dres("TV", "ok", [tv.maker, tv.model].filter(Boolean).join(" ") + " \u00b7 Android " + (tv.android || "?") + " \u00b7 up " + ago((tv.uptime_s || 0) * 1000));
      if (tv.storage) { var u = parseInt(tv.storage.use, 10); dres("TV storage", u > 90 ? "warn" : "ok", tv.storage.use + " used, " + fmtBytes(tv.storage.free_kb * 1024) + " free"); }
      if (tv.mem_memtotal_kb) {
        var av = tv.mem_memavailable_kb != null ? tv.mem_memavailable_kb : tv.mem_memfree_kb, pc = Math.round(100 * av / tv.mem_memtotal_kb);
        dres("TV memory", pc < 8 ? "warn" : "ok", fmtBytes(av * 1024) + " available of " + fmtBytes(tv.mem_memtotal_kb * 1024) + " (" + pc + "%)");
      }
      if (tv.load && tv.load.length) dres("TV processor load", tv.cpu_cores && tv.load[0] > tv.cpu_cores * 2 ? "warn" : "ok", tv.load.join(" / ") + (tv.cpu_cores ? " on " + tv.cpu_cores + " cores" : ""));
      var w = tv.last_wake;
      dres("Wake-on-LAN", w && w.failed ? "warn" : "ok", w ? w.sent + " packets sent, " + w.failed + " failed, " + ago(Date.now() - w.at * 1000) + " ago" : "not used since the bridge started");
      dres("Claude", br.claude_cli ? "ok" : "warn", br.claude_cli ? "the claude command is on the computer" : "no claude command on the computer (Ask will not work)");
      dres("Bridge program", "ok", "up " + ago((br.uptime_s || 0) * 1000) + " \u00b7 Python " + br.python);
    }).then(function () {
      var chain = Promise.resolve();
      ["/api/people", "/api/weather", "/api/arrange", "/api/continue"].forEach(function (p) {
        chain = chain.then(function () {
          return timed(p).then(function (r) { dres("GET " + p, r.ok ? (r.ms > 1500 ? "warn" : "ok") : "fail", r.ok ? Math.round(r.ms) + " ms" : r.err, r.ms); });
        });
      });
      return chain;
    }).then(function () {
      var pi = pageInfo(), st = storageInfo(), l0 = fpsM.long;
      dres("WebView", "ok", "Chrome " + pi.webview + " \u00b7 " + pi.screen + " at " + pi.dpr + "x \u00b7 " + pi.mode);
      dres("Page storage", st.total > 4000000 ? "warn" : "ok", st.keys.length + " keys, " + fmtBytes(st.total));
      dres("Errors in this page", DBG.errs.length ? "warn" : "ok", DBG.errs.length ? DBG.errs.length + " since it started (see Errors)" : "none");
      return new Promise(function (res) { setTimeout(res, 2200); }).then(function () {
        var f = fpsM.now;
        dres("Frame rate", f && f < 24 ? "warn" : "ok", (f || "?") + " fps, " + (fpsM.long - l0) + " long frames in two seconds");
      });
    }).catch(function (e) {
      dres("Diagnostics", "fail", String((e && e.message) || e));
    }).then(function () {
      diagR.running = false;
      var c = { ok: 0, warn: 0, fail: 0 };
      diagR.items.forEach(function (i) { c[i.status] = (c[i.status] || 0) + 1; });
      dbgFlash = "Done: " + c.ok + " fine" + (c.warn ? ", " + c.warn + " to look at" : "") + (c.fail ? ", " + c.fail + " failed" : "") + ".";
      fpsSync();
      if (zone === "debug") renderDebug();
    });
    return diagR.promise;
  }
  function sendDiag() {
    var go = function () {
      dbgFlash = "Sending\u2026"; renderDebug();
      var st = storageInfo();
      var report = { created: new Date().toISOString(), app: ABOUT.name + " " + ABOUT.version,
        page: Object.assign(pageInfo(), { fps: { now: fpsM.now, avg: fpsAvg(), long: fpsM.long, worst: Math.round(fpsM.worst) } }),
        system: diagR.system, results: diagR.items, timing: { ping_ms: diagR.ping, api: DBG.api.slice(-40) },
        console: DBG.logs.slice(-100), errors: DBG.errs.slice(-50), storage: { total: st.total, keys: st.keys.slice(0, 30) },
        settings: safeSettings(), developer: { on: DEV, fps_overlay: DEVS.fps, guides: DEVS.guides, log_level: DEVS.level } };
      return api("POST", "/api/diag/report", report, 20000).then(function (j) {
        dbgSent = j; dbgFlash = "Sent. Open " + phoneUrl() + " on a phone.";
        if (zone === "debug") renderDebug();
      }, function (e) { dbgFlash = "Couldn't send: " + e.message; if (zone === "debug") renderDebug(); });
    };
    if (diagR.running) diagR.promise.then(go);
    else if (!diagR.items.length) runDiag().then(go);
    else go();
  }

  // the Developer rows of Settings
  function devChange(r, next) {
    if (r.k === "dev:fps") DEVS.fps = !!+next;
    else if (r.k === "dev:guides") DEVS.guides = !!+next;
    else if (r.k === "dev:level") DEVS.level = next;
    devApply();
    renderSettings();
  }
  function devClearCaches() {
    keep(CACHE_KEY, null, true); keep("tvhome.sun", null, true);
    try { sessionStorage.clear(); } catch (e) {}
    setFlash = "Caches cleared. Reload the home to build them again."; renderSettings();
  }
  function devOffline() {
    if (!TV) { setFlash = "The saved copy only exists in the TV app."; renderSettings(); return; }
    location.href = "http://home.tvos.invalid/tv/index.html?offline=1" + (TV_ID ? "&tv=" + TV_ID : "");
  }
  function devMock() { location.href = withParam(location.href, "mock", "1"); }

  // ---------------- Settings, on the TV itself ----------------
  // Everything here is kept on this TV (tvhome.settings) and wins over config.json. Up and down pick a row,
  // left and right (or OK) change it, Back closes. Anything that needs the page to start again does so on close.
  var setI = 0, setDirty = false, setFlash = "", setConfirm = "";
  function dateStyle() { return SET.date || ((CFG.country || "") === "US" ? "us" : "intl"); }
  function tempUnit() { return SET.unit || ((CFG.country || "") === "US" ? "F" : "C"); }
  function shownTemp(c) { return tempUnit() === "F" ? Math.round(c * 9 / 5 + 32) : c; }
  var SCENE_NAMES = { night: "Night", golden: "Golden hour", water: "Waterline", fog: "Fog", dawn: "Dawn" };
  function sceneOn(id) { return SCENES.some(function (x) { return x.id === id; }); }
  function setRows() {
    var rows = [
      { k: "clock", label: "Clock", cur: CLOCK24 ? "24h" : "12h", opts: [["12h", "12-hour"], ["24h", "24-hour"]] },
      { k: "unit", label: "Temperature", cur: tempUnit(), opts: [["F", "Fahrenheit"], ["C", "Celsius"]] },
      { k: "date", label: "Date style", cur: dateStyle(), opts: [["us", "Monday, October 26"], ["intl", "Monday 26 October"]] },
      { k: "secs", label: "Each scene lasts", cur: Math.round(SCENE_MS / 1000), opts: [[10, "10 seconds"], [20, "20 seconds"], [30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"]] },
      { k: "dock", label: "Apps in the dock", cur: DOCK_APPS, opts: [4, 5, 6, 7, 8, 9, 10].map(function (n) { return [n, String(n)]; }) },
      { k: "arr:mode", label: "Arrange apps", cur: arrMode(), opts: Arr.MODES.map(function (m) { return [m, Arr.LABELS[m]]; }) },
      { k: "arr:group", label: "Group apps", cur: ARR.prefs.group ? 1 : 0, opts: [[1, "On"], [0, "Off"]] },
      { k: "arr:hidden", label: "Hidden apps tab", cur: ARR.prefs.show_hidden ? 1 : 0, opts: [[1, "Shown"], [0, "Off"]] }
    ];
    SCENES_ALL.forEach(function (sc) {
      rows.push({ k: "scene:" + sc.id, label: "Scene: " + (SCENE_NAMES[sc.id] || sc.id), cur: sceneOn(sc.id) ? 1 : 0, opts: [[1, "On"], [0, "Off"]] });
    });
    var names = { sleep: "Sleep timer button", input: "Input button", picpage: "Picture settings button", game: "Game mode button", ask: "Ask Claude button" };
    ["sleep", "input", "picpage", "game", "ask"].forEach(function (q) {
      if (q === "ask" ? !askOn() : (TVCFG.quick || []).indexOf(q) < 0) return;
      rows.push({ k: "q:" + q, label: names[q], cur: QUICK.indexOf(q) >= 0 ? 1 : 0, opts: [[1, "Shown"], [0, "Hidden"]] });
    });
    rows.push({ k: "!picpage", label: "Picture settings (Movie, Game, Sports…)", action: "Open" });
    rows.push({ k: "!game", label: "Game mode (TV game bar)", action: "Open" });
    if (pinOn()) {
      rows.push({ k: "!pinchg", label: "Change the PIN", action: "Change" });
      rows.push({ k: "!pinoff", label: "Remove the PIN", action: "Remove" });
    } else rows.push({ k: "!pinset", label: "Lock Settings with a PIN", action: "Set up" });
    rows.push({ k: "!rhome", label: "Restart this home screen", action: "Restart" });
    rows.push({ k: "!reboot", label: rebootAsk ? "Press OK again to reboot the TV" : "Reboot the TV (fixes most glitches)", action: rebootAsk ? "Confirm" : "Reboot" });
    rows.push({ k: "!backup", label: "Back up everything", action: "Back up now" });
    rows.push({ k: "!restore", label: "Restore the latest backup", action: setConfirm === "!restore" ? "Press OK to restore" : "Restore" });
    rows.push({ k: "!android", label: "The TV's own settings", action: "Open" });
    WEB.forEach(function (w) {
      rows.push({ k: "!web:" + w.id, label: "Web app: " + w.name, action: setConfirm === "!web:" + w.id ? "Press OK to remove" : "Remove" });
    });
    rows.push({ k: "!webadd", label: "Add a web app", action: "On your phone" });
    rows.push({ k: "!about", label: "About Waike’s tvOS", action: "Open" });
    if (DEV) {
      rows.push({ k: "#dev", head: true, label: "Developer" });
      rows.push({ k: "!debug", label: "Debug page", action: "Open" });
      rows.push({ k: "dev:fps", label: "FPS overlay", cur: DEVS.fps ? 1 : 0, opts: [[1, "On"], [0, "Off"]] });
      rows.push({ k: "dev:guides", label: "Safe area and focus outlines", cur: DEVS.guides ? 1 : 0, opts: [[1, "Shown"], [0, "Hidden"]] });
      rows.push({ k: "dev:level", label: "Log level", cur: DEVS.level, opts: [["error", "Errors"], ["warn", "Warnings"], ["all", "Everything"]] });
      rows.push({ k: "!clearcache", label: "Clear caches", action: "Clear" });
      rows.push({ k: "!offline", label: "Open the saved offline copy", action: "Open" });
      rows.push({ k: "!mock", label: "Reload with mock data", action: "Reload" });
      rows.push({ k: "!reloadhome", label: "Reload home (turns developer mode off)", action: "Reload" });
      rows.push({ k: "!reset", label: "Put all settings back", action: "Reset" });
    }
    rows.push({ k: "!close", label: "Done", action: "Close" });
    return rows;
  }
  function setVal(r) {
    if (r.head) return '<span class="sv"></span>';
    if (r.action) return '<span class="sv act">' + r.action + "</span>";
    var hit = r.opts.filter(function (o) { return String(o[0]) === String(r.cur); })[0];
    return '<span class="sv">\u2039&nbsp;&nbsp;' + esc(hit ? hit[1] : String(r.cur)) + '&nbsp;&nbsp;\u203a</span>';
  }
  function renderSettings() {
    var rows = setRows(), box = $("settings-list");
    setI = Math.max(0, Math.min(rows.length - 1, setI));
    if (setConfirm && rows[setI].k !== setConfirm) { setConfirm = ""; rows = setRows(); }
    var sig = rows.map(function (r) { return r.k; }).join("|"), kids = box.children;
    if (box._sig !== sig || kids.length !== rows.length) {   // a different list: draw it once
      box.innerHTML = rows.map(function (r, i) {
        return '<div class="srow' + (r.head ? " shead" : "") + (i === setI ? " focus" : "") + '"><span class="sl">' + esc(r.label) + "</span>" + setVal(r) + "</div>";
      }).join("");
      box._sig = sig;
      rows.forEach(function (r, i) { kids[i]._v = setVal(r); });
    } else {   // the same rows: only what changed moves, so the focus and the values animate
      rows.forEach(function (r, i) {
        var el = kids[i], v = setVal(r);
        el.classList.toggle("focus", i === setI);
        if (el.firstChild.textContent !== r.label) el.firstChild.textContent = r.label;
        if (el._v !== v) {
          var t = document.createElement("div"); t.innerHTML = v;
          var nv = t.firstChild; el.replaceChild(nv, el.lastChild); el._v = v; pulse(nv, "vchg");
        }
      });
    }
    var nt = setFlash, ne = $("settings-note");
    if (ne.textContent !== nt) { ne.textContent = nt; if (nt) pulse(ne, "pop"); }
    var f = box.querySelector(".focus");
    if (f && f.scrollIntoView) f.scrollIntoView({ block: "nearest" });
  }
  // About / credits. Every line below is checked against the repo (LICENSE, README credits,
  // backgrounds/CREDITS.md); the phone remote's About block repeats the same facts.
  var ABOUT = { name: "Waike\u2019s tvOS", version: "1.0", build: "October 2026" };
  var MIT_TEXT = "MIT License\n\nCopyright (c) 2026 Seagey\nCopyright (c) 2026 Waike (changes and additions in Waike\u2019s tvOS)\n\n" +
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \u201cSoftware\u201d), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n" +
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n" +
    "THE SOFTWARE IS PROVIDED \u201cAS IS\u201d, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.";
  var ABOUT_LOGO = '<svg class="about-logo" viewBox="0 0 120 120" aria-hidden="true"><defs><linearGradient id="alg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset=".55" stop-color="#d8467f"/><stop offset="1" stop-color="#4a2f8a"/></linearGradient></defs>' +
    '<rect width="120" height="120" rx="28" fill="url(#alg)"/><rect x="21" y="27" width="78" height="52" rx="10" fill="none" stroke="#fff" stroke-width="5"/>' +
    '<path d="M46 70 L60 41 L74 70 M51.5 60 H68.5" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M44 93 H76" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
  // The licence page, behind the small "Open-source licences" line at the bottom of About.
  var LIC_NOTES = "Waike\u2019s tvOS includes open-source software and content:\n\n" +
    "\u2022 couch-tv by Seagey, MIT licence (text below)\n\u2022 Inter and Antonio fonts, SIL Open Font Licence 1.1\n\u2022 Weather data by Open-Meteo\n" +
    "\u2022 Show data and posters from JustWatch\n" +
    "\u2022 App logos belong to their owners\n\n";
  var aboutLic = false, aboutOn = "ver";   // which page, and which line has the focus (the version line or the fine print)
  function aboutHtml() {
    return '<div class="about-hero">' + ABOUT_LOGO + "<h2>" + esc(ABOUT.name) + "</h2>" +
      '<div class="about-tag">A calm, fast home screen and phone remote for your TV.</div>' +
      '<div class="about-ver' + (aboutOn === "ver" ? " focus" : "") + '" id="about-ver">Version ' + ABOUT.version + " \u00b7 " + ABOUT.build + "</div>" +
      '<div class="about-dev" id="about-dev"></div>' +
      '<div class="about-by">Designed and developed by Waike</div></div>' +
      '<div class="about-fine' + (aboutOn === "lic" ? " focus" : "") + '" id="about-fine">Open-source licences</div>';
  }
  function aboutLicHtml() {
    return '<div class="about-sec lic-page"><h3>Open-source licences</h3><p class="lic">' + esc(LIC_NOTES + MIT_TEXT) + "</p></div>" +
      '<div class="about-fine focus" id="about-fine">Back to About</div>';
  }
  function aboutPaint() { $("about-body").innerHTML = aboutLic ? aboutLicHtml() : aboutHtml(); }
  function openAbout() {
    aboutLic = false; aboutOn = "ver"; devTaps = 0; devFirst = 0;
    aboutPaint();
    $("about-body").scrollTop = 0;
    zone = "about";
    enter($("about"));
    $("settings").classList.add("behind");
  }
  function closeAbout() {
    leave($("about"));
    $("settings").classList.remove("behind");
    zone = "settings";
    paintFocus();
  }
  function aboutMove(dy) {
    var b = $("about-body");
    if (aboutLic) { b.scrollTop = Math.max(0, Math.min(b.scrollHeight, b.scrollTop + dy * 180)); return; }
    var want = dy > 0 ? "lic" : "ver";
    if (want === aboutOn) return;
    aboutOn = want;
    aboutPaint();
  }
  function aboutOk() {
    if (aboutLic) { aboutLic = false; aboutOn = "lic"; aboutPaint(); $("about-body").scrollTop = 0; return; }
    if (aboutOn === "lic") { aboutLic = true; aboutPaint(); $("about-body").scrollTop = 0; return; }
    aboutTap();
  }
  function aboutBack() { if (aboutLic) aboutOk(); else closeAbout(); }
  function openSettings() {
    if (pinNeeded()) { openPin("check", doOpenSettings); return; }
    doOpenSettings();
  }
  function doOpenSettings() {
    zone = "settings"; setI = 0; setFlash = "";
    enter($("settings"));
    paintFocus();
  }
  function closeSettings() {
    pinUnlockedAt = 0;   // opening Settings again (or any guarded action later) asks for the PIN
    leave($("settings"));
    zone = "quick";
    if (setDirty) { location.reload(); return; }   // the page starts again with what was chosen
    paintFocus();
  }
  function setStep(dy) {
    var rows = setRows(), n = setI + dy;
    while (rows[n] && rows[n].head) n += dy;
    setI = rows[n] ? n : (n < 0 ? 0 : rows.length - 1);
  }
  function saveSet() { keep("tvhome.settings", SET); }
  function changeSet(dir) {
    var r = setRows()[setI];
    if (!r || r.head) return;
    if (r.action) { runSetAction(r); return; }
    var at = 0;
    r.opts.forEach(function (o, i) { if (String(o[0]) === String(r.cur)) at = i; });
    var next = r.opts[(at + dir + r.opts.length) % r.opts.length][0];
    if (r.k.indexOf("dev:") === 0) { devChange(r, next); return; }
    if (r.k === "clock" || r.k === "unit" || r.k === "date" || r.k === "secs" || r.k === "dock") { SET[r.k] = next; saveSet(); }
    else if (r.k.indexOf("arr:") === 0) { arrSet(r.k.slice(4), next); }
    else if (r.k.indexOf("scene:") === 0) {
      var id = r.k.slice(6);
      var on = SCENES.map(function (x) { return x.id; });
      if (next) { if (on.indexOf(id) < 0) on.push(id); }
      else on = on.filter(function (x) { return x !== id; });
      if (!on.length) { setFlash = "At least one scene has to stay on."; renderSettings(); return; }
      var order = SCENES_ALL.map(function (x) { return x.id; });
      SET.scenes = order.filter(function (x) { return on.indexOf(x) >= 0; });
      SCENES = SCENES_ALL.filter(function (x) { return SET.scenes.indexOf(x.id) >= 0; });
      saveSet();
    } else if (r.k.indexOf("q:") === 0) {
      var q = r.k.slice(2), hide = (SET.hide || []).filter(function (x) { return x !== q; });
      if (!next) hide.push(q);
      SET.hide = hide; saveSet();
      QUICK = computeQuick();
    }
    // show it straight away where the page already knows how
    if (r.k === "clock") { CLOCK24 = next === "24h"; glassShown = ""; }
    else if (r.k === "secs") { SCENE_MS = next * 1000; restartSceneTimer(); }
    else if (r.k === "dock") { DOCK_APPS = next; liveRender(); }
    else if (r.k.indexOf("scene:") === 0) rebuildScenes();
    if (LIVE_HOOKS[r.k]) { try { LIVE_HOOKS[r.k](next); } catch (e) {} }
    r.cur = next;
    setFlash = "";
    clock();
    renderSettings();
  }
  // Restart: "Restart this home screen" force-stops and starts this app again; "Reboot" restarts the whole TV
  // (asks twice, 6 s to confirm) and the bridge checks it comes back on this home screen, not Google's setup screen.
  var rebootAsk = false, rebootTimer = null, restartPoll = null;
  function watchRestart() {
    clearInterval(restartPoll);
    var n = 0;
    restartPoll = setInterval(function () {
      if (++n > 100) { clearInterval(restartPoll); return; }
      api("GET", "/api/restart").then(function (j) {
        var s = j.restart || {};
        if (s.phase === "working") { setFlash = s.detail || "Working…"; }
        else if (s.phase === "done") { setFlash = s.detail || "Done."; clearInterval(restartPoll); }
        else if (s.phase === "failed") { setFlash = "Failed: " + (s.detail || "unknown"); clearInterval(restartPoll); }
        if (zone === "settings") $("settings-note").textContent = setFlash;
      }, function () { if (zone === "settings") $("settings-note").textContent = setFlash; });
    }, 3000);
  }
  function runRestart(what) {
    setFlash = what === "home" ? "Restarting the home screen…" : "Rebooting the TV. This takes about a minute.";
    renderSettings();
    api("POST", "/api/restart", { what: what }, 15000).then(function () { watchRestart(); }, function (e) {
      if (what === "home") { location.reload(); return; }   // no bridge or no ADB: at least start this page again
      setFlash = "Couldn't reboot: " + e.message; renderSettings();
    });
  }
  function runSetAction(r) {
    if (PIN_GUARDED.indexOf(r.k) >= 0 && pinNeeded()) { openPin("check", function () { runSetAction(r); }); return; }
    if (r.k === "!pinset") { openPin("new", function () { setFlash = "PIN is on. Settings will ask for it."; renderSettings(); }); return; }
    if (r.k === "!pinchg") {
      openPin("check", function () { openPin("new", function () { setFlash = "PIN changed."; renderSettings(); }); });
      return;
    }
    if (r.k === "!pinoff") {
      openPin("check", function () { delete SET.pin; keep("tvhome.settings", SET); setFlash = "PIN removed."; renderSettings(); });
      return;
    }
    if (r.k === "!rhome") { runRestart("home"); return; }
    if (r.k === "!reboot") {
      if (!rebootAsk) {
        rebootAsk = true; setFlash = "Press OK again within 6 seconds to reboot the TV."; renderSettings();
        clearTimeout(rebootTimer);
        rebootTimer = setTimeout(function () { rebootAsk = false; setFlash = ""; if (zone === "settings") renderSettings(); }, 6000);
      } else { rebootAsk = false; clearTimeout(rebootTimer); runRestart("reboot"); }
      return;
    }
    if (r.k === "!picpage" || r.k === "!game") { closeSettings(); openTvPage(r.k === "!game" ? "game" : "picture"); return; }
    if (r.k === "!webadd") { setFlash = "Open the TV tab on your phone remote, then Web apps, to add a website."; renderSettings(); return; }
    if (r.k.indexOf("!web:") === 0) {
      if (setConfirm !== r.k) { setConfirm = r.k; setFlash = "Press OK again to remove it from the TV (the website itself is untouched)."; renderSettings(); return; }
      setConfirm = ""; setFlash = "Removing…"; renderSettings();
      api("POST", "/api/webapps", { action: "remove", id: r.k.slice(5) }).then(function (j) {
        WEB = j.webapps || []; keep("tvhome.webapps", WEB); setFlash = "Removed."; refresh(); renderSettings();
      }, function (e) { setFlash = "Couldn't remove it: " + e.message; renderSettings(); });
      return;
    }
    if (r.k === "!about") { openAbout(); return; }
    if (r.k === "!debug") { openDebug(); return; }
    if (r.k === "!reloadhome") { location.reload(); return; }
    if (r.k === "!clearcache") { devClearCaches(); return; }
    if (r.k === "!offline") { devOffline(); return; }
    if (r.k === "!mock") { devMock(); return; }
    if (r.k === "!close") { closeSettings(); return; }
    if (r.k === "!reset") {
      SET = {}; keep("tvhome.settings", SET);
      ARR.prefs = Arr.prefs(null); arrSavePrefs();
      reapplyAll(); setFlash = "Everything is back the way it started."; renderSettings(); return;
    }
    if (r.k === "!backup") {
      setFlash = "Saving a backup…"; renderSettings();
      api("POST", "/api/backup/save", {}, 20000).then(function (j) {
        setFlash = "Saved on the computer: " + j.name + " (in the backups folder)"; renderSettings();
      }, function (e) { setFlash = "Couldn't back up: " + e.message; renderSettings(); });
      return;
    }
    if (r.k === "!restore") {
      if (setConfirm !== "!restore") {
        setConfirm = "!restore"; setFlash = "This puts back your last backup. Press OK again to do it, or move away to cancel.";
        renderSettings(); return;
      }
      setConfirm = ""; setFlash = "Restoring…"; renderSettings();
      api("POST", "/api/restore", { latest: true }, 30000).then(function (j) {
        setFlash = "Restored: " + (j.restored || []).join(", ") + ". Starting again…"; renderSettings();
        return syncDown().then(function () { reapplyAll(); setFlash = "Restored. What you see is the restored settings."; renderSettings(); });
      }, function (e) { setFlash = "Couldn't restore: " + e.message; renderSettings(); });
      return;
    }
    if (r.k === "!android") {
      var ok = false;
      try { ok = !!(TV && TV.launch && TV.launch(SETTINGS_PKG)); } catch (e) {}
      if (!ok) api("POST", "/api/launch", { app: "settings" }).catch(function () {});
    }
  }

  function refreshQuick() {
    var jobs = [];
    if (QUICK.indexOf("sleep") >= 0) {
      jobs.push(api("GET", "/api/sleep").then(function (j) { sleepEnds = j.ends ? Date.parse(j.ends) : null; }, function () {}));
    }
    if (QUICK.indexOf("picture") >= 0) {
      jobs.push(api("GET", "/api/picture").then(function (j) {
        picShown = j.supported !== false;
        picMode = j.mode || null; picCanSet = !!j.can_set;
        if (j.modes && j.modes.length) picModes = j.modes;
      }, function () { picShown = false; picCanSet = false; }));
    }
    return Promise.all(jobs).then(renderQuick);
  }

  // ---------------- Keep watching ----------------
  // ---------------- who is watching: none, a pill switch for two, a head icon and a list for more ----------------
  var PALETTE = ["#ff9f0a", "#30b350", "#0a84ff", "#bf5af2", "#ff375f", "#00a5a8", "#5e5ce6", "#ac8e68"];
  function peopleCount() { return NOBODY ? 0 : PEOPLE.length; }
  function isHead() { return peopleCount() >= 3; }
  function colourOf(p) {
    if (p.colour) return p.colour;
    for (var h = 0, i = 0; i < p.id.length; i++) h = (h * 31 + p.id.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function avatarHTML(p) {
    return '<span class="avatar" style="background:' + esc(colourOf(p)) + '">' + esc((p.name || "?").trim().charAt(0).toUpperCase()) + "</span>";
  }
  function whoIndex() { return Math.max(0, PEOPLE.map(function (p) { return p.id; }).indexOf(who)); }

  function renderPeople() {
    var el = $("people"), n = peopleCount();
    el.classList.toggle("none", n < 2);
    el.classList.toggle("head", n >= 3);
    if (n >= 3) {
      var cur = PEOPLE[whoIndex()];
      el.innerHTML = avatarHTML(cur) + '<span class="sr">' + esc(cur.name) + "</span>";
    } else {
      el.innerHTML = PEOPLE.map(function (p) {
        return '<span class="person' + (p.id === who ? " on" : "") + '">' + esc(p.name) + "</span>";
      }).join("");
    }
    renderPop();
  }

  function renderPop() {
    var el = $("people-pop");
    if (!el.classList.contains("on")) return;
    var psig = PEOPLE.map(function (p) { return p.id + p.name; }).join("|");
    if (el._sig === psig && el.querySelector(".plist")) {   // same names: only the classes and marks change, so the focus springs
      Array.prototype.forEach.call(el.querySelectorAll(".prow"), function (row, i) {
        var p = PEOPLE[i]; if (!p) return;
        row.className = "prow" + (i === pmi ? " focus" : "") + (plift && i === pmi ? " lifted" : "") + (p.id === who ? " on" : "");
        var mk = row.querySelector(".pmark"), tail = plift && i === pmi ? ICONS.updown : p.id === who ? ICONS.check : "";
        if (!tail && mk) row.removeChild(mk);
        else if (tail) { if (!mk) { mk = document.createElement("i"); mk.className = "pmark"; row.appendChild(mk); } if (mk._t !== tail) { mk.innerHTML = tail; mk._t = tail; } }
      });
      el.querySelector(".phint").textContent = plift ? "Up and down to move, OK to drop" : "Hold OK on a name to move it";
      return;
    }
    el._sig = psig;
    el.innerHTML = '<div class="plist">' + PEOPLE.map(function (p, i) {
      var cls = "prow" + (i === pmi ? " focus" : "") + (plift && i === pmi ? " lifted" : "") + (p.id === who ? " on" : "");
      var tail = plift && i === pmi ? '<i class="pmark">' + ICONS.updown + "</i>" : p.id === who ? '<i class="pmark">' + ICONS.check + "</i>" : "";
      return '<div class="' + cls + '">' + avatarHTML(p) + "<b>" + esc(p.name) + "</b>" + tail + "</div>";
    }).join("") + '</div><p class="phint">' + (plift ? "Up and down to move, OK to drop" : "Hold OK on a name to move it") + "</p>";
  }
  function openPop() {
    zone = "pmenu"; pmi = whoIndex(); plift = false;
    enter($("people-pop"));
    renderPop();
  }
  function closePop() {
    leave($("people-pop"));
    setTimeout(function () { var p = $("people-pop"); if (!p.classList.contains("on")) { p.innerHTML = ""; p._sig = ""; } }, 320);
    plift = false;
    zone = "people";
  }
  function pickWho(id) {
    if (id === who) return;
    who = id; s = 0;
    try { localStorage.setItem("tvhome.who", who); } catch (e) {}
    if (!NOBODY) api("POST", "/api/who", { who: who }).catch(function () {});
    renderShelf();
  }
  // The order of the names: kept by the bridge (the phone's People sheet uses the same list), or on
  // this TV when there is no bridge. "pending" means the bridge has not heard about it yet.
  function savePeopleOrder() {
    var ids = PEOPLE.map(function (p) { return p.id; });
    keep("tvhome.people.order", { ids: ids, pending: true });
    if (OFFLINE || data.bridge === false) return;
    api("POST", "/api/people", { order: ids })
      .then(function () { keep("tvhome.people.order", { ids: ids, pending: false }); }, function () {});
  }
  function dropPeople() {
    plift = false;
    savePeopleOrder();
    renderPeople();
  }

  function renderShelf() {
    var track = $("shelf");
    data.shows = data.showsBy[who] || [];
    var anyone = PEOPLE.some(function (p) { return (data.showsBy[p.id] || []).length; });
    // nobody has anything on the go: no empty box, the photo has the space
    $("shelf-section").classList.toggle("empty", !anyone);
    $("people").classList.toggle("empty", !anyone);
    renderPeople();
    if (!data.shows.length) {
      var name = PEOPLE[whoIndex()].name;
      track.innerHTML = '<p class="shelf-none">' + (peopleCount() < 2 ? "Nothing on the go yet." : "Nothing on the go for " + esc(name) + " yet.") + "</p>";
      shelfEls = [];
      return;
    }
    // lock screen notifications: the first three shows as glass cards
    data.shows = data.shows.slice(0, 3);
    track.innerHTML = data.shows.map(function (it) {
      var art = it.backdrop || it.poster, pkg = it.app && it.app.package;
      var ep = it.season && it.episode ? "S" + it.season + " E" + it.episode : (it.episode_title || "");
      return '<div class="tile ncard">' +
        (art ? '<img class="thumb" src="' + esc(art) + '" alt="" decoding="async">' : '<span class="thumb none"></span>') +
        '<div class="t"><div class="nap">' + (pkg && iconUrl(pkg) ? '<img src="' + esc(iconUrl(pkg)) + '" alt="" onerror="this.remove()">' : "") +
        esc(it.app ? it.app.name : "") + "</div><b>" + esc(it.title) + "</b>" + (ep ? "<i>" + esc(ep) + "</i>" : "") +
        (it.progress ? '<span class="nbar"><i style="width:' + Math.round(it.progress * 100) + '%"></i></span>' : "") + "</div></div>";
    }).join("");
    shelfEls = Array.prototype.slice.call(track.children);
  }

  // ---------------- auto arrange ----------------
  // Groups, sort modes and the Hidden tab for the apps. The rules are in arrange-rules.js and the steps
  // in arrange.js (bridge/arrange.py does the same for the phone). Picked in Settings or on the phone.
  // Only what the home shows changes; no app is ever disabled or removed from the TV.
  var Arr = window.Arrange;
  var ARR = { prefs: Arr.prefs(kept("tvhome.arrange")), usage: kept("tvhome.usage") || {}, headers: false };
  function arrMode() { return Arr.mode(ARR.prefs, !!(data.order && data.order.saved)); }
  function arrSavePrefs() {
    keep("tvhome.arrange", ARR.prefs, true);
    if (OFFLINE || MOCK || PREVIEW) return;
    api("POST", "/api/arrange", { prefs: ARR.prefs }).catch(function () {});
  }
  function arrSet(k, v) {
    if (k === "mode") ARR.prefs.mode = v;
    else if (k === "group") ARR.prefs.group = !!v;
    else if (k === "hidden") ARR.prefs.show_hidden = !!v;
    arrSavePrefs();
    liveRender();
  }
  // every opening counts: Most used, Recently used and Smart follow what is really watched
  function arrUsed(pkg) {
    var u = ARR.usage[pkg] || { n: 0, t: 0 };
    ARR.usage[pkg] = { n: u.n + 1, t: Math.floor(Date.now() / 1000) };
    keep("tvhome.usage", ARR.usage, true);
    if (OFFLINE || MOCK || PREVIEW || data.bridge === false) return;
    api("POST", "/api/app-used", { package: pkg }).catch(function () {});
  }
  // the bridge keeps the settings and counts for the phone and the backup; this TV takes the larger counts
  function arrLoad() {
    if (OFFLINE || MOCK) return Promise.resolve();
    return api("GET", "/api/arrange").then(function (j) {
      ARR.prefs = Arr.prefs(j.prefs);
      var back = false, bu = j.usage || {};
      Object.keys(ARR.usage).forEach(function (p) { if (!bu[p] || bu[p].n < ARR.usage[p].n) back = true; });
      Object.keys(bu).forEach(function (p) {
        var l = ARR.usage[p];
        if (!l || l.n < bu[p].n) ARR.usage[p] = { n: bu[p].n, t: Math.max(bu[p].t, l ? l.t : 0) };
      });
      keep("tvhome.arrange", ARR.prefs, true);
      keep("tvhome.usage", ARR.usage, true);
      if (back && !PREVIEW) api("POST", "/api/arrange", { usage: ARR.usage }).catch(function () {});
    });
  }
  // All apps with names over each group: the first app of a group carries its name (gstart).
  // The App Store and Settings lead the Tools group.
  function arrGroupRows(list) {
    var by = {};
    list.forEach(function (it) {
      var g = it.kind === "screen" ? "screens" : (it.group || "utilities");
      (by[g] = by[g] || []).push(it);
    });
    var out = [];
    Arr.categories.filter(function (c) { return c !== "hidden"; }).concat(["screens", "hidden"]).forEach(function (g) {
      var a = by[g];
      if (!a || !a.length) return;
      a = a.filter(function (x) { return x.lead; }).concat(a.filter(function (x) { return !x.lead; }));
      var first = Object.assign({}, a[0], { gstart: g === "screens" ? "Screens" : Arr.label(g) });
      out.push(first);
      out = out.concat(a.slice(1));
    });
    return out;
  }
  // Hold OK on an app while an automatic order is on: in All apps it goes to home (pinned), in the
  // Hidden tab it comes back; on the dock it means moving by hand, which switches to My order.
  function arrHold(a, arr, idx) {
    var P = ARR.prefs;
    if (idx < 0) {
      if (!(arr.hidden || []).some(function (x) { return x.package === a.package; })) return false;
      P.hidden = P.hidden.filter(function (x) { return x !== a.package; });
      if (Arr.classify(a.package, a.name) === "hidden" && P.shown.indexOf(a.package) < 0) P.shown.push(a.package);
      arrSavePrefs();
      renderGrid(); paintFocus();
      flash(a.name + " is back in All apps.");
      return true;
    }
    if (expanded) {
      if (idx < arr.line) { flash(a.name + " is already on home."); return true; }
      P.pinned = P.pinned.filter(function (x) { return x !== a.package; }).concat([a.package]);
      arrSavePrefs();
      expanded = false;
      renderGrid();
      g = 0;
      gridItems.forEach(function (it, i) { if (it.package === a.package) g = i; });
      paintFocus();
      flash(a.name + " is pinned to home.");
      return true;
    }
    // moving apps by hand: keep what is on screen as the order, and switch to My order
    data.order = { saved: true, line: arr.line, packages: arr.items.concat(arr.hidden || []).map(function (it) { return it.package; }) };
    P.mode = "manual";
    arrSavePrefs();
    flash("Switched to My order.");
    return null;
  }

  // ---------------- apps ----------------
  function tucked(a) {
    return TUCKED.indexOf(a.package) >= 0 || TUCKED_NAMES.test(a.name || "");
  }
  function isNew(pkg) { return newApps.indexOf(pkg) >= 0; }
  // A dock of the first ten apps (home.dock_size), then Settings, then More apps (which shows
  // everything, the App Store first). The order and the More apps line come from Arrange apps on the
  // phone, or from moving apps with the TV remote (hold OK), once one is saved.
  function arrangeItems() {
    var rest = data.apps.filter(function (a) { return a.package !== SETTINGS_PKG && a.package !== STORE_PKG; });
    var screens = data.screens.map(function (sc) {
      return { kind: "screen", id: sc.id, name: sc.name, ready: sc.ready, note: sc.note, package: "screen:" + sc.id };
    });
    if (arrMode() !== "manual") {
      var res = Arr.sort(rest, ARR.prefs, ARR.usage, null);
      var vis = res.items.filter(function (it) { return !it.hidden; });
      return { items: vis.concat(screens), line: Math.min(DOCK_APPS, vis.length),
        hidden: res.items.filter(function (it) { return it.hidden; }), headers: res.headers };
    }
    var items = rest.filter(function (a) { return !tucked(a); }).concat(screens, rest.filter(tucked));
    var line = Math.min(DOCK_APPS, rest.filter(function (a) { return !tucked(a); }).length);
    var o = data.order;
    if (o && o.saved) {
      var at = {};
      o.packages.forEach(function (p, i) { at[p] = i; });
      var known = items.filter(function (it) { return at[it.package] !== undefined; })
        .sort(function (a, b) { return at[a.package] - at[b.package]; });
      var gained = items.filter(function (it) { return at[it.package] === undefined; });   // new apps go below the line
      items = known.concat(gained);
      // the line counts the apps above it that this TV still has
      var above = o.packages.slice(0, o.line).filter(function (p) { return known.some(function (it) { return it.package === p; }); }).length;
      line = Math.min(DOCK_APPS, above);
    }
    return { items: items, line: line };
  }

  function dockList() {
    var settings = data.apps.filter(function (a) { return a.package === SETTINGS_PKG; })[0];
    var store = data.apps.filter(function (a) { return a.package === STORE_PKG; })[0];
    var arr = arrangeItems();
    var list = expanded ? arr.items.slice() : arr.items.slice(0, arr.line);
    if (expanded && arr.hidden && ARR.prefs.show_hidden) list = list.concat(arr.hidden);   // the Hidden tab, last
    ARR.headers = false;
    if (expanded && arr.headers) {
      var lead = [];
      if (store) lead.push({ kind: "app", store: true, name: "App Store", package: STORE_PKG, id: store.id, group: "utilities", lead: true });
      if (settings) lead.push(Object.assign({}, settings, { group: "utilities", lead: true }));
      ARR.headers = true;
      return arrGroupRows(lead.concat(list));
    }
    if (expanded && store) list.unshift({ kind: "app", store: true, name: "App Store", package: STORE_PKG, id: store.id });
    if (settings) list.push(settings);
    if (!expanded) list.push({ kind: "more", name: "More apps" });
    return list;
  }

  // Tell the bridge which apps this TV has (in its default order), so the phone can arrange them.
  var reported = "";
  function reportApps() {
    if (MOCK || PREVIEW || !data.apps.length) return;
    var saved = data.order;
    data.order = null;   // the default order, not the arranged one
    var arr = arrangeItems();
    data.order = saved;
    var payload = { apps: arr.items.concat(arr.hidden || []).map(function (it) { return { package: it.package, name: it.name }; }), line: arr.line };
    var key = JSON.stringify(payload);
    if (key === reported) return;
    api("POST", "/api/home-apps", payload).then(function () { reported = key; }, function () {});
  }

  // ---------------- moving apps with the TV remote ----------------
  // The arrangement as it is on screen, written down as a saved order, so it can be changed.
  function materialise() {
    var arr = arrangeItems();
    data.order = { saved: true, line: arr.line, packages: arr.items.concat(arr.hidden || []).map(function (it) { return it.package; }) };
    return arr;
  }
  // Saved through the bridge (the phone's Arrange apps reads the same order), or on this TV with no
  // bridge. A TV-only order is marked pending and handed to the bridge the next time it answers.
  function persistOrder() {
    var o = data.order;
    var local = { line: o.line, packages: o.packages, pending: true };
    keep("tvhome.order.tv", local);
    save();
    if (OFFLINE || data.bridge === false) return;
    api("POST", "/api/app-order", { order: o.packages, line: o.line })
      .then(function () { local.pending = false; keep("tvhome.order.tv", local); }, function () {});
  }
  function nameOf(pkg) {
    var it = arrangeItems().items.filter(function (x) { return x.package === pkg; })[0];
    return it ? it.name : "That app";
  }
  var hintTimer = null, hintFlash = "";
  function renderHint() {
    var text = hintFlash ||
      (lift ? "Left and right to move, down to move to More apps, OK to drop" :
        expanded && zone === "grid" ? "Hold OK on an app to add it to home" : "");
    if (text || !$("hint").classList.contains("on")) $("hint").textContent = text;
    $("hint").classList.toggle("on", !!text);
    document.documentElement.classList.toggle("hinting", !!text);
  }
  function flash(text) {
    clearTimeout(hintTimer);
    hintFlash = text;
    renderHint();
    hintTimer = setTimeout(function () { hintFlash = ""; renderHint(); }, 4000);
  }
  function holdApp() {
    var a = gridItems[g];
    if (!a || a.kind === "more") return false;
    if (a.store || a.package === SETTINGS_PKG) { flash(a.name + " always stays where it is."); return true; }
    var arr = arrangeItems();
    var idx = arr.items.map(function (it) { return it.package; }).indexOf(a.package);
    if (arrMode() !== "manual") {
      var held = arrHold(a, arr, idx);
      if (held !== null) return held;
    }
    if (idx < 0) return false;
    if (!expanded) {
      materialise();
      lift = { pkg: a.package };
      hintFlash = "";
      renderGrid(); paintFocus();
      return true;
    }
    if (idx < arr.line) { flash(a.name + " is already on home."); return true; }
    // More apps: add it to the end of the dock; a full dock sends its last app behind More apps
    var o = materialise() && data.order, msg = a.name + " is on home now.";
    o.packages.splice(idx, 1);
    if (o.line < DOCK_APPS) { o.packages.splice(o.line, 0, a.package); o.line += 1; }
    else {
      o.packages.splice(o.line - 1, 0, a.package);
      msg += " " + nameOf(o.packages[o.line]) + " moved to More apps.";
    }
    persistOrder();
    expanded = false;
    renderGrid();
    g = o.packages.indexOf(a.package);
    paintFocus();
    flash(msg);
    return true;
  }
  function moveLift(dx, dy) {
    var o = data.order, i = o.packages.indexOf(lift.pkg);
    if (dx) {
      var j = i + dx;
      if (j >= 0 && j < o.line) { o.packages[i] = o.packages[j]; o.packages[j] = lift.pkg; g = j; }
    } else if (dy > 0) {   // behind More apps: first in line there
      var name = nameOf(lift.pkg);
      o.packages.splice(i, 1);
      o.packages.splice(o.line - 1, 0, lift.pkg);
      o.line -= 1;
      lift = null;
      persistOrder();
      renderGrid();
      g = Math.min(i, gridEls.length - 1);
      flash(name + " moved to More apps.");
    }
    renderGrid();
    paintFocus();
  }
  function dropLift() {
    lift = null;
    persistOrder();
    renderGrid();
    paintFocus();
    flash("Saved.");
  }

  // Apps installed since this TV first listed its apps: the end of the dock when there is room,
  // otherwise first behind More apps, with a New dot until opened once.
  function detectNew() {
    if (!data.apps.length) return;
    var pk = data.apps.filter(function (a) { return a.package !== SETTINGS_PKG && a.package !== STORE_PKG; })
      .map(function (a) { return a.package; });
    var seen = kept("tvhome.apps.seen");
    if (!seen) { keep("tvhome.apps.seen", pk); return; }
    var fresh = pk.filter(function (p) { return seen.indexOf(p) < 0; });
    if (!fresh.length) return;
    keep("tvhome.apps.seen", seen.concat(fresh));
    newApps = newApps.concat(fresh.filter(function (p) { return newApps.indexOf(p) < 0; }));
    keep("tvhome.apps.new", newApps);
    if (arrMode() !== "manual") return;
    materialise();
    var o = data.order;
    fresh.forEach(function (p) {
      var app = data.apps.filter(function (a) { return a.package === p; })[0];
      var i = o.packages.indexOf(p);
      if (i < 0 || i < o.line || (app && tucked(app))) return;
      o.packages.splice(i, 1);
      o.packages.splice(o.line, 0, p);
      if (o.line < DOCK_APPS) o.line += 1;
    });
    persistOrder();
  }
  function opened(pkg) {
    if (!isNew(pkg)) return;
    newApps = newApps.filter(function (p) { return p !== pkg; });
    keep("tvhome.apps.new", newApps);
    renderGrid();
  }

  function dockHTML(it) {
    var face;
    if (it.kind === "screen") face = '<div class="face tool">' + ICONS.screen + "</div>";
    else if (it.kind === "more") face = '<div class="face tool">' + ICONS.more + "</div>";
    else if (it.package === SETTINGS_PKG) face = '<div class="face tool">' + ICONS.gear + "</div>";
    else if (iconUrl(it.package)) face = '<div class="face"><img src="' + esc(iconUrl(it.package)) + '" alt="" decoding="async"></div>';
    else if (it.store) face = '<div class="face tool">' + ICONS.store + "</div>";
    else face = '<div class="face word">' + esc(it.name) + "</div>";
    var cls = "tile app dock-ic" + (lift && it.package === lift.pkg ? " lifted" : "");
    return '<div class="' + cls + '" data-k="' + esc(it.package || it.kind + ":" + it.name) + '">' + face + (isNew(it.package) ? '<i class="dot" aria-label="New"></i>' : "") +
      '<div class="label">' + esc(it.name) + "</div>" + (it.gstart ? '<b class="ghead">' + esc(it.gstart) + "</b>" : "") + "</div>";
  }

  function appHTML(it) { return dockHTML(it); }

  function flipRects() {
    var m = {};
    Array.prototype.forEach.call($("grid").children, function (el) { var k = el.getAttribute("data-k"); if (k) m[k] = el.getBoundingClientRect(); });
    return m;
  }
  function flipPlay(before) {   // apps that were on screen glide from their old place; new ones pop in
    if (REDUCED || !before) return;
    var moved = [], any = false;
    for (var k0 in before) { any = true; break; }
    if (!any) return;
    Array.prototype.forEach.call($("grid").children, function (el) {
      var k = el.getAttribute("data-k"), b = k && before[k];
      if (!k) return;
      if (!b) { el.classList.add("fresh"); return; }
      var r = el.getBoundingClientRect(), dx = b.left - r.left, dy = b.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none"; el.style.transform = "translate(" + dx + "px," + dy + "px)";
      moved.push(el);
    });
    if (!moved.length) return;
    void document.body.offsetWidth;   // one layout for all of them
    moved.forEach(function (el) { el.style.transition = ""; el.style.transform = ""; });
  }
  function renderGrid() {
    var flipFrom = flipRects();
    document.documentElement.classList.toggle("expanded", expanded);
    document.documentElement.classList.toggle("lifting", !!lift);
    gridItems = dockList();
    $("grid").classList.toggle("grouped", !!(expanded && ARR.headers));
    GRID_COLS = expanded ? 12 : Math.max(1, Math.min(12, gridItems.length));
    $("grid").style.gridTemplateColumns = "repeat(" + GRID_COLS + ", 7rem)";
    $("grid").innerHTML = gridItems.map(appHTML).join("");
    gridEls = Array.prototype.slice.call($("grid").children);
    flipPlay(flipFrom);
    renderHint();
  }

  // ---------------- focus ----------------
  function clearFocus() {
    shelfEls.concat(gridEls, quickEls).forEach(function (el) { if (el) el.classList.remove("focus"); });
    $("people").classList.remove("focus");
    Array.prototype.forEach.call($("people").children, function (el) { el.classList.remove("focus"); });
  }

  function scrollShelf() {
    var track = $("shelf");
    var el = shelfEls[s];
    if (!el) { track.style.transform = ""; return; }
    var step = el.offsetWidth + parseFloat(getComputedStyle(track).columnGap || 0);
    var first = Math.max(0, Math.min(s - 2, shelfEls.length - 5));   // keep up to five in view
    track.style.transform = "translateX(" + (-first * step) + "px)";
  }

  function shelfOn() { return !$("shelf-section").classList.contains("empty"); }
  // the switcher shows for two or more people, and only while someone has something on the go
  function peopleOn() { return peopleCount() >= 2 && shelfOn(); }
  function toPeople() { zone = "people"; pi = whoIndex(); }

  function paintFocus() {
    clearFocus();
    renderHint();
    if (zone === "about") return;
    if (zone === "debug") { renderDebug(); return; }
    if (zone === "settings") { renderSettings(); return; }
    if (zone === "pin") { renderPin(); return; }
    if (zone === "ask") { renderAsk(); return; }
    if (zone === "menu") { renderMenu(); return; }
    if (zone === "pmenu") { renderPop(); $("people").classList.add("focus"); return; }
    if (zone === "quick" && quickEls[qi]) {
      quickEls[qi].classList.add("focus");
      return;
    }
    if (zone === "people" && peopleOn()) {
      if (isHead()) $("people").classList.add("focus");
      else $("people").children[pi].classList.add("focus");
      return;
    }
    if (zone === "shelf" && shelfEls[s]) {
      shelfEls[s].classList.add("focus");
      scrollShelf();
    } else {
      zone = "grid";
      g = Math.max(0, Math.min(g, gridEls.length - 1));
      if (gridEls[g]) gridEls[g].classList.add("focus");
    }
    renderHint();
  }

  function nearestInRow(row, x) {
    var best = row * GRID_COLS, bestD = Infinity;
    for (var i = row * GRID_COLS; i < Math.min(gridEls.length, (row + 1) * GRID_COLS); i++) {
      var b = gridEls[i].getBoundingClientRect();
      var d = Math.abs(b.left + b.width / 2 - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  function move(dx, dy) {
    touched = true;
    if (lift) { moveLift(dx, dy); return; }
    // Night with More apps open: the cards step aside, so up and down skip them
    var cards = expanded ? [] : shelfEls;
    if (zone === "pin") { pinMove(dx, dy); return; }
    if (zone === "ask") { if (dy) askMove(dy); return; }
    if (zone === "about") { if (dy) aboutMove(dy); return; }
    if (zone === "debug") { if (dy) debugMove(dy); else if (dx) $("debug-pane").scrollTop += dx * 170; return; }
    if (zone === "settings") {
      if (dy) { setStep(dy); setFlash = ""; renderSettings(); }
      else if (dx) changeSet(dx);
      return;
    }
    if (zone === "menu") {
      if (dx) menuI = Math.max(0, Math.min(SLEEP_CHOICES.length - 1, menuI + dx));
      paintFocus();
      return;
    }
    if (zone === "pmenu") {
      if (dy) {
        var n = Math.max(0, Math.min(PEOPLE.length - 1, pmi + dy));
        if (plift && n !== pmi) { var t = PEOPLE[pmi]; PEOPLE[pmi] = PEOPLE[n]; PEOPLE[n] = t; }
        pmi = n;
        renderPop();
      }
      return;
    }
    if (zone === "quick") {
      var nq = quickVisible().length;
      if (dx < 0 && qi === 0) { if (peopleOn()) toPeople(); }
      else if (dx) qi = Math.max(0, Math.min(nq - 1, qi + dx));
      else if (dy > 0) {
        if (peopleOn()) toPeople();
        else if (cards.length) zone = "shelf";
        else { zone = "grid"; g = Math.min(GRID_COLS, gridEls.length) - 1; }
      }
      paintFocus();
      return;
    }
    if (zone === "people") {
      if (dx > 0 && (isHead() || pi === PEOPLE.length - 1)) { if (hasQuick()) { zone = "quick"; qi = 0; } }
      else if (dx && !isHead()) {
        // moving across the names only moves the outline; OK picks (you have to click to select), so passing a name on the way to Sleep timer changes nothing
        pi = Math.max(0, Math.min(PEOPLE.length - 1, pi + dx));
      } else if (dy > 0) zone = cards.length ? "shelf" : "grid";
    } else if (zone === "shelf") {
      if (dx) s = Math.max(0, Math.min(shelfEls.length - 1, s + dx));
      else if (dy < 0) { if (peopleOn()) toPeople(); else if (hasQuick()) { zone = "quick"; qi = 0; } }
      else if (dy > 0 && gridEls.length) {
        // land on the app under the show
        var b = shelfEls[s].getBoundingClientRect();
        g = nearestInRow(0, b.left + b.width / 2);
        zone = "grid";
      }
    } else {
      var row = Math.floor(g / GRID_COLS), lastRow = Math.floor((gridEls.length - 1) / GRID_COLS);
      if (dx) {
        var nx = g + dx;
        if (nx >= 0 && nx < gridEls.length && Math.floor(nx / GRID_COLS) === row) g = nx;
      } else if (dy < 0 && row === 0) {
        if (cards.length) zone = "shelf";
        else if (peopleOn()) toPeople();
        else if (hasQuick()) zone = "quick";   // offline the sleep and picture buttons are hidden
      } else if (dy < 0) {
        g -= GRID_COLS;
      } else if (row < lastRow) {
        g = Math.min(g + GRID_COLS, gridEls.length - 1);
      }
    }
    paintFocus();
  }

  // Start on the people switch, so the first press picks who is watching.
  function startFocus() {
    s = 0; g = 0;
    if (peopleOn()) toPeople();
    else zone = shelfEls.length ? "shelf" : "grid";
  }

  function goHome() {
    if (lift) { dropLift(); return; }   // BACK puts a picked-up app down where it is
    if (zone === "pmenu") { if (plift) dropPeople(); else closePop(); paintFocus(); return; }
    if (zone === "debug") { closeDebug(); return; }
    if (zone === "about") { aboutBack(); return; }
    if (zone === "settings") { closeSettings(); return; }
    if (zone === "pin") { pinCancel(); return; }
    if (zone === "ask") { closeAsk(); return; }
    if (zone === "menu") { closeMenu(); paintFocus(); return; }   // BACK just closes the sleep choices
    if (expanded) { expanded = false; renderGrid(); }
    startFocus();
    paintFocus();
  }

  // ---------------- actions ----------------
  // A long press of OK (or the Menu key): pick up an app or a name to move it. Returns false when
  // there is nothing to pick up here, and then the press counts as a normal OK.
  function hold() {
    touched = true;
    if (lift) { dropLift(); return true; }
    if (zone === "pmenu") {
      if (plift) dropPeople();
      else if (PEOPLE.length > 1) { plift = true; renderPop(); }
      return true;
    }
    if (zone === "grid") return holdApp();
    return false;
  }

  function activate() {
    touched = true;
    if (lift) { dropLift(); return; }
    if (zone === "debug") { debugOk(); return; }
    if (zone === "about") { aboutOk(); return; }
    if (zone === "settings") { changeSet(1); return; }
    if (zone === "pin") { pinSubmit(); return; }
    if (zone === "ask") { askActivate(); return; }
    if (zone === "menu") { setSleep(SLEEP_CHOICES[menuI]); paintFocus(); return; }
    if (zone === "pmenu") {
      if (plift) { dropPeople(); return; }
      pickWho(PEOPLE[pmi].id);
      closePop();
      renderPeople();
      paintFocus();
      return;
    }
    if (zone === "quick") { quickAction(); return; }
    if (zone === "people") {
      if (isHead()) { openPop(); paintFocus(); return; }
      pickWho(PEOPLE[pi].id);
      paintFocus();
      return;
    }
    if (zone === "shelf") {
      var it = data.shows[s];
      if (!it) return;
      status("Opening " + it.title + (it.app ? " in " + it.app.name : "") + "…", true);
      api("POST", "/api/continue/open", { id: it.id, who: NOBODY ? "both" : who }, 60000)
        .then(function (res) { status(res.note || ""); })
        .catch(function (e) {
          // the bridge can't help: at least open the app it was in
          if (TV && it.app && TV.launch(it.app.package)) { status(""); return; }
          status(e.message);
        });
      return;
    }
    var a = gridItems[g], el = gridEls[g];
    if (!a) return;
    if (a.kind === "more") { expanded = true; renderGrid(); paintFocus(); return; }
    if (a.kind === "screen") {
      if (!a.ready) { status(a.note || "That screen isn't set up yet."); return; }
      el.classList.add("busy");
      api("POST", "/api/screens/open", { id: a.id }, 10000)
        .then(function (res) { status(res.note || ""); })
        .catch(function (e) {
          if (TV && TV.launch("com.limelight")) { status(""); return; }
          status(e.message);
        })
        .then(function () { el.classList.remove("busy"); });
      return;
    }
    if (a.kind === "web") { openWebApp(a); return; }
    opened(a.package);
    arrUsed(a.package);
    if (TV && TV.launch(a.package)) return;
    api("POST", "/api/launch", { app: a.id || a.package }).catch(function (e) { status(e.message); });
  }

  // ---------------- keys: any normal TV remote, keyboard or game controller ----------------
  // The full table is in docs/REMOTES.md. The launcher also turns BUTTON_A, BUTTON_SELECT and
  // NUMPAD_ENTER into OK and BUTTON_B and ESCAPE into Back before the page sees them. Any other key
  // (media, numbers, colour buttons, voice, app buttons) is left alone so Android still gets it.
  var OK_KEYS = ["Enter", " ", "Select", "Accept", "NumpadEnter"];
  var BACK_KEYS = ["Escape", "Esc", "Backspace", "GoBack", "BrowserBack"];
  var ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
    Up: [0, -1], Down: [0, 1], Left: [-1, 0], Right: [1, 0] };
  var ARROW_CODES = { 38: [0, -1], 40: [0, 1], 37: [-1, 0], 39: [1, 0], 19: [0, -1], 20: [0, 1], 21: [-1, 0], 22: [1, 0] };
  function isOk(e) { return OK_KEYS.indexOf(e.key) >= 0 || e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 32; }
  function isBack(e) { return BACK_KEYS.indexOf(e.key) >= 0 || e.keyCode === 27 || e.keyCode === 8; }
  function isMenu(e) { return e.key === "ContextMenu" || e.key === "Menu" || e.keyCode === 93 || e.keyCode === 82; }
  function arrowOf(e) { return ARROWS[e.key] || (e.key === "Unidentified" || !e.key ? ARROW_CODES[e.keyCode] : null) || null; }

  // Focus is never lost: after any key, if nothing shows focus, the first dock app gets it.
  function ensureFocus() {
    if (zone === "pin") return;
    if (document.querySelector(".focus")) return;
    zone = "grid"; g = 0;
    paintFocus();
  }

  // OK acts when it is let go, so holding it can pick things up instead (tvOS does the same).
  // Works for remotes that repeat the key while it is held and for ones that only send the press
  // and, later, the release. One press is one action: a pick-up never also opens the app.
  var okDown = false, okHeld = false, okTimer = null;
  function okReset() { okDown = false; okHeld = false; clearTimeout(okTimer); }
  document.addEventListener("keydown", function (e) {
    if (zone === "pin") { var dg = pinDigit(e); if (dg != null) { e.preventDefault(); pinType(dg); return; } }
    if (isOk(e)) {
      e.preventDefault();
      if (e.repeat || okDown) return;   // a held key repeating: the timer is already running
      okDown = true; okHeld = false;
      okTimer = setTimeout(function () { okHeld = true; if (!hold()) activate(); ensureFocus(); }, HOLD_MS);
      return;
    }
    var arrow = arrowOf(e);
    if (arrow) move(arrow[0], arrow[1]);
    else if (isBack(e)) goHome();
    else if (isMenu(e)) { if (!e.repeat) hold(); }   // optional: many remotes have no Menu key
    else { ensureFocus(); return; }                   // anything else is not ours: Android gets it
    e.preventDefault();
    ensureFocus();
  });
  document.addEventListener("keyup", function (e) {
    if (!isOk(e)) return;
    e.preventDefault();
    if (!okDown) return;
    var held = okHeld;
    okReset();
    if (!held) activate();
    ensureFocus();
  });
  window.addEventListener("blur", okReset);

  // ---------------- data ----------------
  function nativeApps() {
    var list;
    try { list = JSON.parse(TV.apps()); } catch (e) { return null; }
    return list.map(function (a) {
      return { kind: "app", name: RENAME[a.package] || a.label, package: a.package,
        banner: "http://tvos.invalid/banner/" + a.package };   // the launcher makes one when the app has none
    });
  }
  // Web apps look like apps (a tile with a letter) but open the site in this launcher's own browser.
  function webItems() {
    if (TV && TV.setWebApps) { try { TV.setWebApps(JSON.stringify(WEB)); } catch (e) {} }
    return WEB.map(function (w) {
      var v = encodeURIComponent((w.colour || "") + (w.letter || "") + w.name);
      return { kind: "web", id: w.id, name: w.name, package: "web:" + w.id, web: w, colour: w.colour,
        banner: TV ? "http://tvos.invalid/banner/web:" + w.id + "?v=" + v : undefined };
    });
  }
  function openWebApp(a) {
    opened(a.package);
    arrUsed(a.package);
    var w = a.web || {};
    var ok = false;
    try { ok = !!(TV && TV.openWeb && TV.openWeb(JSON.stringify({ url: w.url, hosts: (w.allowed_hosts || []).join(","), desktop: true }))); } catch (e) {}
    if (!ok) status(TV ? "Couldn't open " + a.name + "." : "Web apps open on the TV itself.");
  }
  function sortApps(list) {
    var rank = function (p) {
      var i = APP_ORDER.indexOf(p);
      if (i >= 0) return i;
      i = APP_LAST.indexOf(p);
      return i >= 0 ? 2000 + i : 1000;
    };
    return list.filter(function (a) { return HIDDEN.indexOf(a.package) < 0; })
      .sort(function (a, b) { return rank(a.package) - rank(b.package) || a.name.localeCompare(b.name); });
  }

  function render() {
    var rs = skelOn.shelf, rg = skelOn.grid;
    skelOn.shelf = skelOn.grid = false;
    renderShelf();
    renderGrid();
    if (rs) reveal($("shelf"));
    if (rg) reveal($("grid"));
    if (!touched) startFocus();
    paintFocus();
  }

  // The bridge's people list (the phone edits it). An order made on this TV while the bridge was
  // away is handed over first.
  function bridgePeople(j) {
    var list = j.people || [];
    var lo = kept("tvhome.people.order");
    if (lo && lo.pending && lo.ids) {
      list = localPeopleOrder(list, true);
      api("POST", "/api/people", { order: lo.ids })
        .then(function () { keep("tvhome.people.order", { ids: lo.ids, pending: false }); }, function () {});
    }
    if (zone !== "pmenu") setPeople(list);
  }
  function bridgeOrder(j) {
    data.order = { saved: !!j.saved, line: j.line, packages: (j.apps || []).map(function (a) { return a.package; }) };
    var lo = kept("tvhome.order.tv");
    if (lo && lo.pending && lo.packages) {
      data.order = { saved: true, line: lo.line, packages: lo.packages };
      api("POST", "/api/app-order", { order: lo.packages, line: lo.line })
        .then(function () { lo.pending = false; keep("tvhome.order.tv", lo); }, function () {});
    }
  }

  function refresh() {
    if (lift || zone === "pmenu") return Promise.resolve();   // never reshuffle under something being moved
    if (OFFLINE) {
      // only the TV's own apps, in the order last saved; no shows, no Screens
      if (TV) data.apps = sortApps(nativeApps() || []);
      else if (window.MOCK_APPS) data.apps = sortApps(window.MOCK_APPS.slice());
      data.bridge = false;
      detectNew();
      status(ALONE ? "" : "The computer is off, so shows are hidden. Apps still work.", true);
      render();
      return Promise.resolve();
    }
    var people = api("GET", "/api/people").then(bridgePeople, function () {});
    var jobs = [
      people.then(function () {
        return Promise.all(PEOPLE.map(function (p) {
          return api("GET", "/api/continue?who=" + p.id, null, 9000).then(function (j) { data.showsBy[p.id] = (j.items || []).slice(0, 12); });
        }));
      }),
      api("GET", "/api/screens").then(function (j) { data.screens = j.screens || []; }),
      api("GET", "/api/webapps").then(function (j) { WEB = j.webapps || []; keep("tvhome.webapps", WEB); }),
      // whoever the phone remote or this TV last set as watching
      api("GET", "/api/who").then(function (j) {
        return people.then(function () { if (PEOPLE.some(function (p) { return p.id === j.who; }) && !touched) { who = j.who; } });
      }),
      (TV || PREVIEW || MOCK) ? Promise.resolve() : api("GET", "/api/apps").then(function (j) { data.bridgeApps = j.apps || []; }),
      // the order arranged on the phone (or with this TV's remote)
      api("GET", "/api/app-order").then(bridgeOrder),
      arrLoad()
    ];
    return Promise.all(jobs.map(function (p) { return p.then(function () { return true; }, function () { return false; }); }))
      .then(function (ok) {
        if (lift || zone === "pmenu") return;
        data.bridge = ok[0] || ok[2];
        var apps = TV ? nativeApps() : (window.MOCK_APPS ? window.MOCK_APPS.slice() : null);
        if (!apps) apps = (data.bridgeApps || []).filter(function (a) { return a.installed !== false && a.id !== "home"; })
          .map(function (a) { return { kind: "app", id: a.id, name: a.name, package: a.package, colour: a.colour }; });
        data.apps = sortApps(apps.concat(webItems()));
        if (!data.bridge) {   // no bridge: the order this TV keeps itself
          var lo = kept("tvhome.order.tv");
          if (lo && lo.packages) data.order = { saved: true, line: lo.line, packages: lo.packages };
        }
        reportApps();
        detectNew();
        status(data.bridge ? "" : "Computer not answering. Apps still work.", true);
        if (data.bridge) save();
        render();
        clearTimeout(retryTimer);
        if (!ok[0] && !ok[1]) { retryMs = Math.min(retryMs * 2, 60000); retryTimer = setTimeout(refresh, retryMs); }
        else retryMs = 2500;
      });
  }

  // the native side calls these
  // Home on the remote also re-reads the lists, so an order arranged on the phone shows straight away
  window.tv = { back: goHome, home: function () { goHome(); refresh(); },
    resume: function () { okReset(); syncDown().then(function (changed) { if (changed) reapplyAll(); }); refresh(); if (!OFFLINE) refreshQuick(); refreshWeather(); } };

  // ---------------- boot screen and skeletons ----------------
  var NOBOOT = /[?&]noboot\b/.test(Q);
  var bootEl = $("boot"), bootT0 = Date.now(), bootDone = false;
  var BOOT_MIN = 900, BOOT_MAX = 7000;   // never a flash, never stuck
  var syncing = true, wxPending = true;
  var skelOn = { shelf: false, grid: false };
  function bootNote(t) { var n = $("boot-note"); if (n) { n.textContent = t; n.classList.add("on"); } }
  function bootHide() {
    if (bootDone || !bootEl) return;
    bootDone = true;
    var el = bootEl;
    el.classList.add("out");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 650);   // also stops the ring
  }
  function bootWhen(ready) {
    if (!bootEl) return;
    if (NOBOOT) { bootHide(); return; }
    var maxT = setTimeout(function () { bootNote("Still getting ready\u2026"); setTimeout(bootHide, 900); }, BOOT_MAX);
    ready.then(function () {
      clearTimeout(maxT);
      var wait = Math.max(0, BOOT_MIN - (Date.now() - bootT0));
      // the computer is off or not answering: say so and carry on with the saved copy
      if (!ALONE && (OFFLINE || (data.bridge === false && !PREVIEW && !MOCK))) { bootNote("Using offline copy"); wait = Math.max(wait, 1200); }
      setTimeout(bootHide, wait);
    });
  }
  function settled(p) { return Promise.resolve(p).then(function () {}, function () {}); }
  function reveal(el) {
    if (!el) return;
    el.classList.remove("reveal"); void el.offsetWidth; el.classList.add("reveal");
    setTimeout(function () { el.classList.remove("reveal"); }, 900);
  }
  function skelShelf() {
    var h = "";
    for (var i = 0; i < 3; i++) h += '<div class="tile ncard sk"><span class="thumb skel"></span><div class="t"><span class="sk-line skel w40"></span><span class="sk-line big skel w80"></span><span class="sk-line skel w55"></span></div></div>';
    $("shelf").innerHTML = h;
    skelOn.shelf = true;
  }
  function skelGrid() {
    var h = "";
    for (var i = 0; i < 7; i++) h += '<div class="tile app dock-ic sk"><div class="face skel"></div><div class="label"><span class="sk-line skel w60"></span></div></div>';
    $("grid").style.gridTemplateColumns = "repeat(7, 7rem)";
    $("grid").innerHTML = h;
    skelOn.grid = true;
  }

  function start() {
    var wxP = Promise.resolve(), fontP = Promise.resolve();
    readConfig();
    var syncP = syncDown().then(function (changed) {
      syncing = false;
      if (changed) location.reload();
      else if (zone === "settings") renderSettings();
    }, function () { syncing = false; });
    mark("app-start");
    clock();
    setInterval(clock, 15000);
    buildScenes();
    // ?scene=fog starts on that scene, for previews
    var first = (Q.match(/[?&]scene=([a-z]+)/) || [])[1];
    showScene(Math.max(0, SCENES.map(function (s) { return s.id; }).indexOf(first)));
    if (SCENES.length > 1) sceneTimer = setInterval(nextScene, SCENE_MS);
    // the clock font must be in before the glass is measured
    if (document.fonts) fontP = document.fonts.load("300 10px Antonio").then(function () { glassShown = ""; clock(); });
    wxP = refreshWeather();
    setInterval(refreshWeather, 30 * 60000);
    var cached = load();
    if (cached) { data.showsBy = cached.showsBy || data.showsBy; data.screens = cached.screens || []; data.order = cached.order || null; }
    setPeople(PEOPLE);   // the cache may predate someone new
    if (OFFLINE) {   // no bridge: an order made with this TV's remote wins
      var lo = kept("tvhome.order.tv");
      if (lo && lo.packages) data.order = { saved: true, line: lo.line, packages: lo.packages };
    }
    if (TV) data.apps = sortApps(nativeApps() || []);
    if (cached || TV) { render(); mark("home-painted-from-cache"); }
    else if (!OFFLINE) { skelShelf(); skelGrid(); }
    renderQuick();
    if (!OFFLINE) refreshQuick();
    var liveP = refresh().then(function () { mark("home-painted-live"); });
    bootWhen(Promise.all([settled(liveP), settled(wxP), settled(fontP), settled(syncP)]));
  }

  if (MOCK || PREVIEW) {
    var sc = document.createElement("script");
    sc.src = "mock.js";
    sc.onload = start;
    document.head.appendChild(sc);
  } else {
    start();
  }
})();
