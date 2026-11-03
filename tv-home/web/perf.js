/* Startup timing marks (ms since navigationStart). Ring buffer in window.__perf, also logged to the console. */
(function () {
  var ring = window.__perf = window.__perf || [];
  function t() { return Math.round(performance.now()); }   // performance.now() is relative to navigationStart
  function mark(name) {
    if (ring.length >= 40) ring.shift();
    var e = { name: name, ms: t() };
    ring.push(e);
    try { console.log("[perf] " + name + " " + e.ms + "ms"); } catch (x) {}
  }
  window.__perfMark = mark;
  mark("perf.js");
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (en) { if (!en.__seen) mark(en.name); });
    }).observe({ type: "paint", buffered: true });
  } catch (x) {}
  var seen = {};
  function watch(id, name) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.children.length) { mark(name); return true; }
    var mo = new MutationObserver(function () {
      if (el.children.length && !seen[name]) { seen[name] = 1; mo.disconnect(); mark(name); }
    });
    mo.observe(el, { childList: true });
    return true;
  }
  document.addEventListener("DOMContentLoaded", function () {
    mark("DOMContentLoaded");
    watch("shelf", "shelf-rendered"); watch("grid", "dock-rendered");
    var b = document.getElementById("boot");
    if (b) {
      var mo = new MutationObserver(function () {
        if (!document.getElementById("boot")) { mo.disconnect(); mark("boot-removed"); }
      });
      mo.observe(document.body, { childList: true });
    }
  });
  window.addEventListener("load", function () { mark("load"); });
  // one report to the PC a few seconds after start (not when offline or previewing)
  setTimeout(function () {
    if (/[?&](offline=1|preview|mock)/.test(location.search) || !/^https?:/.test(location.protocol)) return;
    try {
      var x = new XMLHttpRequest();
      x.open("POST", "/api/perf"); x.setRequestHeader("Content-Type", "application/json"); x.timeout = 4000;
      x.send(JSON.stringify({ marks: ring.slice(), href: location.pathname }));
    } catch (e) {}
  }, 7000);
})();
