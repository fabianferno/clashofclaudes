#!/usr/bin/env node
// Builds the Tauri updater manifest (latest.json). No dependencies.
// Usage: node scripts/make-latest-json.mjs --version X --notes "…" --tarball <path> --sig <path> --url <download url> [--out latest.json]
// The universal tarball serves both macOS architectures; `signature` is the .sig file's contents.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const KNOWN = new Set(['version', 'notes', 'tarball', 'sig', 'url', 'out']);
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
  if (!key || !KNOWN.has(key) || argv[i + 1] === undefined) {
    console.error(`make-latest-json: bad argument ${argv[i]}`);
    process.exit(2);
  }
  args[key] = argv[i + 1];
}
for (const req of ['version', 'tarball', 'sig', 'url']) {
  if (!args[req]) {
    console.error(`make-latest-json: missing --${req}`);
    process.exit(2);
  }
}

let signature;
try {
  signature = readFileSync(args.sig, 'utf8').trim();
} catch (e) {
  console.error(`make-latest-json: cannot read --sig ${args.sig}: ${e.message}`);
  process.exit(1);
}
if (!signature) {
  console.error('make-latest-json: signature file is empty');
  process.exit(1);
}

const entry = { url: args.url, signature };
const manifest = {
  version: args.version,
  notes: args.notes ?? '',
  pub_date: new Date().toISOString(),
  platforms: { 'darwin-aarch64': { ...entry }, 'darwin-x86_64': { ...entry } },
};
const out = args.out ?? 'latest.json';
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${out} for ${args.version} (${basename(args.tarball)})`);
