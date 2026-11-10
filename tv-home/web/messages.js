/* TV messages. The PC (tools/tvnotify.py -> bridge /api/notify) leaves short plain-language notes; unread ones show here
   as a popup that needs OK. Also the Settings > Messages list. Self-contained: the Settings row only calls
   window.TVOS_MSG.openList(). Keys are taken in the capture phase while a message is open, so nothing behind it moves. */
(function () {
  "use strict";
  var Q = location.search;
  if (/[?&]mock\b/.test(Q)) return;
  var PREVIEW = /[?&]preview\b/.test(Q);
  var API = decodeURIComponent((Q.match(/[?&]api=([^&]+)/) || [])[1] || "");
  var TVID = (Q.match(/[?&]tv=([a-z-]+)/) || [])[1] || "";
  if (!API && location.protocol === "file:") return;

  var all = [], unread = 0;
  var cur = null;            // the message on screen, or null
  var view = "none";         // "none" | "msg" | "list"
  var queue = [];            // unread ids still to show after this one (newest first)
  var snooze = 0;            // "Later": no popups until this time
  var returnToList = false;  // a message opened from the list goes back to it
  var btnI = 0, btns = [];
  var quiet = 0, lastKey = 0, lastFetch = 0, showT = null, listI = 0;
  var els = {};

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function xhr(method, path, body) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, API + path + (TVID && method === "GET" ? (path.indexOf("?") < 0 ? "?" : "&") + "tv=" + TVID : ""));
      x.timeout = 6000;
      x.setRequestHeader("Content-Type", "application/json");
      x.onload = function () {
        var j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status >= 200 && x.status < 300 && j) resolve(j); else reject(new Error("bridge " + x.status));
      };
      x.onerror = x.ontimeout = function () { reject(new Error("no bridge")); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  // ---------- drawing ----------
  var ICON = {
    done: '<path d="M7 18.5l7 7 14-15" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
    info: '<path d="M18 16v10M18 9.5v.5" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
    warn: '<path d="M18 8v12M18 26v.5" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>'
  };
  ICON.error = ICON.warn;
  function when(m) {
    var d = new Date(m.time || (m.ts || 0) * 1000);
    if (isNaN(d)) return "";
    var days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var mons = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    var h = d.getHours(), mi = d.getMinutes();
    return days[d.getDay()] + ", " + mons[d.getMonth()] + " " + d.getDate() + " · " + (h % 12 || 12) + ":" + (mi < 10 ? "0" : "") + mi + (h < 12 ? " am" : " pm");
  }
  function short(m) {
    var d = new Date(m.time || (m.ts || 0) * 1000);
    if (isNaN(d)) return "";
    var h = d.getHours(), mi = d.getMinutes();
    return (d.getMonth() + 1) + "/" + d.getDate() + "  " + (h % 12 || 12) + ":" + (mi < 10 ? "0" : "") + mi + (h < 12 ? "am" : "pm");
  }

  function build() {
    if (els.msg || !document.body) return;
    var a = document.createElement("div");
    a.className = "msg-ov"; a.id = "msg"; a.setAttribute("role", "alertdialog"); a.setAttribute("aria-label", "Message");
    a.innerHTML = '<div class="msg-panel"><div class="msg-head"><div class="msg-ico" id="msg-ico"></div><div class="msg-ht"><h2 id="msg-title"></h2><div class="msg-when" id="msg-when"></div></div></div>' +
      '<div class="msg-body" id="msg-body"></div><div class="msg-foot" id="msg-foot"></div><p class="msg-hint" id="msg-hint"></p></div>';
    var b = document.createElement("div");
    b.className = "msg-ov"; b.id = "msglist"; b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Messages");
    b.innerHTML = '<div class="msg-panel"><div class="msg-head"><div class="msg-ht"><h2>Messages</h2><div class="msg-when" id="ml-sub"></div></div></div>' +
      '<div class="msg-list" id="ml-list"></div><p class="msg-hint">Up and down to choose. OK to read it again. Back to close.</p></div>';
    document.body.appendChild(a); document.body.appendChild(b);
    els.msg = a; els.list = b;
  }

  function paintButtons() {
    Array.prototype.forEach.call($("msg-foot").children, function (el, i) { if (el.classList.contains("msg-btn")) el.classList.toggle("focus", i === btnI); });
  }
  function paintMsg() {
    var m = cur;
    $("msg-ico").className = "msg-ico " + m.level;
    $("msg-ico").innerHTML = '<svg viewBox="0 0 36 36" aria-hidden="true">' + (ICON[m.level] || ICON.done) + "</svg>";
    $("msg-title").textContent = m.title;
    $("msg-when").textContent = when(m);
    var body = esc(m.summary);
    if (m.items && m.items.length) body += "<ul>" + m.items.map(function (i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul>";
    $("msg-body").innerHTML = body;
    $("msg-body").scrollTop = 0;
    var more = queue.length, foot = '<div class="msg-btn">OK</div>';
    btns = ["ok"];
    if (!m.read && !returnToList) { foot += '<div class="msg-btn">Later</div>'; btns.push("later"); }
    if (more) foot += '<div class="msg-more">' + more + " more waiting</div>";
    $("msg-foot").innerHTML = foot;
    $("msg-hint").textContent = "OK to close it. Up and down to scroll if it is long.";
    btnI = 0; paintButtons();
  }

  function openMsg(m, fromList) {
    build();
    cur = m; returnToList = !!fromList;
    view = "msg";
    paintMsg();
    els.list.classList.remove("on");
    els.msg.classList.add("on");
  }
  function closeMsg() { els.msg.classList.remove("on"); cur = null; view = "none"; }

  function done() {   // OK: it is read
    var m = cur;
    if (!m) return;
    if (!m.read) {
      m.read = true; unread = Math.max(0, unread - 1);
      if (!PREVIEW) xhr("POST", "/api/inbox/ack", { id: m.id }).catch(function () {});
    }
    var back = returnToList;
    closeMsg();
    if (back) { openList(true); return; }
    var next = nextUnread();
    if (next) setTimeout(function () { if (view === "none") openMsg(next, false); }, 350);   // let this one finish leaving
  }
  function later() {
    snooze = Date.now() + 30 * 60 * 1000;
    closeMsg();
  }
  function nextUnread() {
    var u = all.filter(function (m) { return !m.read; });
    queue = u.slice(1).map(function (m) { return m.id; });
    return u[0] || null;
  }

  function maybeShow() {
    if (view !== "none" || Date.now() < snooze) return;
    if (window.TVOS_FEAT && !TVOS_FEAT.on("messages")) return;   // Settings > Features
    var boot = document.getElementById("boot");
    if (boot && boot.parentNode && !boot.classList.contains("out")) { clearTimeout(showT); showT = setTimeout(maybeShow, 1500); return; }   // the boot screen is still up
    if (document.hidden) return;
    var m = nextUnread();
    if (!m) return;
    if (Date.now() - lastKey < 1500) { clearTimeout(showT); showT = setTimeout(maybeShow, 1600); return; }   // never in the middle of a key press
    openMsg(m, false);
  }

  // ---------- the list ----------
  function paintList() {
    var rows = all, box = $("ml-list");
    $("ml-sub").textContent = unread ? unread + " unread" : "Everything is read";
    if (!rows.length) { box.innerHTML = '<div class="msg-empty">No messages yet. When Claude finishes work for you, a note shows up here.</div>'; return; }
    listI = Math.max(0, Math.min(rows.length - 1 + (unread ? 1 : 0), listI));
    var html = rows.map(function (m, i) {
      return '<div class="msg-row' + (m.read ? "" : " unread") + (i === listI ? " focus" : "") + '"><span class="md"></span><span class="mt">' + esc(m.title) + '</span><span class="mw">' + esc(short(m)) + "</span></div>";
    }).join("");
    if (unread) html += '<div class="msg-row' + (listI === rows.length ? " focus" : "") + '"><span class="md"></span><span class="mt">Mark all as read</span><span class="mw"></span></div>';
    box.innerHTML = html;
    var f = box.querySelector(".focus");
    if (f && f.scrollIntoView) f.scrollIntoView({ block: "nearest" });
  }
  function openList(keepPos) {
    build();
    if (!keepPos) listI = 0;
    view = "list";
    paintList();
    els.list.classList.add("on");
    if (!keepPos) fetchInbox();
  }
  function closeList() { els.list.classList.remove("on"); view = "none"; setTimeout(maybeShow, 500); }

  // ---------- keys ----------
  function isOk(e) { return e.key === "Enter" || e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 32 || e.key === " "; }
  function isBack(e) { return e.key === "Escape" || e.key === "Backspace" || e.key === "GoBack" || e.keyCode === 27 || e.keyCode === 8 || e.keyCode === 4; }
  function dir(e) {
    var k = e.key, c = e.keyCode;
    if (k === "ArrowUp" || c === 19) return "up";
    if (k === "ArrowDown" || c === 20) return "down";
    if (k === "ArrowLeft" || c === 21) return "left";
    if (k === "ArrowRight" || c === 22) return "right";
    return "";
  }
  window.addEventListener("keydown", function (e) {
    lastKey = Date.now();
    if (view === "none") return;
    quiet = Date.now() + 600;   // the rest of this press (key up, click) belongs to the message, not the screen behind
    e.stopImmediatePropagation(); e.preventDefault();
    if (e.repeat && isOk(e)) return;
    var d = dir(e);
    if (view === "msg") {
      if (isOk(e)) { if (btns[btnI] === "later") later(); else done(); }
      else if (isBack(e)) done();
      else if (d === "left" || d === "right") { btnI = Math.max(0, Math.min(btns.length - 1, btnI + (d === "right" ? 1 : -1))); paintButtons(); }
      else if (d === "up" || d === "down") { var b = $("msg-body"); b.scrollTop += (d === "down" ? 1 : -1) * Math.round(b.clientHeight * 0.7); }
    } else if (view === "list") {
      var n = all.length + (unread ? 1 : 0);
      if (isBack(e)) closeList();
      else if (d === "up" || d === "down") { listI = Math.max(0, Math.min(n - 1, listI + (d === "down" ? 1 : -1))); paintList(); }
      else if (isOk(e)) {
        if (listI < all.length) { queue = []; openMsg(all[listI], true); }
        else if (unread) {
          all.forEach(function (m) { m.read = true; }); unread = 0;
          if (!PREVIEW) xhr("POST", "/api/inbox/ack", { id: "all" }).catch(function () {});
          listI = 0; paintList();
        }
      }
    }
  }, true);
  ["keyup", "keypress", "click"].forEach(function (t) {
    window.addEventListener(t, function (e) {
      // the key that closed a message must not also act on the screen behind it
      if (view !== "none" || Date.now() < quiet) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
  });

  // ---------- data ----------
  function fetchInbox() {
    lastFetch = Date.now();
    return xhr("GET", "/api/inbox").then(function (j) {
      all = j.messages || []; unread = j.unread || 0;
      if (view === "list") paintList();
      maybeShow();
    }, function () {});
  }
  function start() {
    fetchInbox();
    try {
      var es = new EventSource(API + "/api/events");
      es.addEventListener("inbox", function () { fetchInbox(); });
    } catch (e) {}
    setInterval(function () { if (!document.hidden && Date.now() - lastFetch > 45000) fetchInbox(); }, 15000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) fetchInbox(); });
    window.addEventListener("focus", function () { if (Date.now() - lastFetch > 5000) fetchInbox(); });
    window.addEventListener("pageshow", function () { fetchInbox(); });
  }

  window.TVOS_MSG = {
    openList: function () { openList(false); },
    unread: function () { return unread; }
  };
  function go() { build(); setTimeout(start, 1500); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
})();
