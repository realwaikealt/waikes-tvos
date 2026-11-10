/* Screensaver: a big clock, the date and the weather over whatever background Home is showing.
   Home's wallpaper (a Wallpaper Engine video while the PC is on) or the plain built-in scenes (PC off) keep playing
   behind it; the dock, the shelf and the buttons fade away. Starts after Settings > Screensaver minutes with no key press,
   or on demand (Settings > Start the screensaver now, or the phone). Any key closes it, and that key does nothing else.
   The clock drifts a little every minute so nothing stays in one spot. Only opacity/transform animate. Needs window.TVOS_HOME. */
(function () {
  "use strict";
  var H = null, el = null, on = false, last = Date.now(), tickT = null, driftT = null, idleT = null, drift = 0;
  var root = document.documentElement;

  var CSS =
    "#ss{position:fixed;inset:0;z-index:45;display:none;opacity:0;pointer-events:none;transition:opacity 900ms ease-out;" +
    "background:radial-gradient(ellipse at 50% 46%,rgba(0,0,0,.18) 0,rgba(0,0,0,.55) 100%)}" +
    "#ss.show{display:block}#ss.in{opacity:1}" +
    "#ss .ss-in{position:absolute;left:0;right:0;top:50%;text-align:center;transform:translateY(-52%);transition:transform 3000ms ease-in-out}" +
    "#ss .ss-time{font-family:'Antonio','Arial Narrow',sans-serif;font-weight:300;font-size:34rem;line-height:.86;letter-spacing:-.02em;white-space:nowrap;" +
    "color:rgba(255,255,255,.16);-webkit-text-stroke:.1rem rgba(255,255,255,.7);filter:drop-shadow(0 .4rem 2rem rgba(0,0,0,.25))}" +
    "#ss .ss-time small{font-size:.16em;letter-spacing:.04em;margin-left:.3em;-webkit-text-stroke:0;color:rgba(255,255,255,.7)}" +
    "#ss .ss-date{margin-top:3.4rem;font-size:var(--fs-headline,2.5rem);font-weight:500;color:rgba(255,255,255,.92);text-shadow:0 .1rem .8rem rgba(0,0,0,.45)}" +
    "#ss .ss-date .wx{margin-left:1.6rem;color:rgba(255,255,255,.8);font-weight:400}" +
    "#ss .ss-date svg{width:2.4rem;height:2.4rem;vertical-align:-.4rem;margin-right:.5rem}" +
    "html.saver .top,html.saver .shelf,html.saver .apps,html.saver .hint,html.saver .gclock,html.saver .date{opacity:0!important;transition:opacity 700ms ease-out}";

  function $(id) { return document.getElementById(id); }
  function featOn() { return !window.TVOS_FEAT || TVOS_FEAT.on("screensaver"); }
  function minutes() {
    var m = H && H.get ? H.get("saver") : null;
    return m == null ? 10 : +m;
  }

  function build() {
    if (el) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement("div"); el.id = "ss"; el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<div class="ss-in" id="ss-in"><div class="ss-time" id="ss-time"></div><div class="ss-date" id="ss-date"></div></div>';
    document.body.appendChild(el);
  }
  function fill() {   // the same clock and date strings Home shows, read live from the page
    var t = $("time"), d = $("date");
    $("ss-time").innerHTML = t && t.innerHTML ? t.innerHTML : (function () {
      var n = new Date(); return n.getHours() + ":" + (n.getMinutes() < 10 ? "0" : "") + n.getMinutes();
    })();
    if (d) $("ss-date").innerHTML = d.innerHTML;
  }
  function moveClock() {   // a small random drift so the picture is never fixed in one place
    drift = (drift + 1) % 4;
    var pos = [[0, 0], [-2.5, 1.5], [2.5, -1.5], [-1.5, -2]][drift];
    $("ss-in").style.transform = "translate(" + pos[0] + "rem," + pos[1] + "rem) translateY(-52%)";
  }

  function start() {
    if (on || !H || !featOn()) return;
    build(); fill();
    on = true;
    el.classList.add("show");
    root.classList.add("saver");
    void el.offsetWidth;
    el.classList.add("in");
    tickT = setInterval(fill, 1000);
    driftT = setInterval(moveClock, 60000);
  }
  function stop() {
    if (!on) return;
    on = false;
    clearInterval(tickT); clearInterval(driftT);
    root.classList.remove("saver");
    if (el) { el.classList.remove("in"); setTimeout(function () { if (!on && el) el.classList.remove("show"); }, 950); }
    last = Date.now();
  }

  // any key closes it, and is not passed on
  function key(e) {
    if (on) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === "keydown") stop();
      return;
    }
    last = Date.now();
  }
  ["keydown", "keyup", "keypress"].forEach(function (t) { window.addEventListener(t, key, true); });

  function busy() {   // never start over Settings, a message, a sheet or the picker
    return !!document.querySelector(".settings.on, #wpick.on, .msg.on, #msg.on, .sheet.on, .ask.on");
  }
  function idleCheck() {
    if (on || document.hidden || !H || !featOn()) return;
    var m = minutes();
    if (!m || busy()) return;
    if (Date.now() - last >= m * 60000) start();
  }

  function wrapTv(n) {   // the TV's Home, Back and Resume reach the page through window.tv, not as key presses
    var T = window.tv;
    if (!T || !T.back) { if (n < 50) setTimeout(function () { wrapTv(n + 1); }, 200); return; }
    ["back", "home", "resume"].forEach(function (k) {
      var o = T[k];
      if (typeof o !== "function") return;
      T[k] = function () { if (on) { stop(); return; } last = Date.now(); return o.apply(this, arguments); };
    });
  }

  window.TVSS = { start: start, stop: stop, isOn: function () { return on; } };

  function init() {
    if (!window.TVOS_HOME) { setTimeout(init, 200); return; }
    H = window.TVOS_HOME;
    wrapTv(0);
    idleT = setInterval(idleCheck, 15000);
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else last = Date.now(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
