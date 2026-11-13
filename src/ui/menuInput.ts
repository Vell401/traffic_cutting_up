/** Native controls (including nested labels/icons) own their Enter/Space activation. */
export function isMenuControl(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined') return false;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return !!element?.closest('button, input, select, textarea, summary, details, [contenteditable]:not([contenteditable="false"])');
}
