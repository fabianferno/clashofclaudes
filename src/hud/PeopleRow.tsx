import { useEffect, useState } from 'react';
import { ipc } from '../api/ipc';
import type { VisitView } from '../api/types';
import { useApp } from '../state/store';
import { LEVEL_WORDS, useMyLevel } from '../state/myLevel';

/**
 * A village is named by its owner's Vercel handle: the board verified it. What an owner calls
 * themselves in their own village is theirs to choose, so it never stands in for who they are.
 */
const called = (v: VisitView) => v.owner;

/**
 * The villages you were invited to, top left: Home, then a chip per village with how many
 * builders wait there. Visiting one swaps what the canvas draws; your own sessions keep running.
 */
export default function PeopleRow() {
  const visits = useApp((s) => s.visits);
  const visiting = useApp((s) => s.visiting);

  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    const take = (list: VisitView[]) => {
      if (!live) return;
      const st = useApp.getState();
      st.setVisits(list);
      const at = st.visiting;
      if (!at) return;
      const still = list.find((v) => v.owner === at.owner);
      if (!still) {
        // the invite was removed, or the village closed to us
        const name = st.visits.find((v) => v.owner === at.owner);
        st.setVisiting(null);
        st.setError(`You can no longer see ${name ? called(name) : at.owner}’s village.`);
        return;
      }
      // its map changed: draw the new one
      void ipc.visit(at.owner).then((map) => { if (live && map && useApp.getState().visiting?.owner === at.owner) useApp.getState().setVisiting({ owner: at.owner, map }); }, () => {});
    };
    ipc.visits().then((list) => { if (live) useApp.getState().setVisits(list); }, () => {});
    void ipc.onVisitsChanged(take).then((u) => (live ? (off = u) : u()));
    return () => { live = false; off?.(); };
  }, []);

  const go = (owner: string) => {
    void ipc.visit(owner).then(
      (map) => {
        if (!map) return;
        const st = useApp.getState();
        st.setSelection(null); // your own panel does not belong over someone else's village
        st.setVisiting({ owner, map });
      },
      (e) => useApp.getState().setError(String(e)),
    );
  };
  const here = visiting ? visits.find((v) => v.owner === visiting.owner) : undefined;
  const level = useMyLevel(visiting?.map);
  // asking this village's owner to pair this Mac, with the code they sent
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const owner = visiting?.owner;
  useEffect(() => { setAsking(false); setCode(''); setCheck(null); setPairError(null); }, [owner]);
  const pair = () => {
    if (!owner) return;
    setPairError(null);
    ipc.matePair(owner, code).then(setCheck, (e) => setPairError(String(e)));
  };
  const whose = visiting?.owner;

  // nothing to visit and not visiting: no row (after the hooks above, which must always run)
  if (visits.length === 0 && !visiting) return null;
  return (
    <>
      {visiting && <div className="visit-tint" aria-hidden="true" />}
      <nav className="people-row" aria-label="Villages">
        <button type="button" className="people-chip home" aria-pressed={!visiting} onClick={() => useApp.getState().setVisiting(null)}>Home</button>
        {visits.map((v) => (
          <button
            key={v.owner}
            type="button"
            className={`people-chip${v.away ? ' away' : ''}`}
            aria-pressed={visiting?.owner === v.owner}
            aria-label={`${called(v)}${v.waiting ? `, ${v.waiting} waiting` : ''}${v.away ? ', away' : ''}`}
            onClick={() => go(v.owner)}
          >
            {called(v)}
            {v.waiting > 0 && <span className="people-count">{v.waiting}</span>}
          </button>
        ))}
      </nav>
      {visiting && (
        <div className="visit-ribbon" role="status">
          <span>Visiting {whose}’s village · you are {LEVEL_WORDS[level]} here</span>
          {here?.away && <span className="visit-away">{whose}’s Mac may be asleep or offline.</span>}
          {level === 'visitor' && !asking && <button type="button" className="hud-btn grey sm" onClick={() => setAsking(true)}>Enter pairing code</button>}
          {level === 'visitor' && asking && (
            <form className="visit-pair" onSubmit={(e) => { e.preventDefault(); pair(); }}>
              <input type="text" aria-label={`Pairing code from ${whose}`} placeholder="XXXX-XXXX-XXXX" spellCheck={false} autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" className="hud-btn green sm" disabled={!code.trim()}>Pair this Mac</button>
              {check && <span className="visit-away">Tell {whose} this number: {check}. They confirm it in their Settings.</span>}
              {pairError && <span className="visit-away" role="alert">{pairError}</span>}
            </form>
          )}
        </div>
      )}
    </>
  );
}
