/* One /api/home call answers the burst of separate GETs the home page makes when it starts.
   app.js asks HomePrime.get(path, fetchHome); a null answer means "not mine, ask the bridge yourself".
   Each part is handed out once, and the whole snapshot is dropped after 4 s, so nothing goes stale. */
(function () {
  var snap = null, pending = null, brokenUntil = 0, born = 0;
  var PARTS = { "/api/people": "people", "/api/screens": "screens", "/api/webapps": "webapps", "/api/who": "who",
                "/api/apps": "apps", "/api/app-order": "order", "/api/arrange": "arrange", "/api/weather": "weather" };
  function load(fetchHome) {
    if (snap && Date.now() - born < 4000) return Promise.resolve(snap);
    if (pending) return pending;
    snap = null;
    var t0 = Date.now();
    pending = fetchHome().then(function (j) {
      snap = j; born = Date.now(); pending = null;
      if (window.__perfMark) window.__perfMark("api-home " + (Date.now() - t0) + "ms");
      return j;
    }, function (e) { pending = null; brokenUntil = Date.now() + 60000; throw e; });
    return pending;
  }
  window.HomePrime = {
    get: function (path, fetchHome) {
      if (Date.now() < brokenUntil) return null;
      var q = path.indexOf("?"), base = q < 0 ? path : path.slice(0, q), part = null, who = null;
      if (base === "/api/continue") { var m = /[?&]who=([^&]+)/.exec(path); who = m && decodeURIComponent(m[1]); if (!who) return null; }
      else if (!(base in PARTS)) return null;
      else part = PARTS[base];
      // only /api/people starts a snapshot (it is first in the burst); the rest just use a fresh one
      var fresh = pending || (snap && Date.now() - born < 4000);
      if (!fresh && base !== "/api/people") return null;
      return load(fetchHome).then(function (j) {
        var v;
        if (who) { var items = j["continue"] && j["continue"][who]; v = items ? { ok: true, items: items } : null; if (v) delete j["continue"][who]; }
        else { v = j[part]; j[part] = null; }
        if (!v) throw new Error("not in the home answer");
        return v;
      });
    }
  };
})();
