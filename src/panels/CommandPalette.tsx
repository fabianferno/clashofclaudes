import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { IS_MAC, currentWorkspace, keyLabel, matchCommands, paletteCommands, shortcutOf, type Command } from './commands';
import { StateTag } from './tags';

/** ⌘K (Ctrl+K off a Mac), from anywhere, even inside a terminal. */
export const isPaletteKey = (e: KeyboardEvent) =>
  (e.metaKey || (!IS_MAC && e.ctrlKey)) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';

const fail = (e: unknown) => useApp.getState().setError(String(e));

/** Runs a command (the palette closed first); one that asks something opens the palette on its question. */
export function runCommand(c: Command): void {
  const st = useApp.getState();
  if (c.ask) { st.setPaletteOpen(true, { ask: c.id }); return; }
  st.setPaletteOpen(false);
  try { void Promise.resolve(c.run?.()).catch(fail); } catch (e) { fail(e); }
}

/** A shortcut pressed: its command for the current workspace, or the palette to pick one. */
function runShortcut(e: KeyboardEvent): boolean {
  const s = shortcutOf(e);
  const st = useApp.getState();
  if (!s || st.bugReport) return false;
  const id = s.command(st, currentWorkspace(st));
  const c = id ? paletteCommands(st).find((x) => x.id === id) : undefined;
  if (c) runCommand(c);
  else if (s.otherwise) st.setPaletteOpen(true, { query: s.otherwise });
  else return false; // e.g. ⌘J with nobody waiting: nothing to do, the key goes on
  return true;
}

/**
 * The command palette: jump to a session, workspace or builder, or run an action, by typing.
 * ↑↓ move, Enter runs, Esc closes (or leaves a question it asked).
 */
export default function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);

  // Registered once, at startup, so it runs before the Escape handlers pages add when they open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState();
      if (isPaletteKey(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        st.setPaletteOpen(!st.paletteOpen);
      } else if (runShortcut(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      } else if (e.key === 'Escape' && st.paletteOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.dispatchEvent(new Event('coc-palette-escape'));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return open ? <Palette /> : null;
}

function Palette() {
  const sessions = useApp((s) => s.sessions);
  const workspaces = useApp((s) => s.workspaces);
  const builders = useApp((s) => s.builders);
  const quotas = useApp((s) => s.quotas);
  const agents = useApp((s) => s.agents);
  const selection = useApp((s) => s.selection);
  const kanban = useApp((s) => s.kanban);
  const seed = useApp((s) => s.paletteSeed);
  const [query, setQuery] = useState(seed?.query ?? '');
  const [active, setActive] = useState(0);
  const [asking, setAsking] = useState<Command | null>(null);
  const [answer, setAnswer] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const before = useRef<Element | null>(document.activeElement);

  const all = useMemo(
    () => paletteCommands({ sessions, workspaces, builders, quotas, agents, selection, kanban }),
    [sessions, workspaces, builders, quotas, agents, selection, kanban],
  );
  // a seed (a shortcut that needs a question answered or a workspace picked) takes effect once
  useEffect(() => {
    if (seed?.ask) setAsking(all.find((c) => c.id === seed.ask) ?? null);
    if (seed?.query) input.current?.setSelectionRange(seed.query.length, seed.query.length);
  }, [seed]); // once per seed; `all` changes with every session update
  const shown = useMemo(() => matchCommands(all, query), [all, query]);
  const at = Math.min(active, Math.max(0, shown.length - 1));

  const close = (refocus = true) => {
    useApp.getState().setPaletteOpen(false);
    // back to where the owner was typing (a terminal, say), unless a command moved them
    const el = before.current;
    if (refocus && el instanceof HTMLElement && el.isConnected) el.focus();
  };

  useEffect(() => {
    const onEscape = () => {
      if (asking) { setAsking(null); setAnswer(''); input.current?.focus(); } else close();
    };
    window.addEventListener('coc-palette-escape', onEscape);
    return () => window.removeEventListener('coc-palette-escape', onEscape);
  });

  useEffect(() => { input.current?.focus(); }, [asking]);
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (typeof el?.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [at, shown]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    if (c.ask) { setAsking(c); setAnswer(''); return; }
    runCommand(c);
  };
  const submit = () => {
    const text = answer.trim();
    if (!asking?.ask || !text) return;
    const ask = asking.ask;
    close(false);
    try { void Promise.resolve(ask.submit(text)).catch(fail); } catch (e) { fail(e); }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setActive((at + 1) % Math.max(1, shown.length)); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setActive((at - 1 + shown.length) % Math.max(1, shown.length)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[at]); }
  };

  let lastGroup = '';
  return (
    <div className="cmdk-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        {asking?.ask ? (
          <form className="cmdk-field" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <span className="cmdk-step">{asking.label.replace(/…$/, '')}</span>
            <input ref={input} aria-label={asking.ask.placeholder} placeholder={asking.ask.placeholder} value={answer}
              spellCheck={false} onChange={(e) => setAnswer(e.target.value)} />
          </form>
        ) : (
          <div className="cmdk-field">
            <input ref={input} role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-label="Search commands"
              aria-activedescendant={shown[at] ? `cmdk-${shown[at].id}` : undefined}
              placeholder="Jump to a session, workspace or builder, or run a command…" value={query} spellCheck={false}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
          </div>
        )}
        {asking ? (
          <div className="cmdk-foot"><span>Enter to create</span><span>Esc to go back</span></div>
        ) : (
          <>
            <div className="cmdk-list" id="cmdk-list" role="listbox" ref={list}>
              {shown.length === 0 && <div className="cmdk-empty">Nothing matches “{query.trim()}”.</div>}
              {shown.map((c, i) => {
                const head = !query.trim() && c.group !== lastGroup ? c.group : null;
                lastGroup = c.group;
                return (
                  <div key={c.id}>
                    {head && <div className="cmdk-group">{head}</div>}
                    <div id={`cmdk-${c.id}`} role="option" aria-selected={i === at} className="cmdk-item"
                      onMouseMove={() => { if (i !== at) setActive(i); }} onClick={() => run(c)}>
                      <span className="cmdk-text">
                        <span className="cmdk-label">{c.label}</span>
                        {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                      </span>
                      {c.session && c.session.kind.kind === 'agent' && <StateTag state={c.session.state} paused={c.session.paused} />}
                      {c.shortcut && <kbd className="cmdk-kbd">{c.shortcut}</kbd>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="cmdk-foot"><span>↑↓ to move · Enter to open</span><span>{keyLabel({ key: 'k' })} or Esc to close</span></div>
          </>
        )}
      </div>
    </div>
  );
}
