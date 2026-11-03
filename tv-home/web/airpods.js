// Settings > AirPods & Bluetooth audio. Self-contained: the native side (AirPodsWatcher.kt) does the Bluetooth work
// and shows the pop-up; this page is the controls, the live status and the guided "Pair AirPods" steps.
// It listens for keys itself (capture phase, like wallpaper.js) while open, so app.js only has the Settings row.
// Needs window.TVOS (the launcher) for anything real; in a browser it explains that and stays out of the way.
(function () {
  "use strict";
  var TV = window.TVOS || null, H = null, el = null, open = false, view = "main", ri = 0, poll = null, st = {}, note = "";
  var SENS = [["0", "Very close"], ["1", "Near the TV"], ["2", "Same room"]];

  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function read() {
    if (!TV || !TV.btStatus) return {};
    try { return JSON.parse(TV.btStatus()) || {}; } catch (e) { return {}; }
  }
  function flow() { return (st.flow && st.flow.state) || "idle"; }
  function busy() { var f = flow(); return f === "looking" || f === "bonding" || f === "connecting"; }

  function rows() {
    var r = [];
    r.push({ k: "on", label: "AirPods pop-up", val: st.enabled === false ? "Off" : "On", arrows: true });
    r.push({ k: "sens", label: "Close-range sensitivity", val: (SENS.filter(function (s) { return s[0] === String(st.sens == null ? 1 : st.sens); })[0] || SENS[1])[1], arrows: true });
    r.push({ k: "pair", label: "Pair AirPods", val: st.connected ? "Reconnect" : "Start" });
    r.push({ k: "bt", label: "Bluetooth audio (the TV’s Bluetooth page)", val: "Open" });
    if (TV && st.available !== false && st.permission === false) r.push({ k: "allow", label: "Allow nearby-device access", val: "Allow" });
    r.push({ k: "done", label: "Done", val: "Close" });
    return r;
  }

  function build() {
    if (el) return;
    el = document.createElement("div");
    el.className = "settings about airpods";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "AirPods and Bluetooth audio");
    el.innerHTML = '<div class="settings-panel ap-panel"><h2>AirPods &amp; Bluetooth audio</h2>' +
      '<div class="ap-out" id="ap-out"></div><div class="settings-list" id="ap-body"></div>' +
      '<p class="settings-note" id="ap-note"></p><p class="settings-help" id="ap-help"></p></div>';
    document.body.appendChild(el);
  }

  function outLine() {
    if (!TV || !TV.btStatus) return '<span class="ap-dot"></span><span><b>This works on the TV itself.</b> Open Settings on the TV to use it.</span>';
    if (st.available === false) return '<span class="ap-dot off"></span><span><b>This TV has no Bluetooth.</b></span>';
    var on = !!st.connected;
    return '<span class="ap-dot' + (on ? " on" : "") + '"></span><span>Sound plays through <b>' + esc(on ? st.connected : "the TV speakers") + "</b>" +
      (st.bluetooth === false ? " · Bluetooth is off" : "") + "</span>";
  }

  function paint() {
    if (!el) return;
    document.getElementById("ap-out").innerHTML = outLine();
    var body = document.getElementById("ap-body"), help = document.getElementById("ap-help");
    if (view === "pair") {
      var f = flow(), text = (st.flow && st.flow.text) || "";
      var steps = ["Put both AirPods in the case and open the lid.", "Hold the round button on the back of the case until the light flashes white.", "Keep the case next to the TV. It takes about ten seconds."];
      var acts = busy() ? ["Cancel"] : f === "failed" ? ["Try again", "Back"] : f === "connected" ? ["Done"] : ["Start", "Back"];
      if (ri >= acts.length) ri = acts.length - 1;
      body.innerHTML = '<ol class="ap-steps">' + steps.map(function (s, i) { return '<li><i>' + (i + 1) + "</i><span>" + esc(s) + "</span></li>"; }).join("") + "</ol>" +
        '<div class="ap-status ' + f + '"><b>' + esc({ idle: "Ready", looking: "Looking…", bonding: "Pairing…", connecting: "Connecting…", connected: "Connected", failed: "Couldn’t connect" }[f] || "") + "</b>" +
        '<span>' + esc(text).replace(/\n/g, "<br>") + "</span></div>" +
        '<div class="ap-btns">' + acts.map(function (a, i) { return '<span class="ap-btn' + (i === ri ? " focus" : "") + '">' + a + "</span>"; }).join("") + "</div>";
      help.textContent = "OK to choose. Back to leave.";
      return;
    }
    var rs = rows();
    if (ri >= rs.length) ri = rs.length - 1;
    body.innerHTML = rs.map(function (r, i) {
      return '<div class="srow' + (i === ri ? " focus" : "") + '"><span class="sl">' + esc(r.label) + '</span><span class="sv' + (r.arrows ? "" : " act") + '">' +
        (r.arrows ? "‹&nbsp;&nbsp;" + esc(r.val) + "&nbsp;&nbsp;›" : esc(r.val)) + "</span></div>";
    }).join("");
    var tips = [];
    if (TV && st.permission === false) tips.push("Allow nearby-device access first, so the TV can hear your AirPods.");
    else if (TV && st.location === false) tips.push("Android needs Location switched on to hear Bluetooth devices (TV Settings > Device Preferences > Location).");
    else if (TV && st.enabled !== false) tips.push("Open the case lid next to the TV and a Connect card appears on the home screen.");
    if (TV && st.ads && st.ads.seen) tips.push("Heard " + st.ads.seen + " Apple headphone signal" + (st.ads.seen === 1 ? "" : "s") + " so far (latest " + st.ads.rssi + " dBm" + (st.ads.model ? ", " + st.ads.model : "") + ").");
    help.textContent = tips.join(" ");
    document.getElementById("ap-note").textContent = note;
  }

  function refresh() { st = read(); if (open) paint(); }
  function startPoll() { stopPoll(); poll = setInterval(refresh, 1000); }
  function stopPoll() { clearInterval(poll); poll = null; }

  function act(r) {
    if (!TV) return;
    if (r.k === "pair") { view = "pair"; ri = 0; note = ""; paint(); return; }
    if (r.k === "bt") { note = TV.btSettings && TV.btSettings() ? "" : "This TV has no Bluetooth page I can open."; paint(); return; }
    if (r.k === "allow") { TV.btAllow && TV.btAllow(); note = "Choose Allow on the TV’s question."; paint(); return; }
    if (r.k === "done") close();
  }

  function step(r, dir) {
    if (!TV || !TV.btSet) return;
    if (r.k === "on") { TV.btSet("on", st.enabled === false ? "1" : "0"); }
    else if (r.k === "sens") { var n = ((st.sens == null ? 1 : +st.sens) + dir + 3) % 3; TV.btSet("sens", String(n)); }
    setTimeout(refresh, 120);
  }

  function pairAct() {
    var f = flow();
    var acts = busy() ? ["Cancel"] : f === "failed" ? ["Try again", "Back"] : f === "connected" ? ["Done"] : ["Start", "Back"];
    var a = acts[ri];
    if (a === "Start" || a === "Try again") { TV && TV.btPair && TV.btPair(); setTimeout(refresh, 150); }
    else if (a === "Cancel") { TV && TV.btCancel && TV.btCancel(); setTimeout(refresh, 150); }
    else if (a === "Back" || a === "Done") { if (a === "Done") TV && TV.btCancel && TV.btCancel(); view = "main"; ri = 2; paint(); }
  }

  function key(e) {
    if (!open || !H) return;
    var type = e.type;
    e.preventDefault(); e.stopImmediatePropagation();
    if (type !== "keydown") return;
    var a = H.arrowOf(e);
    if (a) {
      var dx = a[0], dy = a[1];
      if (view === "pair") { if (dx) { ri = Math.max(0, ri + dx); paint(); } return; }
      var rs = rows();
      if (dy) { ri = Math.max(0, Math.min(rs.length - 1, ri + dy)); note = ""; paint(); }
      else if (dx && rs[ri].arrows) step(rs[ri], dx);
      return;
    }
    if (H.isBack(e)) { back(); return; }
    if (H.isOk(e)) {
      if (e.repeat) return;
      if (view === "pair") { pairAct(); return; }
      var r = rows()[ri];
      if (r.arrows) step(r, 1); else act(r);
    }
  }
  ["keydown", "keyup", "keypress"].forEach(function (t) { window.addEventListener(t, key, true); });

  function back() {
    if (view === "pair") { if (busy() && TV && TV.btCancel) TV.btCancel(); view = "main"; ri = 2; paint(); return; }
    close();
  }
  function close() {
    if (!el || !open) return;
    open = false; stopPoll();
    el.classList.remove("on");
    var s = document.getElementById("settings"); if (s) s.classList.remove("behind");
    if (H && H.settings) H.settings();
  }
  function openIt() {
    H = window.TVOS_HOME;
    if (!H) return;
    build(); st = read(); view = "main"; ri = 0; note = "";
    open = true; paint(); startPoll();
    el.classList.remove("out"); el.classList.add("on");
    var s = document.getElementById("settings"); if (s) s.classList.add("behind");
  }

  function wrapTv(n) {   // the TV's Back reaches the page through window.tv, not as a key press
    var T = window.tv;
    if (!T || !T.back) { if (n < 50) setTimeout(function () { wrapTv(n + 1); }, 200); return; }
    var ob = T.back; T.back = function () { if (open) { back(); return; } return ob.apply(this, arguments); };
  }
  wrapTv(0);

  window.TVOS_AP = {
    open: openIt, close: close, isOpen: function () { return open; },
    label: function () {
      var s = read();
      if (!TV || !s.available) return "Open";
      return s.connected ? "Connected" : (s.enabled === false ? "Off" : "On");
    }
  };
})();
