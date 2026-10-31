#!/usr/bin/env bash
# Universal macOS release build. Signs/notarizes only when credentials are present.
# Usage: scripts/release.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

have() { [[ -n "${!1:-}" ]]; }   # never echoes values

# 1. rustup targets
missing=()
installed="$(rustup target list --installed 2>/dev/null || true)"
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  grep -qx "$t" <<<"$installed" || missing+=("$t")
done

# 2. credential detection
SIGN=0; NOTARY="none"
if have APPLE_ID && have APPLE_PASSWORD && have APPLE_TEAM_ID; then NOTARY="apple-id"; fi
if have APPLE_API_ISSUER && have APPLE_API_KEY && have APPLE_API_KEY_PATH; then NOTARY="api-key"; fi
if have APPLE_SIGNING_IDENTITY && [[ "$NOTARY" != "none" ]]; then SIGN=1; fi

UPDATER=0; have TAURI_SIGNING_PRIVATE_KEY && UPDATER=1

echo "== Clash of Claudes release =="
echo "rustup targets missing: ${missing[*]:-none}"
echo "signing identity set: $(have APPLE_SIGNING_IDENTITY && echo yes || echo no)"
echo "notarization credentials: $NOTARY"
echo "updater signing key (TAURI_SIGNING_PRIVATE_KEY): $([[ $UPDATER == 1 ]] && echo yes || echo 'no -> updater artifacts skipped')"
if [[ $SIGN == 1 ]]; then
  echo "MODE: signed + notarized (Developer ID)"
else
  echo "UNSIGNED BUILD — not for distribution"
fi

ARGS=(tauri build --target universal-apple-darwin)
if [[ $UPDATER == 1 ]]; then
  ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":true}}')
fi

if [[ $DRY == 1 ]]; then
  echo "-- dry run; steps:"
  echo "1. rustup target add ${missing[*]:-(none needed)}"
  echo "2. pnpm ${ARGS[*]}"
  echo "3. print artifact paths + shasum -a 256"
  exit 0
fi

if ((${#missing[@]})); then
  echo "Adding missing rustup targets: ${missing[*]}"
  rustup target add "${missing[@]}"
fi

if [[ $SIGN == 0 ]]; then
  # An empty/partial identity must not leak into an unsigned build.
  unset APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
fi

pnpm "${ARGS[@]}"

OUT="src-tauri/target/universal-apple-darwin/release/bundle"
echo "== Artifacts =="
find "$OUT" -maxdepth 2 \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.sig' \) -print0 \
  | while IFS= read -r -d '' f; do shasum -a 256 "$f"; done
find "$OUT/macos" -maxdepth 1 -name '*.app' -print 2>/dev/null
[[ $SIGN == 1 ]] || echo "UNSIGNED BUILD — not for distribution"
[[ $UPDATER == 1 ]] || echo "Updater artifacts skipped (TAURI_SIGNING_PRIVATE_KEY unset)"
