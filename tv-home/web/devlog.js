// Dev log: Settings > Dev log. A dated history of what changed, read from devlog.json (served next to this page
// by the bridge, and packaged in the app for offline). Self-contained; app.js only opens it and forwards keys.
(function () {
  "use strict";
  var TYPES = { new: "New", improved: "Improved", fixed: "Fixed", security: "Security", internal: "Behind the scenes" };
  var FILTERS = [
    { label: "All", types: null },
    { label: "New", types: ["new"] },
    { label: "Improved", types: ["improved"] },
    { label: "Fixed", types: ["fixed"] }
  ];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  var el = null, state = "idle", all = [], fi = 0, ii = 0, openId = "", inFilters = false, onClose = null;

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function parseDay(d) { var p = d.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function dayName(d) { var t = parseDay(d); return DAYS[t.getDay()] + ", " + LONG[t.getMonth()] + " " + t.getDate(); }
  function clock(t) { var p = t.split(":"), h = +p[0]; return ((h + 11) % 12 + 1) + ":" + p[1] + " " + (h < 12 ? "AM" : "PM"); }
  function shortStamp(e) { var t = parseDay(e.date); return MONTHS[t.getMonth()] + " " + t.getDate() + ", " + clock(e.time); }

  function matches(e, f) { return !f.types || f.types.indexOf(e.type) >= 0; }
  function visible() {   // newest first
    var f = FILTERS[fi];
    return all.filter(function (e) { return matches(e, f); }).reverse();
  }

  function build() {
    if (el) return;
    el = document.createElement("div");
    el.className = "settings about devlog";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Dev log");
    el.innerHTML = '<div class="settings-panel dl-panel">' +
      '<div class="dl-head"><h2>Dev log</h2><div class="dl-badge" id="dl-badge"></div></div>' +
      '<div class="dl-filters" id="dl-filters"></div>' +
      '<div class="dl-list" id="dl-list"></div>' +
      '<p class="settings-help" id="dl-help">Up and down to browse. OK for details. Back to close.</p></div>';
    document.body.appendChild(el);
  }

  function paintBadge() {
    var b = document.getElementById("dl-badge");
    if (state !== "ready" || !all.length) { b.innerHTML = '<span class="dl-ver">Asher’s tvOS</span>'; return; }
    var last = all[all.length - 1];
    b.innerHTML = '<span class="dl-ver">Asher’s tvOS ' + esc(last.version) + '</span><span class="dl-when">Latest update ' + esc(shortStamp(last)) + "</span>";
  }

  function paintFilters() {
    document.getElementById("dl-filters").innerHTML = FILTERS.map(function (f, i) {
      var n = all.filter(function (e) { return matches(e, f); }).length;
      return '<span class="dl-chip' + (i === fi ? " on" : "") + (inFilters && i === fi ? " focus" : "") + '">' + f.label +
        (state === "ready" ? " <i>" + n + "</i>" : "") + "</span>";
    }).join("");
  }

  function paintList() {
    var list = document.getElementById("dl-list");
    if (state === "loading") {
      list.innerHTML = [0, 1, 2, 3].map(function () {
        return '<div class="dl-skel"><i class="skel" style="width:28%"></i><i class="skel" style="width:74%"></i><i class="skel" style="width:52%"></i></div>';
      }).join("");
      return;
    }
    if (state === "error") { list.innerHTML = '<div class="dl-empty"><b>Can’t load the Dev log</b>The list lives on the PC. Check it’s on, then press OK to try again.</div>'; return; }
    var rows = visible();
    if (!rows.length) { list.innerHTML = '<div class="dl-empty"><b>Nothing here yet</b>No ' + esc(FILTERS[fi].label.toLowerCase()) + " changes have been logged.</div>"; return; }
    if (ii >= rows.length) ii = rows.length - 1;
    var out = "", day = "";
    rows.forEach(function (e, n) {
      if (e.date !== day) { day = e.date; out += '<div class="dl-day">' + esc(dayName(day)) + "</div>"; }
      var on = !inFilters && n === ii, op = e.id === openId;
      out += '<div class="dl-item' + (on ? " focus" : "") + (op ? " open" : "") + '">' +
        '<div class="dl-meta"><span class="dl-type t-' + esc(e.type) + '">' + esc(TYPES[e.type] || e.type) + '</span><span class="dl-time">' + esc(clock(e.time)) + '</span><span class="dl-v">' + esc(e.version) + "</span></div>" +
        '<div class="dl-title">' + esc(e.title) + "</div>" +
        '<div class="dl-sum">' + esc(e.summary) + "</div>" +
        (op && e.details && e.details.length ? '<ul class="dl-det">' + e.details.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>" : "") +
        "</div>";
    });
    list.innerHTML = out;
  }

  var listTop = 0;
  function follow(instant) {
    var list = document.getElementById("dl-list"), f = list.querySelector(".dl-item.focus");
    var to = listTop;
    if (!f) { if (inFilters) to = 0; }
    else {
      var sticky = 64, top = f.offsetTop - sticky, bottom = f.offsetTop + f.offsetHeight - list.clientHeight + 28;
      if (to > top) to = top; else if (to < bottom) to = Math.min(bottom, top);
      if (ii === 0) to = 0;
    }
    list.style.scrollBehavior = instant ? "auto" : "";
    list.scrollTop = to; listTop = list.scrollTop;
  }

  function paint(instant) {
    var list = document.getElementById("dl-list");
    list.style.scrollBehavior = "auto"; list.scrollTop = listTop; list.style.scrollBehavior = "";
    paintBadge(); paintFilters(); paintList();
    list.style.scrollBehavior = "auto"; list.scrollTop = listTop; list.style.scrollBehavior = "";
    if (state === "ready") follow(instant);
  }

  // moving between entries only swaps the focus class, so the CSS spring plays and the scroll glides
  function refocus() {
    var items = document.querySelectorAll("#dl-list .dl-item");
    for (var n = 0; n < items.length; n++) items[n].classList.toggle("focus", !inFilters && n === ii);
    var chips = document.querySelectorAll("#dl-filters .dl-chip");
    for (var c = 0; c < chips.length; c++) chips[c].classList.toggle("focus", inFilters && c === fi);
    follow(false);
  }

  function load() {
    state = "loading"; listTop = 0; paint(true);
    var x = new XMLHttpRequest();
    x.open("GET", "devlog.json?t=" + Date.now());
    x.timeout = 6000;
    x.onload = function () {
      try {
        if (x.status && x.status !== 200 && x.status !== 0) throw new Error("status");
        var j = JSON.parse(x.responseText);
        all = (j.entries || []).slice().sort(function (a, b) { return (a.date + a.time + a.id) < (b.date + b.time + b.id) ? -1 : 1; });
        state = "ready";
      } catch (e) { state = "error"; }
      if (el && el.classList.contains("on")) paint(true);
    };
    x.onerror = x.ontimeout = function () { state = "error"; if (el && el.classList.contains("on")) paint(true); };
    x.send();
  }

  var api = {
    open: function (closeCb) {
      build(); onClose = closeCb || null;
      fi = 0; ii = 0; openId = ""; inFilters = false; listTop = 0;
      load();
      clearTimeout(el._lv); el.classList.remove("out"); el.classList.add("on");
      var s = document.getElementById("settings"); if (s) s.classList.add("behind");
    },
    close: function () {
      if (!el) return;
      clearTimeout(el._lv); el.classList.remove("on", "out");
      var s = document.getElementById("settings"); if (s) s.classList.remove("behind");
      if (onClose) onClose();
    },
    isOpen: function () { return !!el && el.classList.contains("on"); },
    move: function (dx, dy) {
      if (state !== "ready") return;
      if (inFilters) {
        if (dx) { fi = Math.max(0, Math.min(FILTERS.length - 1, fi + dx)); ii = 0; openId = ""; listTop = 0; paint(true); }
        else if (dy > 0 && visible().length) { inFilters = false; refocus(); }
        return;
      }
      if (!dy) return;
      if (dy < 0 && ii === 0) { inFilters = true; refocus(); return; }
      ii = Math.max(0, Math.min(visible().length - 1, ii + dy));
      refocus();
    },
    ok: function () {
      if (state === "error") { load(); return; }
      if (state !== "ready") return;
      if (inFilters) { if (visible().length) { inFilters = false; refocus(); } return; }
      var e = visible()[ii];
      if (!e) return;
      openId = openId === e.id ? "" : e.id;
      paint(false);
    },
    back: function () { if (openId) { openId = ""; paint(false); return; } api.close(); }
  };
  window.DevLog = api;
})();
