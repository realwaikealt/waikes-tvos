/* Wallpaper Engine backgrounds for the home screen.
   The PC (bridge/wallpapers.py) scans the owner's Wallpaper Engine library. A video wallpaper plays here as a muted
   looping <video> behind Home; scene/web wallpapers are shown as a still picture (their preview). Built-in scenes
   stay the default. The choice lives on the bridge (/api/wallpaper) and is mirrored in this TV's settings (SET.wp),
   so it is backed up and survives the PC being off.
   Only transform/opacity animate, no filters, no blur. Needs window.TVOS_HOME from app.js. */
(function () {
  "use strict";
  var H = null, BASE = "";
  var cur = { id: "scenes" };              // what is applied now: {id, t, kind, state, url, poster, detail}
  var meta = {};                           // id -> {title, type, video}
  var vid, still, root;                    // elements
  var hold = {};                           // reasons the video is paused
  var pollT = null, prepT = null, qualT = null, last = { total: 0, dropped: 0, bad: 0 };
  var JANKY = "tvhome.wp.janky";

  function $(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function isJanky(id) {
    var v = lsGet(JANKY) || "";
    var p = v.split("|");
    return p[0] === id && p[1] && Date.now() - (+p[1]) < 20 * 60 * 1000;
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function get(path) { return H.api("GET", path, null, 8000); }
  function post(path, body) { return H.api("POST", path, body, 15000); }

  // ---------------- the background itself ----------------
  var CSS =
    "#wpbg{position:fixed;inset:0;display:none;pointer-events:none;background:#000;overflow:hidden}" +
    "html.wp-on #wpbg{display:block}" +
    "#wpbg video,#wpbg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:opacity 700ms ease-out}" +
    "#wpbg video{opacity:0}#wpbg video.on{opacity:1}#wpbg img{opacity:0}#wpbg img.on{opacity:1}" +
    "#wpbg::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.28) 0%,rgba(0,0,0,.08) 40%,rgba(0,0,0,.22) 100%)}" +
    /* the scene photos give way to the wallpaper; the glass clock stays, as an outline over the picture */
    "html.wp-on .scene .sbg,html.wp-on .scene .fg{display:none}" +
    "html.wp-on .scene .shade{background:none}" +
    "html.wp-on .gclock .fill{background-image:none!important;background-color:rgba(255,255,255,.16);-webkit-background-clip:text;background-clip:text}" +
    "html.wp-on .date,html.wp-on .date .wx{color:rgba(255,255,255,.92)}" +
    /* picker: a sheet at the bottom, so the wallpaper stays visible above it */
    "#wpick{position:fixed;inset:0;z-index:70;display:none;text-shadow:none}" +
    "#wpick.on{display:block}" +
    "#wpick .wp-sheet{position:absolute;left:0;right:0;bottom:0;height:35rem;padding:1.75rem 4rem 0;background:linear-gradient(180deg,rgba(18,13,19,0) 0,rgba(18,13,19,.92) 3.5rem,rgba(18,13,19,.97) 100%);transform:translateY(100%);transition:transform 420ms var(--spring,cubic-bezier(.2,.9,.25,1.1))}" +
    "#wpick.on .wp-sheet{transform:none}" +
    "#wpick h2{font-size:var(--fs-headline,2.1rem);font-weight:700;letter-spacing:-.02em;margin:1.4rem 0 .8rem}" +
    "#wpick .wp-note{position:absolute;left:4rem;right:4rem;top:1.6rem;text-align:right;font-size:var(--fs-callout,1.4rem);color:var(--ink-2,rgba(255,255,255,.8))}" +
    "#wpick .wp-chips{display:flex;gap:.75rem;margin-bottom:1rem}" +
    "#wpick .wp-chip{padding:.45rem 1.3rem;border-radius:999px;font-size:var(--fs-callout,1.4rem);background:rgba(255,255,255,.1);color:var(--ink-2,rgba(255,255,255,.8))}" +
    "#wpick .wp-chip.sel{background:rgba(255,255,255,.22);color:#fff}" +
    "#wpick .wp-chip.focus{background:#fff;color:#1a1218;transform:scale(1.06)}" +
    "#wpick .wp-view{position:relative;height:23.2rem;overflow:hidden}" +
    "#wpick .wp-list{position:absolute;left:0;top:0;right:0;transition:transform 300ms var(--out,cubic-bezier(.2,.8,.2,1))}" +
    "#wpick .wp-card{position:absolute;width:20.2rem;height:12rem}" +
    "#wpick .wp-card .im{position:absolute;left:0;top:0;width:20.2rem;height:8.6rem;border-radius:1rem;background:#2a2029 center/cover no-repeat;transition:transform 220ms var(--out,ease-out),box-shadow 220ms}" +
    "#wpick .wp-card.focus .im{transform:scale(1.07);box-shadow:0 .8rem 2rem rgba(0,0,0,.55),0 0 0 .22rem #fff}" +
    "#wpick .wp-card .tt{position:absolute;left:.2rem;right:.2rem;top:9.2rem;font-size:var(--fs-callout,1.4rem);line-height:1.8rem;height:1.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink-2,rgba(255,255,255,.8))}" +
    "#wpick .wp-card.focus .tt{color:#fff}" +
    "#wpick .wp-card .bd{position:absolute;left:.6rem;top:.6rem;padding:.1rem .6rem;border-radius:.5rem;font-size:1.05rem;background:rgba(0,0,0,.55);color:#fff}" +
    "#wpick .wp-card .ck{position:absolute;right:.6rem;top:.6rem;width:1.9rem;height:1.9rem;border-radius:50%;background:#fff;color:#1a1218;font-size:1.3rem;line-height:1.9rem;text-align:center;font-weight:700}" +
    "#wpick .wp-empty{padding:3rem 0;font-size:var(--fs-body,1.6rem);color:var(--ink-3,rgba(255,255,255,.55))}";

  function build() {
    if ($("wpbg")) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    root = document.createElement("div"); root.id = "wpbg"; root.setAttribute("aria-hidden", "true");
    vid = document.createElement("video");
    vid.muted = true; vid.loop = true; vid.autoplay = false; vid.setAttribute("playsinline", ""); vid.setAttribute("muted", "");
    vid.preload = "auto"; vid.disablePictureInPicture = true;
    still = document.createElement("img"); still.alt = ""; still.decoding = "async";
    root.appendChild(still); root.appendChild(vid);
    var scenes = $("scenes");
    if (scenes && scenes.parentNode) scenes.parentNode.insertBefore(root, scenes); else document.body.insertBefore(root, document.body.firstChild);
    vid.addEventListener("playing", function () { vid.classList.add("on"); still.classList.remove("on"); });
    vid.addEventListener("error", function () { fallback("The video wouldn't play on this TV."); });
    vid.addEventListener("stalled", function () { last.bad++; });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { pause("hidden"); stopPoll(); } else { resume("hidden"); startPoll(); sync(); }
    });
  }

  var retryT = null;
  function setOn(on) {
    document.documentElement.classList.toggle("wp-on", !!on);
    H.freezeScenes(!!on);
  }
  function pause(why) { hold[why] = 1; if (vid && !vid.paused) try { vid.pause(); } catch (e) {} }
  function resume(why) {
    delete hold[why];
    if (!Object.keys(hold).length && vid && vid.classList.contains("on") && vid.paused) { var p = vid.play(); if (p && p.catch) p.catch(function () {}); }
  }
  function stopVideo() {
    clearInterval(qualT); qualT = null;
    if (!vid) return;
    try { vid.pause(); } catch (e) {}
    vid.classList.remove("on");
    if (vid.getAttribute("src")) { vid.removeAttribute("src"); try { vid.load(); } catch (e) {} }
  }
  function fallback(msg) {   // the video isn't smooth: keep the still picture and remember that for this wallpaper
    if (!cur || cur.kind !== "video") return;
    lsSet(JANKY, cur.id + "|" + Date.now());
    stopVideo();
    if (cur.poster) showStill(cur.poster);
    H.flash(msg + " A still picture is shown instead.");
  }
  function stalled() {   // the video stopped moving: show the picture and try the video again in half a minute
    var c = cur;
    stopVideo();
    if (c && c.poster) showStill(c.poster);
    clearTimeout(retryT);
    retryT = setTimeout(function () { if (cur && c && cur.id === c.id) apply(cur); }, 30000);
  }
  function light() { return !!(H && H.get("light")); }
  function showStill(path) {
    still.onload = function () { still.classList.add("on"); };
    still.src = BASE + path;
    if (still.complete && still.naturalWidth) still.classList.add("on");
  }
  function watchQuality() {
    clearInterval(qualT);
    last = { total: 0, dropped: 0, bad: 0 };
    var strikes = 0, stalls = 0;
    qualT = setInterval(function () {
      if (!vid || vid.paused || document.hidden || !vid.getVideoPlaybackQuality) return;
      var q = vid.getVideoPlaybackQuality(), dt = q.totalVideoFrames - last.total, dd = q.droppedVideoFrames - last.dropped;
      last.total = q.totalVideoFrames; last.dropped = q.droppedVideoFrames;
      if (dt < 20) {   // stalled or too few frames to judge: usually the computer was busy or restarted, so try again later, never "choppy"
        if (dt < 5) stalls++;
        if (stalls >= 3) { stalls = 0; stalled(); }
        return;
      }
      stalls = 0;
      strikes = dd / dt > 0.25 ? strikes + 1 : 0;
      if (strikes >= 3) fallback("The TV dropped too many frames.");
    }, 5000);
  }

  // ---------------- applying a choice ----------------
  function apply(s) {
    if (!s) return;
    cur = s;
    clearTimeout(prepT);
    if (!s.id || s.id === "scenes" || s.kind === "missing") {
      stopVideo(); if (still) still.classList.remove("on");
      setOn(false); H.settings(); return;
    }
    build();
    setOn(true);
    if (s.kind === "image") {
      stopVideo(); showStill(s.url);
    } else if (s.kind === "video") {
      if (s.poster) showStill(s.poster);
      if (light()) { stopVideo(); }   // Light mode: the full HD picture only, no video
      else if (s.state === "ready" && !isJanky(s.id)) {
        var src = BASE + s.url;
        if (vid.getAttribute("src") !== src) { stopVideo(); vid.setAttribute("src", src); }
        if (!Object.keys(hold).length) { var p = vid.play(); if (p && p.catch) p.catch(function () { stalled(); }); }
        watchQuality();
      } else if (s.state === "preparing") {
        stopVideo();
        H.flash("Getting the wallpaper ready for the TV. This takes a minute or two.");
        prepT = setTimeout(recheck, 4000);
      } else if (s.state === "error") {
        stopVideo(); H.flash(s.detail || "That video isn't available."); 
      } else if (isJanky(s.id)) stopVideo();
    }
    H.settings();
  }
  function recheck() {
    if (!cur || cur.kind !== "video" || cur.state !== "preparing") return;
    get("/api/wallpaper").then(function (s) {
      if (s.id !== cur.id) return;
      cur.state = s.state;
      if (s.state === "preparing") { prepT = setTimeout(recheck, 4000); H.settings(); }
      else { H.flash(""); apply(s); }
    }, function () { prepT = setTimeout(recheck, 8000); });
  }

  // ---------------- keeping bridge and TV in step ----------------
  function mine() { var w = H.get("wp"); return w && typeof w === "object" ? w : null; }
  function remember(id, t) { H.set("wp", { id: id, t: t }); }
  var lastT = -1;
  function sync() {
    if (!H.online()) { var m = mine(); if (!m || m.id === "scenes") apply({ id: "scenes" }); return Promise.resolve(); }
    BASE = H.base();
    return get("/api/wallpaper").then(function (s) {
      var m = mine();
      if (m && m.t > (s.t || 0) && m.id !== s.id) {   // the TV's own choice is newer (made while the PC was off): tell the bridge
        return post("/api/wallpaper", { id: m.id, t: m.t }).then(function (s2) { lastT = s2.t; apply(s2); });
      }
      if (s.t !== lastT || (cur && cur.id !== s.id)) {
        lastT = s.t; remember(s.id, s.t);
        if (!cur || cur.id !== s.id || cur.state !== s.state || cur.url !== s.url) apply(s);
      }
    }, function () {
      var m = mine();   // the PC doesn't answer: keep what is showing; if nothing is, show the built-in scenes
      if (!cur || cur.id === "scenes") apply({ id: "scenes" });
    });
  }
  function startPoll() { stopPoll(); pollT = setInterval(sync, 20000); }
  function stopPoll() { clearInterval(pollT); pollT = null; }

  // ---------------- the picker ----------------
  var P = { open: false, items: [], view: [], filter: "all", row: "grid", ci: 0, gi: 0, top: 0, loaded: false, prev: null, prevT: null, note: "" };
  var COLS = 5, CW = 21.4, CH = 12.4, VISROWS = 2;
  var CHIPS = [["video", "Videos that play"], ["picture", "Still pictures only"], ["all", "Everything"]];

  function allItems() {
    var scenes = { id: "scenes", title: "Built-in scenes", type: "scenes", video: false, preview: null };
    return [scenes].concat(P.items);
  }
  function filtered() {
    var a = allItems();
    if (P.filter === "video") return a.filter(function (x) { return x.id === "scenes" || x.video; });
    if (P.filter === "picture") return a.filter(function (x) { return x.id === "scenes" || !x.video; });
    return a;
  }
  function ensurePicker() {
    if ($("wpick")) return;
    build();
    var d = document.createElement("div"); d.id = "wpick"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Wallpaper");
    d.innerHTML = '<div class="wp-sheet"><h2>Wallpaper</h2><div class="wp-note" id="wp-note"></div><div class="wp-chips" id="wp-chips"></div><div class="wp-view" id="wp-view"><div class="wp-list" id="wp-list"></div></div></div>';
    document.body.appendChild(d);
  }
  function badge(x) { return x.id === "scenes" ? "" : (x.video && !light() ? "Video" : (x.video ? "Picture (light mode)" : "Still only")); }
  function nowText() {   // what the current wallpaper is doing, in plain words
    if (!cur || !cur.id || cur.id === "scenes") return "Now: the built-in scenes";
    var t = (meta[cur.id] && meta[cur.id].title) || "Wallpaper Engine";
    if (cur.kind !== "video") return "Now: " + t + " (still picture)";
    if (isJanky(cur.id)) return "Now: " + t + " is showing a still because it was choppy. Pick it again to retry.";
    if (cur.state === "preparing") return "Now: getting " + t + " ready for the TV";
    if (vid && !vid.paused && vid.classList.contains("on")) return "Now playing: " + t;
    return "Now: " + t;
  }
  function hintText() {
    var x = P.view[P.gi];
    if (P.row !== "grid" || !x) return nowText();
    if (x.id === "scenes") return "OK: use the built-in scenes.";
    if (x.video && light()) return "OK: show a full HD picture from this video (light mode is on).";
    if (x.video) return "OK: play this video on Home." + (x.size_mb > 150 ? " Big file, first time takes a minute or two to prepare." : "");
    return "OK: show this as a still picture. Animated scene wallpapers can't play on the TV.";
  }
  function paintChips() {
    $("wp-chips").innerHTML = CHIPS.map(function (c, i) {
      var n = P.loaded ? (c[0] === "video" ? P.items.filter(function (x) { return x.video; }).length : c[0] === "picture" ? P.items.filter(function (x) { return !x.video; }).length : P.items.length) : "";
      return '<div class="wp-chip' + (P.filter === c[0] ? " sel" : "") + (P.row === "chips" && P.ci === i ? " focus" : "") + '">' + c[1] + (n !== "" ? " <i style=\"font-style:normal;opacity:.65\">" + n + "</i>" : "") + "</div>";
    }).join("");
  }
  function paintGrid() {
    var list = P.view, rows = Math.ceil(list.length / COLS);
    var first = Math.max(0, P.top - 1), lastRow = Math.min(rows - 1, P.top + VISROWS);
    var h = "";
    for (var r = first; r <= lastRow; r++) {
      for (var c = 0; c < COLS; c++) {
        var i = r * COLS + c, x = list[i];
        if (!x) break;
        var isCur = (cur.id || "scenes") === x.id;
        var bg = x.preview ? "background-image:url(" + BASE + x.preview + ")" : "background-image:linear-gradient(135deg,#ff9a5a,#d8467f 55%,#4a2f8a)";
        h += '<div class="wp-card' + (P.row === "grid" && P.gi === i ? " focus" : "") + '" style="transform:translate(' + (c * CW) + "rem," + (r * CH) + 'rem)">' +
          '<div class="im" style="' + bg + '">' + (badge(x) ? '<span class="bd">' + badge(x) + "</span>" : "") + (isCur ? '<span class="ck">✓</span>' : "") + "</div>" +
          '<div class="tt">' + esc(x.title) + "</div></div>";
      }
    }
    var list_el = $("wp-list");
    list_el.innerHTML = h;
    list_el.style.transform = "translateY(" + (-P.top * CH) + "rem)";
    if (!list.length) list_el.innerHTML = '<div class="wp-empty">No wallpapers here.</div>';
  }
  function paintPicker() { paintChips(); paintGrid(); $("wp-note").textContent = P.note || hintText(); }
  function scrollTo(i) {
    var r = Math.floor(i / COLS);
    if (r < P.top) P.top = r; else if (r > P.top + VISROWS - 1) P.top = r - VISROWS + 1;
  }

  function openPicker() {
    ensurePicker();
    BASE = H.base();
    P.open = true; P.row = "grid"; P.filter = (cur && cur.id && cur.id !== "scenes" && cur.kind !== "video") ? "picture" : "video"; P.top = 0; P.note = "";
    P.prev = { id: cur.id };
    var el = $("wpick"); el.classList.add("on");
    var sp = $("settings"); if (sp) sp.classList.add("behind");
    function show() {
      P.view = filtered();
      var at = 0; P.view.forEach(function (x, i) { if (x.id === (cur.id || "scenes")) at = i; });
      P.gi = at; scrollTo(at);
      if (at >= COLS * VISROWS) P.top = Math.max(0, Math.floor(at / COLS) - 0);
      paintPicker();
    }
    if (!H.online()) { P.items = []; P.note = "The computer isn't answering."; show(); return; }
    if (P.loaded) show();
    get("/api/wallpapers").then(function (j) {
      P.items = j.items || []; P.loaded = true;
      P.items.forEach(function (x) { meta[x.id] = x; });
      if (!j.engine) P.note = "Wallpaper Engine wasn't found on the computer.";
      else if (!j.ffmpeg) P.note = "Videos need ffmpeg on the computer.";
      if (P.open) show();
    }, function () { P.note = "The computer isn't answering."; if (P.open) show(); });
    show();
  }
  function closePicker() {
    P.open = false;
    clearTimeout(P.prevT);
    var el = $("wpick"); if (el) el.classList.remove("on");
    var sp = $("settings"); if (sp) sp.classList.remove("behind");
    // undo a preview that was not chosen
    if (P.previewed) { P.previewed = false; apply(cur); }
    H.settings();
  }
  function choose(x) {
    P.note = "";
    post("/api/wallpaper", { id: x.id, t: Date.now() }).then(function (s) {
      lsSet(JANKY, null);
      lastT = s.t; remember(s.id, s.t);
      P.prev = { id: s.id }; P.previewed = false;
      apply(s);
      closePicker();
    }, function (e) { P.note = e.message || "That didn't work."; paintPicker(); });
  }
  function previewFocus() {   // the picture of the card under focus shows behind the sheet after a short pause
    clearTimeout(P.prevT);
    var x = P.view[P.gi];
    if (P.row !== "grid" || !x) return;
    P.prevT = setTimeout(function () {
      if (!P.open) return;
      if (x.id === "scenes") { P.previewed = true; stopVideo(); setOn(false); return; }
      P.previewed = true; setOn(true); stopVideo(); showStill("/api/wallpapers/" + x.id + "/still");
    }, 450);
  }
  function key(e) {
    if (!P.open) return;
    var type = e.type;
    e.preventDefault(); e.stopImmediatePropagation();
    if (type !== "keydown") return;
    var a = H.arrowOf(e);
    if (a) {
      var dx = a[0], dy = a[1];
      if (P.row === "chips") {
        if (dx) P.ci = Math.max(0, Math.min(CHIPS.length - 1, P.ci + dx));
        else if (dy > 0 && P.view.length) { P.row = "grid"; }
      } else {
        var n = P.view.length, i = P.gi;
        if (dx) i = Math.max(0, Math.min(n - 1, i + dx));
        else if (dy > 0) i = Math.min(n - 1, i + COLS);
        else if (dy < 0) { if (i < COLS) { P.row = "chips"; P.ci = CHIPS.map(function (c) { return c[0]; }).indexOf(P.filter); } else i -= COLS; }
        P.gi = i; scrollTo(i);
      }
      paintPicker(); previewFocus();
      return;
    }
    if (H.isBack(e)) { closePicker(); return; }
    if (H.isOk(e)) {
      if (e.repeat) return;
      if (P.row === "chips") {
        P.filter = CHIPS[P.ci][0]; P.view = filtered(); P.gi = 0; P.top = 0; P.row = "grid"; paintPicker(); previewFocus();
      } else if (P.view[P.gi]) choose(P.view[P.gi]);
    }
  }
  ["keydown", "keyup", "keypress"].forEach(function (t) { window.addEventListener(t, key, true); });

  // ---------------- public ----------------
  window.TVOS_WP = {
    label: function () {
      var id = cur && cur.id;
      if (!id || id === "scenes") return "Built-in scenes";
      var m = meta[id]; var t = m ? m.title : (cur.title || "Wallpaper Engine");
      if (t.length > 28) t = t.slice(0, 27) + "…";
      return "Wallpaper Engine: " + esc(t);
    },
    open: function () { if (H) openPicker(); },
    pause: pause, resume: resume,
    refresh: function () { if (cur && cur.id && cur.id !== "scenes") apply(cur); },
    state: function () { return cur; }
  };

  function wrapTv(n) {   // the TV's Back and Resume reach the page through window.tv, not as key presses
    var T = window.tv;
    if (!T || !T.back) { if (n < 50) setTimeout(function () { wrapTv(n + 1); }, 200); return; }
    var ob = T.back; T.back = function () { if (P.open) { closePicker(); return; } return ob.apply(this, arguments); };
    if (T.resume) { var or_ = T.resume; T.resume = function () { var r = or_.apply(this, arguments); resume("hidden"); sync(); return r; }; }
  }
  function start() {
    if (!window.TVOS_HOME) { setTimeout(start, 200); return; }
    H = window.TVOS_HOME;
    BASE = H.base();
    wrapTv(0);
    var m = mine();
    // use the saved choice straight away (the bridge may be slow), then confirm with the bridge
    if (m && m.id && m.id !== "scenes" && H.online()) {
      apply({ id: m.id, kind: "image", url: "/api/wallpapers/" + m.id + "/still", state: "ready" });
    }
    sync().then(function () {
      var m2 = mine();
      if (!m2) return;
      // titles for the Settings row
      if (H.online() && m2.id !== "scenes") get("/api/wallpapers").then(function (j) {
        (j.items || []).forEach(function (x) { meta[x.id] = x; }); H.settings();
      }, function () {});
    });
    startPoll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
