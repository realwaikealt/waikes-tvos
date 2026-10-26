// Pull the TV menu down from the top, and push it back up, with the sheet following the finger.
// The sheet is moved straight on its element (no React render per frame), then let go with a spring.
// Zones that use these set `touch-action: pan-x`, so a sideways swipe still pages Remote and Watch.
import { useRef } from 'react';

const SLOP = 10; // points before a touch counts as a pull
const OPEN_AT = 0.28; // share of the sheet's height that opens it on release
const FLING = 0.45; // points per millisecond that open or close it whatever the distance

function follow(el, y, h) {
  el.style.transition = 'none';
  el.style.transform = `translateY(${Math.min(0, y - h)}px)`;
  const layer = el.parentElement;
  layer.classList.add('dragging');
  layer.querySelector('.scrim').style.opacity = String(Math.max(0, Math.min(1, y / h)));
}

function settle(el) {
  el.style.transition = '';
  el.style.transform = '';
  const layer = el.parentElement;
  layer.classList.remove('dragging');
  layer.querySelector('.scrim').style.opacity = '';
}

function useDrag(sheetRef, { sign, decide }) {
  const g = useRef(null);
  return {
    onPointerDown: (e) => { g.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, live: false, id: e.pointerId }; },
    onPointerMove: (e) => {
      const s = g.current; const el = sheetRef.current;
      if (!s || !el) return;
      const dx = e.clientX - s.x; const dy = (e.clientY - s.y) * sign;
      if (!s.live) {
        if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)) { g.current = null; return; }
        if (dy < SLOP) return;
        s.live = true; s.h = el.offsetHeight;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      s.dy = dy; s.v = dy / Math.max(1, e.timeStamp - s.t);
      follow(el, sign > 0 ? dy : s.h - dy, s.h);
    },
    onPointerUp: () => {
      const s = g.current; g.current = null;
      const el = sheetRef.current;
      if (!s?.live || !el) return;
      settle(el);
      decide(s.dy / s.h > OPEN_AT || s.v > FLING);
    },
    onPointerCancel: () => { const s = g.current; g.current = null; if (s?.live && sheetRef.current) settle(sheetRef.current); },
    onClickCapture: (e) => { if (g.current?.live) { e.stopPropagation(); e.preventDefault(); } },
  };
}

// Sideways drags that page between Remote and Watch from places the phone's own scrolling cannot
// reach (the dock with Ask and the tabs sits outside the pages). The direction is decided in the
// first SLOP points: sideways takes the finger and moves the pages, anything else is left alone,
// so taps still press buttons. mode 'content' moves like the page under the finger; mode 'thumb'
// (the Remote/Watch pill) moves like the iPhone home bar, the pages travel further than the finger.
export function usePageDrag(pagerRef, goTo, mode = 'content') {
  const g = useRef(null);
  const dragged = useRef(false);
  const settleTo = (el, to) => { el.style.scrollSnapType = ''; goTo(to); };
  return {
    onPointerDown: (e) => {
      if (!e.isPrimary || (mode === 'content' && e.target.closest?.('.tabs'))) return;
      const el = pagerRef.current; if (!el) return;
      const k = mode === 'thumb' ? el.clientWidth / Math.max(1, e.currentTarget.clientWidth / 2) : -1;
      g.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, start: el.scrollLeft, live: false, k, id: e.pointerId };
    },
    onPointerMove: (e) => {
      const d = g.current; const el = pagerRef.current;
      if (!d || !el || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x; const dy = e.clientY - d.y;
      if (!d.live) {
        if (Math.hypot(dx, dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) { g.current = null; return; }
        d.live = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        el.style.scrollSnapType = 'none';
      }
      d.v = dx / Math.max(1, e.timeStamp - d.t);
      el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, Math.max(0, d.start + dx * d.k));
    },
    onPointerUp: () => {
      const d = g.current; const el = pagerRef.current; g.current = null;
      if (!d?.live || !el) return;
      const p = el.scrollLeft / Math.max(1, el.clientWidth);
      const v = d.v * Math.sign(d.k);
      settleTo(el, Math.abs(v) > 0.3 ? (v > 0 ? 'watch' : 'remote') : (p > 0.5 ? 'watch' : 'remote'));
      // The click that follows a drag must not also press the button under the finger.
      dragged.current = true; setTimeout(() => { dragged.current = false; }, 0);
    },
    onPointerCancel: () => {
      const d = g.current; const el = pagerRef.current; g.current = null;
      if (d?.live && el) settleTo(el, el.scrollLeft / el.clientWidth > 0.5 ? 'watch' : 'remote');
    },
    onClickCapture: (e) => { if (dragged.current) { e.stopPropagation(); e.preventDefault(); } },
  };
}

export const usePullDown =(sheetRef, onOpen) => useDrag(sheetRef, { sign: 1, decide: (yes) => yes && onOpen() });
export const usePushUp = (sheetRef, onClose) => useDrag(sheetRef, { sign: -1, decide: (yes) => yes && onClose() });
