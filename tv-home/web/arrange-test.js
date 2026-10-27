// Run: node tv-home/web/arrange-test.js
// Checks the TV home's sorting (arrange.js) against what bridge/test_arrange.py says the bridge produces
// for the same apps and settings (bridge/fixtures/arrange-expected.json; run that script first).
var fs = require("fs"), path = require("path"), vm = require("vm");
var web = __dirname, fix = path.join(web, "..", "..", "bridge", "fixtures", "arrange-expected.json");
var ctx = { module: undefined }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(web, "arrange-rules.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(web, "arrange.js"), "utf8"), ctx);
var A = ctx.Arrange, exp = JSON.parse(fs.readFileSync(fix, "utf8")), bad = 0;
exp.cases.forEach(function (c, n) {
  var r = A.sort(exp.apps, c.prefs, c.usage), got = r.items.map(function (it) { return [it.package, it.group, it.hidden]; });
  var same = JSON.stringify(got) === JSON.stringify(c.order) && r.headers === c.headers;
  console.log((same ? "ok   " : "FAIL ") + "case " + n + " (" + c.prefs.mode + ")");
  if (!same) {
    bad++;
    for (var i = 0; i < Math.max(got.length, c.order.length); i++)
      if (JSON.stringify(got[i]) !== JSON.stringify(c.order[i])) { console.log("  first difference at " + i + ": js " + JSON.stringify(got[i]) + " py " + JSON.stringify(c.order[i])); break; }
  }
});
process.exit(bad ? 1 : 0);
