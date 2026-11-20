import { expect, test } from 'vitest';
import { b64, checkNumber, keyId, requestBytes, sha256Hex, signedBytes, unb64, verify } from './crypto';

// From `node scripts/remote-vectors.mjs`, the same vector the Mac app is tested with
// (`src-tauri/src/board/remote_tests.rs`): both sides must agree on every byte.
const PUB = 'BJFoira10seT_4mQCR9cHCW_d571sQbL3La0PctTmwr5P3GDEX_lc0QORs_pqRotn_e4cNgEMUb1Sdclf3Km8E8';
const BLOCK = '{"v":1,"host":"h1","session":"s1","since":42,"wait":"decide","can":["allow","deny"],"question":"Bash: npm test","options":null}';
const PROMPT = 'ae3a1276c07ab30713915df0019df188200c1e5c1c118aa88093a8cb0d779cfc';
const NONCE = '000102030405060708090a0b0c0d0e0f';
const MSG = `coc-act-1\nallow\n\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n${NONCE}\n${PROMPT}`;
const SIG = 'o_hEb90kqsSNUXZ39UrU8AtMwLmee8ZJxz2I3GaYZFtL0E3Z32pCOnB2jwdPbUAkpbJZKAqrW4rsp31Rhjq-aA';
const HIGH_S = 'o_hEb90kqsSNUXZ39UrU8AtMwLmee8ZJxz2I3GaYZFu0L7IlIJW9xo-JcPiwkr_bFzShhZxsQvoHEk1xdihm6Q';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('the signed bytes of an action are the six lines the Mac checks', async () => {
  expect(await sha256Hex(new TextEncoder().encode(BLOCK))).toBe(PROMPT);
  expect(text(await signedBytes({ do: 'allow', nonce: NONCE, prompt: PROMPT }))).toBe(MSG);
  const picked = text(await signedBytes({ do: 'answer', pick: 2, text: 'use sqlite', nonce: NONCE, prompt: PROMPT })).split('\n');
  expect(picked.slice(0, 3)).toEqual(['coc-act-1', 'answer', '2']);
  expect(picked[3]).toBe(await sha256Hex(new TextEncoder().encode('use sqlite')));
});

test('a WebCrypto signature verifies; its high-s twin and a changed byte do not', async () => {
  const pub = unb64(PUB);
  const msg = new TextEncoder().encode(MSG);
  expect(await verify(pub, msg, SIG)).toBe(true);
  expect(await verify(pub, msg, HIGH_S)).toBe(false);
  expect(await verify(pub, new TextEncoder().encode(MSG + 'x'), SIG)).toBe(false);
  expect(await verify(pub.slice(0, 40), msg, SIG)).toBe(false);
  expect(await verify(pub, msg, 'not base64 !')).toBe(false);
});

test('the key id and the check number are the ones the Mac shows', async () => {
  expect(await keyId(unb64(PUB))).toBe('e1628ecfdc6cbe3e');
  expect(await checkNumber(unb64(PUB), 'msg_t_1')).toBe('792 693');
});

test('base64url round trips without padding', () => {
  const bytes = new Uint8Array([251, 255, 0, 1]);
  expect(b64(bytes)).toBe('-_8AAQ');
  expect([...unb64('-_8AAQ')]).toEqual([251, 255, 0, 1]);
});

test('a request is signed over its method, path, time and body', async () => {
  const body = new TextEncoder().encode('{"a":1}');
  expect(text(await requestBytes('POST', '/api/act', 1700000000000, body))).toBe(`coc-req-1\nPOST\n/api/act\n1700000000000\n${await sha256Hex(body)}`);
  expect(text(await requestBytes('GET', '/api/queue', 5, new Uint8Array()))).toContain('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
