// This phone's key, in the browser. The private key is made here, marked non-extractable, and
// never leaves IndexedDB; the Mac only ever gets the public half, when it is paired.
import { b64, keyId, lowS, requestBytes, signedBytes, type Signable } from './crypto';

const DB = 'village-remote';
const STORE = 'phone';

interface Saved {
  pair: CryptoKeyPair;
  /** Raw public key, base64url. */
  public: string;
  key: string;
  /** Whose village it asked to pair with; the Mac decides whether it is. */
  owner: string | null;
}

/**
 * The database, with its store. Version 2 only so that a database left without the store (a first
 * open that was interrupted) gets it on the next open.
 */
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Close the other tabs of this page and try again.'));
  });
}

async function get(): Promise<Saved | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE);
    const r = tx.objectStore(STORE).get('me');
    tx.oncomplete = () => { d.close(); resolve((r.result as Saved | undefined) ?? null); };
    tx.onerror = tx.onabort = () => { d.close(); reject(tx.error); };
  });
}

async function put(s: Saved | null): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    if (s) tx.objectStore(STORE).put(s, 'me');
    else tx.objectStore(STORE).delete('me');
    tx.oncomplete = () => { d.close(); resolve(); };
    tx.onerror = tx.onabort = () => { d.close(); reject(tx.error); };
  });
}

async function sign(pair: CryptoKeyPair, bytes: Uint8Array): Promise<string> {
  // The Mac takes only the low-s form; half of all signatures are, so this ends at once.
  for (;;) {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(bytes)));
    if (lowS(sig)) return b64(sig);
  }
}

export interface Phone {
  owner: string | null;
  key: string;
  public: string;
  signAction(a: Signable): Promise<string>;
  api(path: string, init?: { method?: string; body?: string }): Promise<Response>;
}

function phoneOf(s: Saved): Phone {
  return {
    owner: s.owner,
    key: s.key,
    public: s.public,
    signAction: async (a) => sign(s.pair, await signedBytes(a)),
    api: async (path, init = {}) => {
      const method = init.method ?? 'GET';
      const ts = Date.now();
      const body = init.body ?? '';
      const sig = await sign(s.pair, await requestBytes(method, path, ts, new TextEncoder().encode(body)));
      return fetch(path, {
        method,
        body: method === 'GET' ? undefined : body,
        cache: 'no-store',
        headers: { 'x-coc-owner': s.owner ?? '', 'x-coc-key': s.key, 'x-coc-ts': String(ts), 'x-coc-sig': sig, ...(body ? { 'content-type': 'application/json' } : {}) },
      });
    },
  };
}

/** This phone, if it has a key. */
export async function load(): Promise<Phone | null> {
  const s = await get();
  return s ? phoneOf(s) : null;
}

/** Makes this phone's key (once) and notes whose village it asked for. */
export async function make(owner: string | null): Promise<Phone> {
  let s = await get();
  if (!s) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    s = { pair, public: b64(pub), key: await keyId(pub), owner };
  }
  s = { ...s, owner };
  await put(s);
  return phoneOf(s);
}

/** Forgets this phone's key: it must be paired again. */
export const forget = () => put(null);
