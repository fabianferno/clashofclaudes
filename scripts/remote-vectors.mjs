// Test vectors for the phone's signatures (`src-tauri/src/board/remote_tests.rs`, `remote/lib/crypto.test.ts`):
// made with WebCrypto, as a phone's browser makes them. Run: node scripts/remote-vectors.mjs
import { webcrypto as c } from 'node:crypto';

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (b) => Buffer.from(b).toString('hex');
const sha = async (b) => hex(await c.subtle.digest('SHA-256', b));
const big = (b) => BigInt('0x' + hex(b));
const bytes32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

const pair = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await c.subtle.exportKey('raw', pair.publicKey));
const block = '{"v":1,"host":"h1","session":"s1","since":42,"wait":"decide","can":["allow","deny"],"question":"Bash: npm test","options":null}';
const prompt = await sha(Buffer.from(block));
const nonce = '000102030405060708090a0b0c0d0e0f';
const msg = ['coc-act-1', 'allow', '', await sha(Buffer.alloc(0)), nonce, prompt].join('\n');

// a low-s signature (what the Mac accepts) and its high-s twin (refused)
let sig;
do sig = Buffer.from(await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, Buffer.from(msg)));
while (big(sig.subarray(32)) > N / 2n);
const high = Buffer.concat([sig.subarray(0, 32), bytes32(N - big(sig.subarray(32)))]);

const ticket = 'msg_t_1';
const d = Buffer.from(await c.subtle.digest('SHA-256', Buffer.concat([pub, Buffer.from(ticket)])));
const n = String(d.readUInt32BE(0) % 1_000_000).padStart(6, '0');
console.log(JSON.stringify({
  public: pub.toString('base64url'), keyId: (await sha(pub)).slice(0, 16), ticket, check: `${n.slice(0, 3)} ${n.slice(3)}`,
  block, prompt, nonce, msg, sig: sig.toString('base64url'), highS: high.toString('base64url'),
}, null, 1));
