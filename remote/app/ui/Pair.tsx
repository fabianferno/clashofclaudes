'use client';
import { useEffect, useState } from 'react';

interface Props {
  /** An iPhone or iPad. */
  ios: boolean;
  /** Opened from the Home Screen (or an installed app window). */
  standalone: boolean;
  /** Makes this phone's key and asks the Mac that shows `code`. The check number, or why not. */
  submit: (code: string, name: string) => Promise<{ check: string } | { error: string }>;
  /** Whether the Mac has confirmed. */
  paired: () => Promise<boolean>;
  onPaired: () => void;
  /** How often `paired` is asked (ms). */
  every?: number;
}

/** Pairing: the code from the Mac, then the same number on both screens until the owner confirms there. */
export function Pair({ ios, standalone, submit, paired, onPaired, every = 2500 }: Props) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(ios ? 'iPhone' : 'Phone');
  const [check, setCheck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!check) return;
    let live = true;
    const t = setInterval(() => {
      void paired().then((ok) => { if (ok && live) onPaired(); }, () => {});
    }, every);
    return () => { live = false; clearInterval(t); };
  }, [check, paired, onPaired, every]);

  // A key made in Safari stays in Safari: the Home Screen app, the only place an iPhone delivers
  // notifications, would not have it. So on an iPhone pairing happens there.
  if (ios && !standalone) {
    return (
      <section className="panel">
        <h1>First, put it on your Home Screen</h1>
        <p>An iPhone only sends notifications to a page that lives on the Home Screen.</p>
        <p>Tap Share, then <b>Add to Home Screen</b>. Open Village remote from there and pair it.</p>
      </section>
    );
  }

  if (check) {
    return (
      <section className="panel">
        <h1>Check your Mac</h1>
        <p>Settings shows a phone asking to pair. If it shows this number, press Confirm there.</p>
        <p className="check" aria-label="Check number">{check}</p>
        <button type="button" className="btn quiet" onClick={() => { setCheck(null); setCode(''); }}>Start again</button>
      </section>
    );
  }

  const digits = code.replace(/\D/g, '');
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await submit(digits, name.trim() || 'Phone');
      if ('error' in r) setError(r.error);
      else setCheck(r.check);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h1>Pair this phone with your village</h1>
      <p>On your Mac, open Settings, Team, Phone remote and press Pair a phone. Type the code it shows.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (digits.length === 6) void go(); }}>
        <label>
          Code from your Mac
          <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="code" />
        </label>
        <label>
          Name for this phone
          <input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn allow" disabled={busy || digits.length !== 6}>Pair this phone</button>
      </form>
      {error && <p className="card-error" role="alert">{error}</p>}
    </section>
  );
}
