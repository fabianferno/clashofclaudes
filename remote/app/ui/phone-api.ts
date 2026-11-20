import type { Signable } from '../../lib/crypto';

/** This phone, once paired: what the screens need from it. */
export interface PhoneApi {
  /** Whose village it is paired with. */
  owner: string;
  key: string;
  signAction(a: Signable): Promise<string>;
  /** A signed request to the remote's own API. */
  api(path: string, init?: { method?: string; body?: string }): Promise<Response>;
}
