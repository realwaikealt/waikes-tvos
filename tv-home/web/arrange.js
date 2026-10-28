/* Auto arrange for the TV home: which group an app is in, and the order the dock and All apps use.
   The same steps as bridge/arrange.py (sort_apps), on the same rules (arrange-rules.js), so the TV and the
   phone agree; bridge/test_arrange.py writes the expected answers and arrange-test.js checks this side.
   It only decides what to show. Nothing is ever disabled or removed from the TV. */
(function (root) {
  var R = root.ARRANGE_RULES || { categories: [], packages: {}, patterns: [], names: [], rank: [] };
  var MODES = ["smart", "used", "recent", "az", "category", "manual"];
  var LABELS = { smart: "Smart", used: "Most used", recent: "Recently used", az: "A to Z", category: "By group", manual: "My order" };

  function rx(list) {
    var out = [];
    (list || []).forEach(function (r) { try { out.push([new RegExp(r[0], "i"), r[1]]); } catch (e) {} });
    return out;
  }
  var PAT = rx(R.patterns), NAMES = rx(R.names);
  var CATS = (R.categories || []).map(function (c) { return c.id; });
  var CAT_LABEL = {};
  (R.categories || []).forEach(function (c) { CAT_LABEL[c.id] = c.label; });

  function classify(pkg, name) {
    if (String(pkg || "").indexOf("web:") === 0) return "streaming";   // web apps (bridge/webapps.py)
    if (R.packages && Object.prototype.hasOwnProperty.call(R.packages, pkg)) return R.packages[pkg];
    var i;
    for (i = 0; i < PAT.length; i++) if (PAT[i][0].test(pkg || "")) return PAT[i][1];
    var n = String(name || "").replace(/^\s+|\s+$/g, "");
    for (i = 0; i < NAMES.length; i++) if (NAMES[i][0].test(n)) return NAMES[i][1];
    return "other";
  }
  function rank(pkg) { var i = (R.rank || []).indexOf(pkg); return i < 0 ? 999 : i; }

  function strs(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (x) { if (typeof x === "string" && x.length < 200 && out.indexOf(x) < 0 && out.length < 200) out.push(x); });
    return out;
  }
  function prefs(p) {
    p = p && typeof p === "object" ? p : {};
    return {
      mode: MODES.indexOf(p.mode) >= 0 ? p.mode : "",
      group: typeof p.group === "boolean" ? p.group : true,
      show_hidden: typeof p.show_hidden === "boolean" ? p.show_hidden : true,
      pinned: strs(p.pinned), hidden: strs(p.hidden), shown: strs(p.shown)
    };
  }
  function mode(p, hasSavedOrder) { return MODES.indexOf(p.mode) >= 0 ? p.mode : (hasSavedOrder ? "manual" : "smart"); }

  function cmp(a, b) {
    for (var i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }
  function use(usage, pkg) { var u = (usage && usage[pkg]) || {}; return [Number(u.n) || 0, Number(u.t) || 0]; }

  // apps: [{package, name, ...}] -> {mode, headers, items} (the same app objects, plus category, group, hidden, pinned)
  function sort(apps, p, usage, manualOrder) {
    p = prefs(p);
    var m = mode(p, !!(manualOrder && manualOrder.length));
    var items = apps.map(function (a) {
      var cat = classify(a.package, a.name);
      // My order shows everything where the owner put it: pins and hides apply to the automatic modes
      var hidden = m !== "manual" && (p.hidden.indexOf(a.package) >= 0 || (cat === "hidden" && p.shown.indexOf(a.package) < 0));
      var it = {};
      for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) it[k] = a[k];
      it.category = cat; it.hidden = hidden; it.pinned = m !== "manual" && p.pinned.indexOf(a.package) >= 0;
      it._name = String(a.name || a.package).toLowerCase();
      return it;
    });
    var catI = function (it) { var i = CATS.indexOf(it.category); return i < 0 ? CATS.length : i; };
    var key;
    if (m === "manual") {
      var at = {};
      manualOrder.forEach(function (pk, i) { at[pk] = i; });
      key = function (it) { return [at[it.package] === undefined ? manualOrder.length : at[it.package], it._name]; };
    } else if (m === "used") key = function (it) { var u = use(usage, it.package); return [-u[0], -u[1], rank(it.package), it._name]; };
    else if (m === "recent") key = function (it) { var u = use(usage, it.package); return [-u[1], -u[0], rank(it.package), it._name]; };
    else if (m === "az" || m === "category") key = function (it) { return [it._name]; };
    else key = function (it) { return [-use(usage, it.package)[0], rank(it.package), it._name]; };
    var byGroup = m !== "manual" && (m === "smart" || m === "category" || p.group);
    items = items.map(function (it, i) { return { it: it, i: i }; });
    var withKey = items.map(function (x) { return { it: x.it, k: (byGroup ? [catI(x.it)] : []).concat(key(x.it)), i: x.i }; });
    withKey.sort(function (a, b) { return cmp(a.k, b.k) || a.i - b.i; });
    var pinAt = {};
    p.pinned.forEach(function (pk, i) { pinAt[pk] = i; });
    var rest = withKey.map(function (x, i) { return { it: x.it, i: i }; });
    rest.sort(function (a, b) {
      var ka = [a.it.hidden ? 1 : 0, a.it.pinned && !a.it.hidden ? 0 : 1, a.it.pinned ? pinAt[a.it.package] : 0];
      var kb = [b.it.hidden ? 1 : 0, b.it.pinned && !b.it.hidden ? 0 : 1, b.it.pinned ? pinAt[b.it.package] : 0];
      return cmp(ka, kb) || a.i - b.i;
    });
    var out = rest.map(function (x) {
      delete x.it._name;
      x.it.group = x.it.hidden ? "hidden" : x.it.category;
      return x.it;
    });
    return { mode: m, headers: p.group && m !== "manual", items: out };
  }

  root.Arrange = { MODES: MODES, LABELS: LABELS, classify: classify, rank: rank, prefs: prefs, mode: mode, sort: sort,
    label: function (id) { return CAT_LABEL[id] || id; }, categories: CATS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.Arrange;
})(typeof window !== "undefined" ? window : globalThis);
