import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./make-latest-json.mjs', import.meta.url).pathname;

function run(args) {
  return spawnSync('node', [script, ...args], { encoding: 'utf8' });
}

test('latest_json_shape', () => {
  const d = mkdtempSync(join(tmpdir(), 'lj-'));
  const sig = join(d, 'app.tar.gz.sig');
  writeFileSync(sig, 'SIGNATURE-CONTENT==\n');
  const out = join(d, 'latest.json');
  const url = 'https://github.com/o/r/releases/download/v1.2.0/app.tar.gz';
  const r = run(['--version', '1.2.0', '--notes', 'Fixes "things"', '--tarball', join(d, 'app.tar.gz'), '--sig', sig, '--url', url, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(j.version, '1.2.0');
  assert.equal(j.notes, 'Fixes "things"');
  assert.match(j.pub_date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  assert.deepEqual(Object.keys(j.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64']);
  for (const k of Object.keys(j.platforms)) {
    assert.deepEqual(j.platforms[k], { url, signature: 'SIGNATURE-CONTENT==' });
  }
});

test('missing or unknown args fail without writing', () => {
  assert.notEqual(run(['--version', '1.0.0']).status, 0);
  assert.notEqual(run(['--bogus', 'x']).status, 0);
});
