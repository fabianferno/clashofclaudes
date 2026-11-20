// Who is asking. The production address of a Vercel project is public, so every request that
// reads or writes a village carries a signature from a phone paired with it.
import { requestBytes, verify } from './crypto';
import { isOwner, type Records } from './records';

/** How far a request's clock may be from the server's. */
export const WINDOW_MS = 120_000;

export interface Asked {
  method: string;
  /** Path and query, as signed. */
  path: string;
  headers: Headers;
  body: Uint8Array;
}

export interface Caller {
  owner: string;
  key: string;
  /** The phone's record on the board. */
  record: string;
}

/** The paired phone that signed the request, or null. */
export async function signedBy(req: Asked, records: Records, now: () => number = Date.now): Promise<Caller | null> {
  const owner = req.headers.get('x-coc-owner');
  const key = req.headers.get('x-coc-key');
  const ts = Number(req.headers.get('x-coc-ts'));
  const sig = req.headers.get('x-coc-sig');
  if (!isOwner(owner) || !key || !/^[0-9a-f]{16}$/.test(key) || !sig || !Number.isSafeInteger(ts)) return null;
  if (Math.abs(now() - ts) > WINDOW_MS) return null;
  // an owner with no village on this board is not read about: a stranger's guesses cost nothing
  if (!(await records.hasVillage(owner))) return null;
  const phone = await records.phone(owner, key);
  if (!phone) return null;
  const ok = await verify(phone.public, await requestBytes(req.method, req.path, ts, req.body), sig);
  return ok ? { owner, key, record: phone.root } : null;
}
