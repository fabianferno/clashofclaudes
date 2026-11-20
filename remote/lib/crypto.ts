// What the phone, the remote's server and the Mac app must agree on, byte for byte: how an action
// and a request are signed, and how a key gets its short names. WebCrypto only, so the same file
// runs in the browser and in a Vercel Function. The Mac's side is `src-tauri/src/board/remote.rs`.

const enc = new TextEncoder();

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on anything that is not base64url. */
export function unb64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** A copy with a buffer of its own: what `crypto.subtle` wants. */
const own = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', own(bytes)));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await sha256(bytes));
}

export type Do = 'allow' | 'deny' | 'answer' | 'followup';

/** The part of an action its signature covers. */
export interface Signable {
  do: Do;
  pick?: number | null;
  text?: string | null;
  nonce: string;
  /** `sha256Hex` of the prompt block the phone showed, exactly as the Mac wrote it. */
  prompt: string;
}

/** What the phone signs for an action. */
export async function signedBytes(a: Signable): Promise<Uint8Array> {
  const lines = ['coc-act-1', a.do, a.pick == null ? '' : String(a.pick), await sha256Hex(enc.encode(a.text ?? '')), a.nonce, a.prompt];
  return enc.encode(lines.join('\n'));
}

/** What the phone signs for a request to the remote's API. `path` includes the query. */
export async function requestBytes(method: string, path: string, ts: number, body: Uint8Array): Promise<Uint8Array> {
  return enc.encode(['coc-req-1', method.toUpperCase(), path, String(ts), await sha256Hex(body)].join('\n'));
}

/** A short name for a raw public key: the start of its hash. */
export async function keyId(rawPublic: Uint8Array): Promise<string> {
  return (await sha256Hex(rawPublic)).slice(0, 16);
}

/** The six digits the phone and the Mac both show while pairing (`482 913`). */
export async function checkNumber(rawPublic: Uint8Array, ticketId: string): Promise<string> {
  const t = enc.encode(ticketId);
  const both = new Uint8Array(rawPublic.length + t.length);
  both.set(rawPublic);
  both.set(t, rawPublic.length);
  const d = await sha256(both);
  const n = (((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Whether `rawPublic` is a P-256 public key as a phone sends it: 65 bytes, uncompressed. */
export function isPublicKey(rawPublic: Uint8Array): boolean {
  return rawPublic.length === 65 && rawPublic[0] === 4;
}

// Half of P-256's group order. A signature whose `s` is above it is the twin (r, n-s) of one below:
// valid too, so the same action could be posted again as "another" signature. Refused everywhere.
const HALF_N = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;

export function lowS(sig: Uint8Array): boolean {
  return sig.length === 64 && BigInt('0x' + hex(sig.slice(32))) <= HALF_N;
}

/** Whether `sig` (base64url, r‖s) is `rawPublic`'s ECDSA P-256 / SHA-256 signature of `msg`. */
export async function verify(rawPublic: Uint8Array, msg: Uint8Array, sigB64url: string): Promise<boolean> {
  try {
    const sig = unb64(sigB64url);
    if (!isPublicKey(rawPublic) || !lowS(sig)) return false;
    const key = await crypto.subtle.importKey('raw', own(rawPublic), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, own(sig), own(msg));
  } catch {
    return false;
  }
}
