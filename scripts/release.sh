#!/usr/bin/env bash
# Universal macOS release build. Signs/notarizes only when credentials are present.
# Notarization: APPLE_ID set, App Store Connect API key, or NOTARY_PROFILE (a `notarytool
# store-credentials` keychain profile; the DMG is submitted and stapled after the build).
# Usage: scripts/release.sh [--dry-run]
set -euo pipefail
{ set +x; } 2>/dev/null   # never trace: secrets live in the environment
cd "$(dirname "$0")/.."

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) echo "unknown argument: $a (usage: scripts/release.sh [--dry-run])" >&2; exit 2 ;;
  esac
done

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
if have NOTARY_PROFILE; then NOTARY="keychain-profile"; fi
if have APPLE_SIGNING_IDENTITY && [[ "$NOTARY" != "none" ]]; then SIGN=1; fi
if have APPLE_ID && have APPLE_PASSWORD && have APPLE_TEAM_ID && have APPLE_API_ISSUER && have APPLE_API_KEY && have APPLE_API_KEY_PATH; then
  [[ "$NOTARY" == "api-key" ]] && echo "WARNING: both notarization credential sets are present; using the API key (api-key) and ignoring the Apple ID set." >&2
fi

UPDATER=0; have TAURI_SIGNING_PRIVATE_KEY && UPDATER=1

# An updater-signed build must point at a real update source: with the shipped placeholders the
# app's update gate refuses to check, so every release built this way would be stranded.
if [[ $UPDATER == 1 ]]; then
  CONF_PUBKEY="$(node -p "String((require('./src-tauri/tauri.conf.json').plugins.updater || {}).pubkey || '')")"
  CONF_ENDPOINTS="$(node -p "((require('./src-tauri/tauri.conf.json').plugins.updater || {}).endpoints || []).join(' ')")"
  problems=()
  if [[ -z "${CONF_PUBKEY//[[:space:]]/}" || "$CONF_PUBKEY" == "REPLACE_WITH_UPDATER_PUBLIC_KEY" ]]; then
    problems+=("plugins.updater.pubkey is still the placeholder (REPLACE_WITH_UPDATER_PUBLIC_KEY)")
  fi
  if [[ -z "${CONF_ENDPOINTS//[[:space:]]/}" || "$CONF_ENDPOINTS" == *OWNER/REPO* ]]; then
    problems+=("plugins.updater.endpoints still names OWNER/REPO")
  fi
  if ((${#problems[@]})); then
    echo "ERROR: TAURI_SIGNING_PRIVATE_KEY is set, but src-tauri/tauri.conf.json is not configured for updates:" >&2
    for p in "${problems[@]}"; do echo "  - $p" >&2; done
    echo "Set the real updater public key and GitHub repo (see docs/release.md), or unset TAURI_SIGNING_PRIVATE_KEY." >&2
    exit 1
  fi
fi

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
if [[ $SIGN == 1 && $UPDATER == 0 ]]; then
  echo "WARNING: signing without TAURI_SIGNING_PRIVATE_KEY — this build will never auto-update (no updater artifacts, no latest.json)." >&2
fi

ARGS=(tauri build --target universal-apple-darwin)
if [[ $UPDATER == 1 ]]; then
  UPDATER_CONFIG='{"bundle":{"createUpdaterArtifacts":true}}'
  ARGS+=(--config "$UPDATER_CONFIG")
fi

if [[ $DRY == 1 ]]; then
  echo "-- dry run; steps:"
  echo "1. rustup target add ${missing[*]:-(none needed)}"
  printf '2. pnpm'; printf ' %q' "${ARGS[@]}"; printf '\n'
  echo "3. lipo -archs on the built binary (must be: x86_64 arm64)"
  echo "4. print artifact paths + shasum -a 256"
  [[ $UPDATER == 1 ]] && echo "5. node scripts/make-latest-json.mjs -> latest.json (updater key is set)"
  [[ "$NOTARY" == "keychain-profile" && $SIGN == 1 ]] && echo "6. xcrun notarytool submit <dmg> --keychain-profile <NOTARY_PROFILE> --wait; xcrun stapler staple <dmg>"
  exit 0
fi

if ((${#missing[@]})); then
  echo "Adding missing rustup targets: ${missing[*]}"
  rustup target add "${missing[@]}"
fi

if [[ $SIGN == 0 ]]; then
  # An empty/partial identity must not leak into an unsigned build.
  unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
fi

if [[ $SIGN == 1 && "$NOTARY" == "api-key" ]]; then
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID   # make the warning true: only the API key is used
fi
if [[ $SIGN == 1 && "$NOTARY" == "keychain-profile" ]]; then
  # Tauri only signs; the DMG is notarized below with the keychain profile.
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
fi

pnpm "${ARGS[@]}"

OUT="src-tauri/target/universal-apple-darwin/release/bundle"
echo "== Artifacts =="
find "$OUT" -maxdepth 2 \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.sig' \) -print0 \
  | while IFS= read -r -d '' f; do shasum -a 256 "$f"; done
APP="$(find "$OUT/macos" -maxdepth 1 -name '*.app' -print -quit 2>/dev/null || true)"
[[ -n "$APP" ]] && echo "$APP"

# Both architectures must be in the binary.
BIN="$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -print -quit 2>/dev/null || true)"
if [[ -z "$BIN" ]]; then echo "ERROR: no binary found in $APP" >&2; exit 1; fi
ARCHS="$(lipo -archs "$BIN")"
echo "lipo -archs: $ARCHS"
if [[ "$ARCHS" != "x86_64 arm64" ]]; then echo "ERROR: expected 'x86_64 arm64', got '$ARCHS'" >&2; exit 1; fi

DMG="$(find "$OUT/dmg" -maxdepth 1 -name "*_$(node -p "require('./src-tauri/tauri.conf.json').version")_universal.dmg" -print -quit 2>/dev/null || true)"
[[ -n "$DMG" ]] || { echo "ERROR: no universal DMG in $OUT/dmg" >&2; exit 1; }
if [[ $SIGN == 1 && "$NOTARY" == "keychain-profile" ]]; then
  echo "== Notarizing $(basename "$DMG") (profile $NOTARY_PROFILE) =="
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$OUT/notary.json" || true
  if ! grep -q '"status" *: *"Accepted"' "$OUT/notary.json"; then
    cat "$OUT/notary.json" >&2
    id="$(grep -o '"id" *: *"[^"]*"' "$OUT/notary.json" | head -1 | cut -d'"' -f4)"
    [[ -n "$id" ]] && xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2
    echo "ERROR: notarization failed" >&2; exit 1
  fi
  rm -f "$OUT/notary.json"
  xcrun stapler staple "$DMG"
fi
# A copy under a name that never changes, for the "latest" download link.
cp "$DMG" "$OUT/dmg/Clash-of-Claudes.dmg"
echo "$OUT/dmg/Clash-of-Claudes.dmg"

# Updater manifest (only when the updater key signed the tarball).
if [[ $UPDATER == 1 ]]; then
  VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
  ENDPOINT="$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.endpoints[0]")"
  TARBALL="$(find "$OUT/macos" -maxdepth 1 -name '*.app.tar.gz' -print -quit)"
  [[ -n "$TARBALL" && -f "$TARBALL.sig" ]] || { echo "ERROR: updater tarball/.sig missing in $OUT/macos" >&2; exit 1; }
  # .../releases/latest/download/latest.json -> .../releases/download/v<version>/<asset>
  # GitHub renames uploaded assets: spaces become dots.
  ASSET="$(basename "$TARBALL" | tr ' ' '.')"
  DL_URL="${RELEASE_DOWNLOAD_URL:-${ENDPOINT%/latest/download/*}/download/v$VERSION/$ASSET}"
  node scripts/make-latest-json.mjs --version "$VERSION" --notes "${RELEASE_NOTES:-Release v$VERSION}" \
    --tarball "$TARBALL" --sig "$TARBALL.sig" --url "$DL_URL" --out "$OUT/latest.json"
  echo "Upload $ASSET (the .app.tar.gz) and latest.json to the v$VERSION GitHub Release; url in manifest: $DL_URL"
fi
[[ $SIGN == 1 ]] || echo "UNSIGNED BUILD — not for distribution"
[[ $UPDATER == 1 ]] || echo "Updater artifacts skipped (TAURI_SIGNING_PRIVATE_KEY unset)"
