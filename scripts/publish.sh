#!/usr/bin/env bash
# Ships a beta: bumps the version, builds a signed, notarized universal release with updater files,
# tags it, and publishes it on the public releases repo, where the app's updater and the landing
# page find it. See docs/release.md.
# Usage: scripts/publish.sh <version> [--notes <file>] [--dry-run]
set -euo pipefail
{ set +x; } 2>/dev/null   # never trace: secrets live in the environment
cd "$(dirname "$0")/.."

RELEASES_REPO="${RELEASES_REPO:-fabianferno/clashofclaudes}"
KEY_FILE="${COC_UPDATER_KEY_FILE:-$HOME/.tauri/clashofclaudes.key}"
VERSION=""; NOTES_FILE=""; DRY=0
die() { echo "ERROR: $*" >&2; exit 1; }
usage="usage: scripts/publish.sh <version> [--notes <file>] [--dry-run]"
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --notes) shift; NOTES_FILE="${1:-}"; [[ -f "$NOTES_FILE" ]] || die "no notes file: $NOTES_FILE" ;;
    -*) die "unknown argument: $1 ($usage)" ;;
    *) [[ -z "$VERSION" ]] || die "$usage"; VERSION="$1" ;;
  esac
  shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$usage (version like 0.2.0)"

CURRENT="$(node -p "require('./src-tauri/tauri.conf.json').version")"
node -e 'const [a,b]=process.argv.slice(1).map(v=>v.split(".").map(Number));for(let i=0;i<3;i++){if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1)}process.exit(1)' "$VERSION" "$CURRENT" \
  || die "$VERSION is not newer than the current $CURRENT"

# 1. the tree: main, clean, up to date
[[ "$(git branch --show-current)" == main ]] || die "publish from main"
[[ -z "$(git status --porcelain)" ]] || die "commit or stash your changes first"
git fetch -q origin main
[[ "$(git rev-list --count HEAD..origin/main)" == 0 ]] || die "main is behind origin/main; pull first"
! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || die "tag v$VERSION already exists"
! gh release view "v$VERSION" -R "$RELEASES_REPO" >/dev/null 2>&1 || die "v$VERSION is already released on $RELEASES_REPO"
# 2. credentials, found on this Mac unless already set
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"')" || true
fi
[[ -n "$APPLE_SIGNING_IDENTITY" ]] || die "no 'Developer ID Application' certificate in the keychain"
export APPLE_SIGNING_IDENTITY
if [[ -z "${NOTARY_PROFILE:-}" ]]; then
  for p in clashofclaudes typewiser; do
    if xcrun notarytool history --keychain-profile "$p" >/dev/null 2>&1; then NOTARY_PROFILE="$p"; break; fi
  done
fi
[[ -n "${NOTARY_PROFILE:-}" ]] || die "no notarytool keychain profile (xcrun notarytool store-credentials clashofclaudes ...)"
export NOTARY_PROFILE
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ -f "$KEY_FILE" ]]; then
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
  else
    TAURI_SIGNING_PRIVATE_KEY="$(security find-generic-password -a clashofclaudes -s "Clash of Claudes updater key" -w 2>/dev/null)" || true
  fi
fi
[[ -n "$TAURI_SIGNING_PRIVATE_KEY" ]] || die "no updater key at $KEY_FILE or in the keychain; without it installed apps can't update"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
[[ -n "${COC_BUG_WEBHOOK:-}" || -s src-tauri/bug-webhook.txt ]] || die "no bug webhook (COC_BUG_WEBHOOK or src-tauri/bug-webhook.txt): testers couldn't send feedback"
[[ -n "${COC_POSTHOG_KEY:-}" || -s src-tauri/posthog-key.txt ]] || die "no PostHog key (COC_POSTHOG_KEY or src-tauri/posthog-key.txt): testers who share usage would send nothing"

# 3. notes: the given file, or every commit since the last release
LAST="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
if [[ -n "$NOTES_FILE" ]]; then
  NOTES="$(cat "$NOTES_FILE")"
elif [[ -n "$LAST" ]]; then
  NOTES="$(git log --no-merges --format='- %s' "$LAST..HEAD")"
else
  NOTES="First beta release."
fi

echo "== Publish Clash of Claudes $CURRENT -> $VERSION =="
echo "signing: $APPLE_SIGNING_IDENTITY"
echo "notary profile: $NOTARY_PROFILE"
echo "updater key: found"
echo "releases repo: $RELEASES_REPO"
echo "notes:"; sed 's/^/  /' <<<"$NOTES"
if [[ $DRY == 1 ]]; then
  echo "-- dry run; steps: bump version, scripts/release.sh, verify signature/notarization, commit + tag v$VERSION, push, gh release create"
  exit 0
fi

# 4. bump (undone if the build fails)
BUMPED=(src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
trap 'git checkout -q -- "${BUMPED[@]}"; echo "Version bump undone." >&2' ERR
node -e 'const fs=require("fs");for(const f of ["src-tauri/tauri.conf.json","package.json"]){const j=JSON.parse(fs.readFileSync(f));j.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")}' "$VERSION"
sed -i '' -E "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml >/dev/null   # refreshes Cargo.lock

# 5. build, sign, notarize
RELEASE_NOTES="$NOTES" bash scripts/release.sh
OUT="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$OUT/macos/Clash of Claudes.app"
DMG="$(find "$OUT/dmg" -maxdepth 1 -name "*_${VERSION}_universal.dmg" -print -quit)"
[[ -n "$DMG" ]] || die "no DMG for $VERSION"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -v "$DMG"
trap - ERR

# 6. record it, then publish
git commit -qm "Release v$VERSION" -- "${BUMPED[@]}"
git tag -a "v$VERSION" -m "Clash of Claudes $VERSION"
git push -q origin main "v$VERSION"

STAGE="$(mktemp -d)"
# GitHub turns spaces into dots in asset names; latest.json already points at the dotted name.
cp "$DMG" "$STAGE/$(basename "$DMG" | tr ' ' '.')"
cp "$OUT/dmg/Clash-of-Claudes.dmg" "$OUT/latest.json" "$STAGE/"
cp "$OUT/macos/Clash of Claudes.app.tar.gz" "$STAGE/Clash.of.Claudes.app.tar.gz"
gh release create "v$VERSION" -R "$RELEASES_REPO" --title "Clash of Claudes $VERSION" --notes "$NOTES" "$STAGE"/*
rm -rf "$STAGE"
echo "Published: https://github.com/$RELEASES_REPO/releases/tag/v$VERSION"
echo "Installed apps will offer the update within six hours (or at once from Settings › Check now)."
