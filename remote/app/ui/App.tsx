'use client';
import { useCallback, useEffect, useState } from 'react';
import { forget, load, make, type Phone } from '../../lib/phone';
import { Pair } from './Pair';
import { Queue, type QueueData } from './Queue';
import type { PhoneApi } from './phone-api';

type Stage = { at: 'loading' } | { at: 'pair' } | { at: 'queue'; phone: Phone } | { at: 'unsupported' };

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (navigator as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;

/** Asks for notifications and tells the remote where to send them. Quietly does nothing where it cannot. */
async function subscribe(phone: Phone): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'This browser has no notifications.';
  const { push } = (await (await fetch('/api/version', { cache: 'no-store' })).json()) as { push?: string };
  if (!push) return 'The remote was deployed without notification keys.';
  if ((await Notification.requestPermission()) !== 'granted') return 'Notifications are off for this page.';
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: push }));
  const res = await phone.api('/api/push', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
  return res.ok ? null : 'The remote could not keep this phone’s notification address.';
}

export function App() {
  const [stage, setStage] = useState<Stage>({ at: 'loading' });
  const [notes, setNotes] = useState<'unknown' | 'on' | 'off'>('unknown');
  const [noteError, setNoteError] = useState<string | null>(null);

  const enter = useCallback(async () => {
    const phone = await load();
    if (!phone?.owner) return setStage({ at: 'pair' });
    const res = await phone.api('/api/queue');
    setStage(res.ok ? { at: 'queue', phone } : { at: 'pair' });
  }, []);

  useEffect(() => {
    if (!window.isSecureContext || !crypto?.subtle || !('indexedDB' in window)) return setStage({ at: 'unsupported' });
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
    setNotes('Notification' in window && Notification.permission === 'granted' ? 'on' : 'off');
    void enter().catch(() => setStage({ at: 'pair' }));
  }, [enter]);

  const submit = useCallback(async (code: string, name: string) => {
    const phone = await make(null);
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, public: phone.public, name }) });
    const body = (await res.json().catch(() => null)) as { owner?: string; check?: string; error?: string } | null;
    if (!res.ok || !body?.owner || !body.check) return { error: body?.error ?? `The remote answered ${res.status}` };
    await make(body.owner);
    return { check: body.check };
  }, []);

  const paired = useCallback(async () => {
    const phone = await load();
    return !!phone?.owner && (await phone.api('/api/queue')).ok;
  }, []);

  const loadQueue = useCallback(async (): Promise<QueueData> => {
    if (stage.at !== 'queue') throw new Error('not paired');
    const res = await stage.phone.api('/api/queue');
    if (res.status === 401) {
      setStage({ at: 'pair' });
      throw new Error('This phone is no longer paired.');
    }
    if (!res.ok) throw new Error(`The remote answered ${res.status}`);
    return (await res.json()) as QueueData;
  }, [stage]);

  return (
    <main>
      <header className="top">
        <span className="brand">Village remote</span>
        {stage.at === 'queue' && <span className="whose">{stage.phone.owner}’s village</span>}
      </header>
      {stage.at === 'loading' && <p className="note" role="status">Opening…</p>}
      {stage.at === 'unsupported' && <p className="banner">This browser cannot keep a key for this phone. Open the page over https in Safari or Chrome.</p>}
      {stage.at === 'pair' && <Pair ios={isIos()} standalone={isStandalone()} submit={submit} paired={paired} onPaired={() => void enter()} />}
      {stage.at === 'queue' && (
        <>
          {notes === 'off' && (
            <p className="banner ask">
              Get a notification when a builder waits.{' '}
              <button
                type="button"
                className="btn quiet"
                onClick={() => void subscribe(stage.phone).then((e) => { setNoteError(e); if (!e) setNotes('on'); }, (e) => setNoteError(String(e)))}
              >
                Turn on notifications
              </button>
              {noteError && <span role="alert"> {noteError}</span>}
            </p>
          )}
          <Queue phone={stage.phone as PhoneApi} load={loadQueue} />
          <footer className="foot">
            <button type="button" className="btn quiet" onClick={() => { if (confirm('Unpair this phone? Remove it in the Mac’s Settings too.')) void forget().then(() => setStage({ at: 'pair' })); }}>
              Unpair this phone
            </button>
          </footer>
        </>
      )}
    </main>
  );
}
