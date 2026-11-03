/* Asher's tvOS web-app helper: TV-style focus jumping, typing into fields, page width. Injected on every page. */
(function () {
  if (window.__tvos) return;
  var S = { cur: null, mode: 'focus', target: null, ring: null, cache: null, cacheAt: 0, timer: 0 };
  var SEM = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[tabindex]:not([tabindex="-1"]),[onclick],[contenteditable=true],[contenteditable=""]';
  var TEXTTYPES = { '': 1, text: 1, search: 1, email: 1, url: 1, tel: 1, password: 1, number: 1 };

  function isTextField(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'textarea') return true;
    if (t === 'input') return !!TEXTTYPES[(el.getAttribute('type') || '').toLowerCase()];
    return el.isContentEditable === true;
  }
  function R(el) { return el.getBoundingClientRect(); }

  function okEl(el, vw, vh) {
    var r = R(el);
    if (r.width < 10 || r.height < 10) return null;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return null;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || parseFloat(cs.opacity) === 0) return null;
    var px = Math.min(Math.max((Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, 1), vw - 1);
    var py = Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2, 1), vh - 1);
    var hit = document.elementFromPoint(px, py);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return null;
    return r;
  }

  function cands() {
    var now = Date.now();
    if (S.cache && now - S.cacheAt < 250) return S.cache;
    var vw = innerWidth, vh = innerHeight, out = [], seen = new Set();
    var sem = document.querySelectorAll(SEM);
    for (var i = 0; i < sem.length; i++) {
      var r = okEl(sem[i], vw, vh);
      if (r) { out.push({ el: sem[i], r: r }); seen.add(sem[i]); }
    }
    var all = document.body ? document.body.querySelectorAll('div,span,li,img,svg,p,h1,h2,h3,h4,figure,section,article,label') : [];
    var n = Math.min(all.length, 7000);
    for (var j = 0; j < n; j++) {
      var el = all[j];
      if (seen.has(el)) continue;
      var rr = el.getBoundingClientRect();
      if (rr.width < 14 || rr.height < 14 || rr.bottom <= 0 || rr.top >= vh || rr.right <= 0 || rr.left >= vw) continue;
      var mx = (rr.left + rr.right) / 2, my = (rr.top + rr.bottom) / 2, inside = false;
      for (var q = 0; q < out.length; q++) { var oq = out[q].r; if (mx >= oq.left && mx <= oq.right && my >= oq.top && my <= oq.bottom) { inside = true; break; } }
      if (inside) continue;       // already part of something we can select
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      var p = el.parentElement;
      if (p && getComputedStyle(p).cursor === 'pointer') continue; // keep the outermost clickable
      var r2 = okEl(el, vw, vh);
      if (r2) { out.push({ el: el, r: r2 }); seen.add(el); }
    }
    // a small control inside a big clickable card is part of the card: aim at the card
    var keep = [];
    for (var a = 0; a < out.length; a++) {
      var ra = out[a].r, area = ra.width * ra.height, inner = false;
      if (!isTextField(out[a].el)) {
        for (var b = 0; b < out.length; b++) {
          if (a !== b && out[b].el.contains(out[a].el) && out[b].r.width * out[b].r.height > area * 4) { inner = true; break; }
        }
      }
      if (!inner) keep.push(out[a]);
    }
    out = keep;
    S.cache = out; S.cacheAt = now;
    return out;
  }

  function ensureRing() {
    if (S.ring && S.ring.isConnected) return S.ring;
    var d = document.createElement('div');
    d.id = '__tvos_ring';
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:4px solid #fff;border-radius:16px;box-shadow:0 0 0 3px rgba(18,13,19,.72),0 12px 36px rgba(0,0,0,.55);left:0;top:0;width:0;height:0;display:none;transition:transform 180ms cubic-bezier(.22,1,.36,1),width 180ms cubic-bezier(.22,1,.36,1),height 180ms cubic-bezier(.22,1,.36,1);box-sizing:border-box';
    (document.documentElement || document.body).appendChild(d);
    S.ring = d;
    return d;
  }
  function draw() {
    var d = ensureRing();
    if (S.mode !== 'focus' || !S.cur || !S.cur.isConnected) { d.style.display = 'none'; return; }
    var r = R(S.cur);
    if (r.width < 2) { d.style.display = 'none'; return; }
    d.style.display = 'block';
    d.style.width = (r.width + 8) + 'px';
    d.style.height = (r.height + 8) + 'px';
    d.style.transform = 'translate(' + (r.left - 4) + 'px,' + (r.top - 4) + 'px)';
  }
  function startTimer() {
    if (S.timer) return;
    S.timer = setInterval(function () { if (S.mode === 'focus' && S.cur) draw(); }, 150);
  }

  function reveal(el) {
    var r = R(el), vh = innerHeight, vw = innerWidth, dy = 0;
    if (r.top < 60) dy = r.top - vh * 0.3;
    else if (r.bottom > vh - 60) dy = r.bottom - vh * 0.7;
    if (dy) { scrollBy(0, dy); S.cache = null; }
    if (r.left < 0 || r.right > vw) { var p = el.parentElement; while (p && p !== document.body) { if (p.scrollWidth > p.clientWidth + 4) { try { el.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} break; } p = p.parentElement; } }
  }
  function setCur(el) { S.cur = el; reveal(el); draw(); }

  function scoreFor(dir, cr, r) {
    var ccx = (cr.left + cr.right) / 2, ccy = (cr.top + cr.bottom) / 2;
    var rcx = (r.left + r.right) / 2, rcy = (r.top + r.bottom) / 2;
    var along, perp, overlap;
    if (dir === 'right') { along = r.left >= cr.right - 6 ? r.left - cr.right : (rcx - ccx > 10 ? (rcx - ccx) * 0.5 : -1); perp = Math.abs(rcy - ccy); overlap = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top) > 0; }
    else if (dir === 'left') { along = r.right <= cr.left + 6 ? cr.left - r.right : (ccx - rcx > 10 ? (ccx - rcx) * 0.5 : -1); perp = Math.abs(rcy - ccy); overlap = Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top) > 0; }
    else if (dir === 'down') { along = r.top >= cr.bottom - 6 ? r.top - cr.bottom : (rcy - ccy > 10 ? (rcy - ccy) * 0.5 : -1); perp = Math.abs(rcx - ccx); overlap = Math.min(cr.right, r.right) - Math.max(cr.left, r.left) > 0; }
    else { along = r.bottom <= cr.top + 6 ? cr.top - r.bottom : (ccy - rcy > 10 ? (ccy - rcy) * 0.5 : -1); perp = Math.abs(rcx - ccx); overlap = Math.min(cr.right, r.right) - Math.max(cr.left, r.left) > 0; }
    if (along < 0) return -1;
    return along + perp * (overlap ? 0.6 : 2.5);
  }

  function pickAfterScroll(dir, prevCx) {
    S.cache = null;
    var list = cands(), best = null, bs = 1e9;
    for (var i = 0; i < list.length; i++) {
      var r = list[i].r, cx = (r.left + r.right) / 2;
      var s = (dir === 'down' ? r.top : innerHeight - r.bottom) + Math.abs(cx - prevCx) * 0.8;
      if (s < bs) { bs = s; best = list[i].el; }
    }
    if (best) { S.cur = best; draw(); }
  }

  function scrollableAncestor(el, dir) {
    var p = el && el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      var cs = getComputedStyle(p);
      if ((dir === 'left' || dir === 'right') && /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 4) return p;
      p = p.parentElement;
    }
    return null;
  }

  var api = {
    mode: function (m) { S.mode = m; if (m === 'focus') { startTimer(); draw(); } else { ensureRing().style.display = 'none'; } return m; },
    nav: function (dir) {
      startTimer(); S.mode = 'focus';
      var list = cands();
      var cur = S.cur && S.cur.isConnected ? S.cur : null;
      var cr = null;
      if (cur) { var rr = R(cur); if (rr.width > 2 && rr.bottom > 0 && rr.top < innerHeight) cr = rr; }
      if (!cr) {
        var first = null, fs = 1e9;
        for (var i = 0; i < list.length; i++) { var s0 = list[i].r.top * 2 + list[i].r.left * 0.2 - (isTextField(list[i].el) ? 5000 : 0); if (s0 < fs) { fs = s0; first = list[i].el; } }
        if (!first) { return 'none'; }
        setCur(first); return 'moved';
      }
      var best = null, bs = 1e9;
      for (var k = 0; k < list.length; k++) {
        if (list[k].el === cur || cur.contains(list[k].el) || list[k].el.contains(cur)) continue;
        var s = scoreFor(dir, cr, list[k].r);
        if (s >= 0 && s < bs) { bs = s; best = list[k].el; }
      }
      if (best) { setCur(best); return 'moved'; }
      if (dir === 'left' || dir === 'right') {
        var sa = scrollableAncestor(cur, dir);
        if (sa) { var b = sa.scrollLeft; sa.scrollBy({ left: (dir === 'right' ? 1 : -1) * sa.clientWidth * 0.8 }); if (Math.abs(sa.scrollLeft - b) > 1 || true) { S.cache = null; setTimeout(function () { S.cache = null; draw(); }, 250); return 'scrolled'; } }
        return 'edge-' + dir;
      }
      var max = document.documentElement.scrollHeight - innerHeight, sy = scrollY;
      if ((dir === 'down' && sy < max - 2) || (dir === 'up' && sy > 2)) {
        var cx = (cr.left + cr.right) / 2;
        scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.7 });
        S.cache = null;
        setTimeout(function () { pickAfterScroll(dir === 'down' ? 'down' : 'up', cx); }, 260);
        return 'scrolled';
      }
      return 'edge-' + dir;
    },
    page: function (dir) { scrollBy({ top: (dir === 'down' ? 1 : -1) * innerHeight * 0.75 }); S.cache = null; return 'scrolled'; },
    inputInfo: function (el) {
      if (!el) return null;
      var v = el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea' ? el.value : (el.textContent || '');
      var label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('title') || 'Type here';
      return { kind: 'input', value: v || '', label: label, type: (el.getAttribute('type') || el.tagName).toLowerCase() };
    },
    pending: function () {
      var a = document.activeElement;
      if (isTextField(a)) { S.target = a; return JSON.stringify(api.inputInfo(a)); }
      if (isTextField(S.cur)) { S.target = S.cur; return JSON.stringify(api.inputInfo(S.cur)); }
      return '';
    },
    tap: function (el) {
      var r = R(el), x = r.left + r.width / 2, y = r.top + r.height / 2;
      var o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      var tgt = document.elementFromPoint(Math.min(Math.max(x, 1), innerWidth - 1), Math.min(Math.max(y, 1), innerHeight - 1)) || el;
      if (!(el === tgt || el.contains(tgt))) tgt = el;
      try { tgt.dispatchEvent(new PointerEvent('pointerover', o)); tgt.dispatchEvent(new MouseEvent('mouseover', o)); } catch (e) {}
      try { tgt.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
      tgt.dispatchEvent(new MouseEvent('mousedown', o));
      try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) {}
      var o2 = Object.assign({}, o, { buttons: 0 });
      try { tgt.dispatchEvent(new PointerEvent('pointerup', o2)); } catch (e) {}
      tgt.dispatchEvent(new MouseEvent('mouseup', o2));
      tgt.dispatchEvent(new MouseEvent('click', o2));
    },
    click: function () {
      var el = S.cur;
      if (!el || !el.isConnected) return JSON.stringify({ kind: 'none' });
      if (isTextField(el)) { S.target = el; try { el.focus({ preventScroll: true }); } catch (e) {} return JSON.stringify(api.inputInfo(el)); }
      var tag = el.tagName.toLowerCase();
      if (tag === 'select') { try { el.focus(); } catch (e) {} return JSON.stringify({ kind: 'select' }); }
      api.tap(el);
      S.cache = null;
      return JSON.stringify({ kind: 'clicked' });
    },
    setText: function (text, submit) {
      var el = S.target && S.target.isConnected ? S.target : (isTextField(document.activeElement) ? document.activeElement : null);
      if (!el) return 'no-field';
      try { el.focus({ preventScroll: true }); } catch (e) {}
      var tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        var proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        try { el.setSelectionRange(text.length, text.length); } catch (e) {}
      } else { el.textContent = text; }
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })); }
      catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
      if (submit) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        var ko = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        var down = new KeyboardEvent('keydown', ko);
        var notHandled = el.dispatchEvent(down);
        el.dispatchEvent(new KeyboardEvent('keypress', ko));
        el.dispatchEvent(new KeyboardEvent('keyup', ko));
        if (notHandled && el.form) { try { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); } catch (e) {} }
        try { el.blur(); } catch (e) {}
      }
      return 'ok';
    },
    viewport: function (w) {
      var m = document.querySelector('meta[name=viewport]');
      if (!m) { m = document.createElement('meta'); m.name = 'viewport'; (document.head || document.documentElement).appendChild(m); }
      m.setAttribute('content', 'width=' + w + ', initial-scale=' + (1920 / (w * 2)).toFixed(3) + ', user-scalable=yes');
      S.cache = null;
      return w;
    },
    lite: function (on) {
      var st = document.getElementById('__tvos_lite');
      if (!on) { if (st) st.remove(); return 'off'; }
      if (!st) { st = document.createElement('style'); st.id = '__tvos_lite'; (document.head || document.documentElement).appendChild(st); }
      st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;scroll-behavior:auto!important;will-change:auto!important}';
      return 'on';
    },
    info: function () { return JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, y: scrollY, url: location.href }); }
  };
  window.__tvos = api;
  document.addEventListener('scroll', function () { S.cache = null; }, true);
  document.addEventListener('DOMContentLoaded', startTimer);
})();
