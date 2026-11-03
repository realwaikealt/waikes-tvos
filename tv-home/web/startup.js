/* Startup animation for Asher’s tvOS: the “operating system launching” moment.
 *
 * Owns the #boot overlay (markup + CSS live in index.html, so it paints before anything else loads).
 *   cold start   mark → wordmark letter by letter → progress that follows the real loading stages → “door opens” onto Home
 *   wake         the same, short (about a second), played when the TV wakes from standby (the launcher calls tv.wake())
 *   short / off  Settings > Startup animation
 * Everything animates transform and opacity only (no blur, no endless loops). Home never waits longer than it really
 * needs to: the animation has a floor (min) and ends the moment the page is ready.
 *
 * API (window.TVSTART): mode() min() stage(frac, text) finish(el, done) wake() play(kind) setMode(m)
 */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var NAME = "Asher’s tvOS";
  var native = !!window.TVOS;            // inside the launcher: the native splash already drew the logo
  var reduced = false;
  try { reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) {}

  function savedMode() {
    var m = null;
    try {
      var raw = (window.TVOS && TVOS.kept && TVOS.kept("tvhome.settings")) || localStorage.getItem("tvhome.settings") ||
        localStorage.getItem("mock:tvhome.settings");
      m = raw ? JSON.parse(raw).startup : null;
    } catch (e) {}
    return m === "short" || m === "off" ? m : "full";
  }
  var MODE = savedMode();

  // A page reload a moment after start (settings synced from the computer) is not a new launch: no replay.
  var soft = false;
  try {
    var t = +sessionStorage.getItem("tvstart.t") || 0;
    soft = t && Date.now() - t < 25000;
    sessionStorage.setItem("tvstart.t", String(Date.now()));
  } catch (e) {}

  var boot = doc.getElementById("boot");
  var TPL = boot ? boot.innerHTML : "";
  var kind = reduced ? "reduced" : MODE === "off" || soft ? "off" : MODE === "short" ? "short" : "full";

  function letters(el) {
    var n = el && el.querySelector(".boot-name");
    if (!n || n.getAttribute("data-split")) return;
    n.setAttribute("data-split", "1");
    var h = "";
    for (var i = 0; i < NAME.length; i++) h += '<i style="--i:' + i + '">' + (NAME[i] === " " ? "&nbsp;" : NAME[i]) + "</i>";
    n.setAttribute("aria-label", NAME);
    n.innerHTML = h;
  }
  function setup(el, k, pre) {
    el.className = "k-" + k + (pre ? " pre" : "");
    el.style.setProperty("--p", "0.06");
    letters(el);
  }

  var cur = null, stageT = 0, started = 0, finished = false;
  if (boot) {
    setup(boot, kind, native);
    if (kind === "full" || kind === "short") root.classList.add("booting");   // Home waits behind the overlay, then arrives
    cur = boot; started = Date.now();
  }

  function minFor(k) { return k === "full" ? 1600 : k === "short" ? 900 : k === "wake" ? 450 : 0; }

  function stage(frac, text) {
    if (!cur) return;
    stageT = Date.now();
    cur.style.setProperty("--p", String(Math.max(0.06, Math.min(1, frac))));
    var n = cur.querySelector(".boot-note");
    if (n && text && (kind === "full" || cur.className.indexOf("k-full") >= 0)) { n.textContent = text; n.classList.add("on"); }
  }

  // The door opens: the mark and name zoom past you, the ground fades, Home arrives (rise / fade animations in app.css).
  function open(el, done) {
    var k = (el.className.match(/k-(\w+)/) || [])[1] || "full";
    el.classList.add("open");
    root.classList.remove("booting");
    var ms = k === "off" || k === "reduced" ? 320 : 700;
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); if (done) done(); }, ms);
  }
  function finish(el, done) {
    el = el || cur;
    if (!el) { root.classList.remove("booting"); if (done) done(); return; }
    open(el, done);
  }

  // Play the sequence again over whatever is on screen (Settings > Play now, Developer > Replay, wake from standby).
  var playing = false;
  function play(k, done) {
    if (playing || (boot && boot.parentNode)) { if (done) done(); return; }
    playing = true;
    var el = doc.createElement("div");
    el.id = "boot"; el.setAttribute("aria-hidden", "true"); el.innerHTML = TPL;
    el.querySelector(".boot-name").removeAttribute("data-split");
    setup(el, k, true);
    el.classList.add("replay");
    doc.body.appendChild(el);
    var prev = cur; cur = el; kind = k;
    var steps = k === "wake" ? [[120, 0.5], [320, 0.9]] : k === "short" ? [[250, 0.6], [550, 1]] : [[400, 0.2, "Starting up"], [800, 0.45, "Loading your apps"], [1100, 0.7, "Checking the weather"], [1350, 1, "Ready"]];
    steps.forEach(function (s) { setTimeout(function () { if (el.parentNode) { el.style.setProperty("--p", String(s[1])); var n = el.querySelector(".boot-note"); if (s[2] && n) { n.textContent = s[2]; n.classList.add("on"); } } }, s[0]); });
    var hold = k === "wake" ? 450 : k === "short" ? 900 : 1700;
    setTimeout(function () {
      open(el, function () { playing = false; cur = prev; if (done) done(); });
    }, hold);
  }

  function setMode(m) { MODE = m === "short" || m === "off" ? m : "full"; }

  window.TVSTART = {
    mode: function () { return MODE; },
    min: function () { return minFor(kind); },
    kind: function () { return kind; },
    stage: stage,
    finish: function (el, done) { finished = true; finish(el, done); },
    wake: function () {
      if (MODE === "off" || reduced) return;
      play("wake");
    },
    play: function (k) { play(k || (MODE === "off" ? "short" : MODE)); },
    setMode: setMode
  };
})();
