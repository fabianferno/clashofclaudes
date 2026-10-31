import { lazy, Suspense } from 'react';

// xterm and its WebGL addon load on first use instead of with the village; `preloadTerminal`
// fetches them in the background once the app is idle, so the first open is still instant.
const load = () => import('./TerminalView');
const TerminalView = lazy(load);

export function preloadTerminal(): void {
  void load();
}

export default function LazyTerminalView(props: { sessionId: string; readOnly?: boolean }) {
  return (
    <Suspense fallback={<div className="terminal" />}>
      <TerminalView {...props} />
    </Suspense>
  );
}
