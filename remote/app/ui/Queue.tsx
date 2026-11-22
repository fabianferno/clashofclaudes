'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Card as CardData, Working } from '../../lib/types';
import { Card, WorkingRow } from './Card';
import type { PhoneApi } from './phone-api';

export interface QueueData {
  cards: CardData[];
  working: Working[];
  /** When the Mac last said it was there (ms); null when it never did. */
  seen: number | null;
  /** The server's clock, to compare `seen` with. */
  now: number;
}

/** After this long without a word from the Mac, the phone says so. */
const AWAY_MS = 12 * 60_000;

/** The owner's queue. `every`: how often it is read again (ms); 0 reads it once. */
export function Queue({ phone, load, every = 4000 }: { phone: PhoneApi; load: () => Promise<QueueData>; every?: number }) {
  const [data, setData] = useState<QueueData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    load().then(
      (d) => { setData(d); setError(null); },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [load]);

  useEffect(() => {
    refresh();
    if (!every) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, every);
    const wake = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', wake); };
  }, [refresh, every]);

  if (!data) return <p className="note" role="status">{error ?? 'Reading your village…'}</p>;
  const away = data.seen !== null && data.now - data.seen > AWAY_MS;
  return (
    <>
      {error && <p className="banner" role="alert">{error}</p>}
      {data.seen === null && <p className="banner">Your Mac has not been heard from yet. Check that Phone remote is on in Settings, under Team.</p>}
      {away && <p className="banner">Your Mac may be asleep or offline. What you send waits for it.</p>}
      {data.cards.length === 0 && <p className="note">Nobody is waiting on you.</p>}
      {data.cards.map((c) => <Card key={`${c.root}-${c.promptSha}`} card={c} phone={phone} onSent={refresh} />)}
      {data.working.length > 0 && (
        <section className="working" aria-label="At work">
          <h2>At work</h2>
          <ul>
            {data.working.map((w) => <WorkingRow key={w.root} w={w} phone={phone} onSent={refresh} />)}
          </ul>
        </section>
      )}
    </>
  );
}
