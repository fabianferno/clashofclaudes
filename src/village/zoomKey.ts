/** Cmd (Ctrl elsewhere) with + / = zooms in, with - zooms out, with 0 fits the village; else null. */
export function zoomKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): 'in' | 'out' | 'fit' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  switch (e.key) {
    case '=': case '+': return 'in';
    case '-': case '_': return 'out';
    case '0': return 'fit';
    default: return null;
  }
}
