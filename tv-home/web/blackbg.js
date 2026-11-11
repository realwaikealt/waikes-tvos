/* Black background: no scenes, no wallpaper, a plain black screen that glows softly in the colour of whatever is selected
   (an app's icon, a Keep watching poster). Settings > Wallpaper & animation > Background. Only opacity and transform animate:
   two big soft glows trade places (A/B) and slide to the selected item, so the weak TV GPU never repaints a full-screen gradient.
   Needs window.TVOS_HOME from app.js. */
(function () {
  "use strict";
  var H = null, on = false, A = null, B = null, cur = 0, lastEl = null, raf = 0, obs = null;
  var cache = {}, cv = null;

  var CSS =
    "html.bgblack,html.bgblack body{background:#000!important}" +
    "html.bgblack #scenes .sbg,html.bgblack #scenes .fg,html.bgblack #scenes .shade,html.bgblack .scrim,html.bgblack #wpbg,html.bgblack #wpstill,html.bgblack #wpvid{display:none!important}" +
    "#bgglow{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;display:none}" +
    "html.bgblack #bgglow{display:block}" +
    "#bgglow i{position:absolute;left:0;top:0;width:80vw;height:80vw;margin:-40vw 0 0 -40vw;border-radius:50%;opacity:0;will-change:transform,opacity;" +
    "background:radial-gradient(circle,var(--g,#555) 0%,rgba(0,0,0,0) 62%);transition:opacity 900ms ease-out,transform 700ms cubic-bezier(.2,.8,.2,1)}" +
    "#bgglow i.on{opacity:.7}";

  function css() { var s = document.createElement("style"); s.textContent = CSS; document.head.appendChild(s); }
  function hash(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
  function keyOf(el) { return el.getAttribute("data-k") || el.getAttribute("data-pkg") || el.getAttribute("data-id") || (el.textContent || "").trim().slice(0, 40) || "x"; }

  function fromImage(img) {   // average the lively pixels of the picture; fails (cross-origin) on some icons
    if (!img || !img.complete || !img.naturalWidth) return null;
    try {
      cv = cv || document.createElement("canvas"); cv.width = cv.height = 16;
      var g = cv.getContext("2d"); g.drawImage(img, 0, 0, 16, 16);
      var d = g.getImageData(0, 0, 16, 16).data, r = 0, gg = 0, b = 0, w = 0;
      for (var i = 0; i < d.length; i += 4) {
        var mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        var sat = mx ? (mx - mn) / mx : 0, wt = d[i + 3] / 255 * (0.15 + sat) * (mx > 30 ? 1 : 0.1);
        r += d[i] * wt; gg += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
      }
      if (w < 0.5) return null;
      return [Math.round(r / w), Math.round(gg / w), Math.round(b / w)];
    } catch (e) { return null; }
  }
  function fromFace(el) {   // a tile with a solid brand colour
    var f = el.querySelector(".face") || el;
    var m = (getComputedStyle(f).backgroundColor || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    var p = m[1].split(",").map(parseFloat);
    return (p.length > 3 && p[3] < 0.3) ? null : [p[0], p[1], p[2]];
  }
  function boost(c) {   // keep the hue, lift it to a lively, bright-enough colour
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), h = 0, d = mx - mn;
    if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = Math.round(h * 60); if (h < 0) h += 360; }
    var s = d ? Math.max(0.6, Math.min(1, d / (1 - Math.abs(mx + mn - 1) || 1))) : 0;   // greys stay grey-white
    return d < 0.06 ? "hsl(0,0%,70%)" : "hsl(" + h + "," + Math.round(s * 100) + "%,52%)";
  }
  function corsCopy(img, k, el) {   // the TV serves icons with an open CORS header, so a fresh anonymous load can be read
    if (!img || !img.src || cache["~" + k]) return;
    cache["~" + k] = 1;
    var n = new Image(); n.crossOrigin = "anonymous";
    n.onload = function () { var c = fromImage(n); if (c) { cache[k] = boost(c); if (lastEl && keyOf(lastEl) === k) schedule(); } };
    n.src = img.src;
  }
  function dull(c) { return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 24; }   // grey or near grey: no brand colour in it
  function colorFor(el) {
    var k = keyOf(el);
    if (cache[k]) return cache[k];
    var img = el.querySelector("img");
    // the picture comes first: a tile's own backdrop is dark grey and would make every glow white
    var c = img ? fromImage(img) : fromFace(el);
    if (c && !dull(c)) { cache[k] = boost(c); return cache[k]; }
    if (img) corsCopy(img, k, el);
    return "hsl(" + (hash(k) % 360) + ",70%,50%)";   // until the real colour is known
  }

  function focusEl() { return document.querySelector(".app.focus, .ncard.focus, .qbtn.focus, .tile.focus, .person.focus"); }
  function update() {
    raf = 0;
    if (!on) return;
    var el = focusEl();
    if (!el) return;
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var col = colorFor(el);
    var next = cur ? A : B, prev = cur ? B : A;
    cur = cur ? 0 : 1;
    next.style.setProperty("--g", col);
    next.style.transform = "translate3d(" + Math.round(x) + "px," + Math.round(y) + "px,0)";
    next.classList.add("on");
    prev.classList.remove("on");
    lastEl = el;
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(update); }
  function changed() { if (!on) return; var el = focusEl(); if (el !== lastEl) schedule(); }

  function apply() {
    var want = !!(H && H.get("bg") === "black");
    if (want === on) return;
    on = want;
    document.documentElement.classList.toggle("bgblack", on);
    if (window.TVOS_WP) { if (on) TVOS_WP.pause("bgblack"); else TVOS_WP.resume("bgblack"); }
    if (H && H.freezeScenes) H.freezeScenes(on || !!document.documentElement.classList.contains("wp-on"));
    if (on) { lastEl = null; schedule(); } else { A.classList.remove("on"); B.classList.remove("on"); }
  }

  function init() {
    if (!window.TVOS_HOME || !document.body) { setTimeout(init, 200); return; }
    H = window.TVOS_HOME;
    css();
    var g = document.createElement("div"); g.id = "bgglow"; g.setAttribute("aria-hidden", "true");
    A = document.createElement("i"); B = document.createElement("i");
    g.appendChild(A); g.appendChild(B);
    document.body.insertBefore(g, document.body.firstChild);
    obs = new MutationObserver(changed);
    obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
    window.TVBG = { apply: apply, refresh: schedule };
    apply();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
