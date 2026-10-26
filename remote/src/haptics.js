// iPhone Safari has no vibrate API. Since iOS 18, toggling an <input type="checkbox" switch>
// through its label plays the system haptic tick, so we keep one hidden and click its label.
// Only works inside a user gesture (pointerup, click), which is where we call it.
let label;

function ensure() {
  if (label || typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.id = 'haptic-switch';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  label = document.createElement('label');
  label.htmlFor = 'haptic-switch';
  label.setAttribute('aria-hidden', 'true');
  for (const el of [input, label]) Object.assign(el.style, { position: 'fixed', left: '-9999px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  document.body.append(input, label);
}

export function tick() {
  if (navigator.vibrate) { navigator.vibrate(8); return; }
  ensure();
  label?.click();
}
