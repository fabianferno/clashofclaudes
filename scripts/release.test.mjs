import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;

/** The environment without any real credentials, plus `extra`. */
function env(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('APPLE_') || k.startsWith('TAURI_SIGNING_')) delete e[k];
  return { ...e, ...extra };
}

/** Runs `release.sh --dry-run` against the repo, or against a copy with `conf` as tauri.conf.json. */
function dryRun(extra, conf) {
  let dir = root;
  if (conf) {
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'src-tauri'));
    copyFileSync(join(root, 'scripts/release.sh'), join(dir, 'scripts/release.sh'));
    writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify(conf));
  }
  try {
    return spawnSync('bash', [join(dir, 'scripts/release.sh'), '--dry-run'], { encoding: 'utf8', env: env(extra) });
  } finally {
    if (conf) rmSync(dir, { recursive: true, force: true });
  }
}

const shipped = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const configured = (patch) => ({
  ...shipped,
  plugins: { updater: { pubkey: 'RWQrealkey', endpoints: ['https://github.com/me/clash/releases/latest/download/latest.json'], ...patch } },
});
const signing = { APPLE_SIGNING_IDENTITY: 'Developer ID Application: X (T)', APPLE_ID: 'a@b.c', APPLE_PASSWORD: 'pw-secret', APPLE_TEAM_ID: 'T' };

test('no credentials: unsigned dry run succeeds', () => {
  const r = dryRun({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /UNSIGNED BUILD/);
});

test('updater key with the shipped placeholders is refused', () => {
  const r = dryRun({ TAURI_SIGNING_PRIVATE_KEY: 'fake-key-secret' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pubkey is still the placeholder/);
  assert.match(r.stderr, /OWNER\/REPO/);
  assert.doesNotMatch(r.stdout + r.stderr, /fake-key-secret/);
});

test('updater key with only one placeholder left is refused', () => {
  const key = { TAURI_SIGNING_PRIVATE_KEY: 'k' };
  const r1 = dryRun(key, configured({ pubkey: 'REPLACE_WITH_UPDATER_PUBLIC_KEY' }));
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /pubkey/);
  const r2 = dryRun(key, configured({ endpoints: ['https://github.com/OWNER/REPO/releases/latest/download/latest.json'] }));
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /OWNER\/REPO/);
});

test('updater key with a configured source is accepted', () => {
  const r = dryRun({ TAURI_SIGNING_PRIVATE_KEY: 'k' }, configured({}));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /latest\.json/);
});

test('signing without the updater key warns that the build never auto-updates', () => {
  const r = dryRun(signing);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MODE: signed \+ notarized/);
  assert.match(r.stderr, /this build will never auto-update/);
  assert.doesNotMatch(r.stdout + r.stderr, /pw-secret/);
});
