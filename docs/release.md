# Releasing Clash of Claudes

Universal (arm64 + x86_64) macOS 13+ DMG. Signed and notarized when credentials are present; otherwise the build succeeds unsigned and prints `UNSIGNED BUILD — not for distribution`.

## One-time setup (owner)

1. **Apple Developer account** (paid program). In Certificates, create a **Developer ID Application** certificate, install it in your login keychain, and find the identity:
   `security find-identity -v -p codesigning` -> `Developer ID Application: Name (TEAMID)`.
   Export `APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)"`.
   (CI: `APPLE_CERTIFICATE` = base64 .p12 and `APPLE_CERTIFICATE_PASSWORD`.)
2. **Notarization credentials** — either:
   - Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (app-specific password from appleid.apple.com), `APPLE_TEAM_ID`; or
   - App Store Connect API key: `APPLE_API_ISSUER`, `APPLE_API_KEY` (key ID), `APPLE_API_KEY_PATH` (.p8 path).
3. **Updater key** (kept outside the repo, never committed):
   `pnpm tauri signer generate -w ~/.tauri/clashofclaudes.key`
   Then edit `src-tauri/tauri.conf.json` under `plugins.updater`:
   - `pubkey`: replace `REPLACE_WITH_UPDATER_PUBLIC_KEY` with the **public key contents** (not a path).
   - `endpoints[0]`: replace `OWNER` and `REPO` in `https://github.com/OWNER/REPO/releases/latest/download/latest.json`.
   Export `TAURI_SIGNING_PRIVATE_KEY` (path or content) and, if set, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `.env` files are not read. Without the key the release script skips updater artifacts: the `.app.tar.gz` and `.sig` files exist **only** when the key is set, and the build still succeeds.
4. **GitHub repo for releases**: create it, push, and use GitHub Releases to host the DMG, `.app.tar.gz`, `.sig` and `latest.json`.

## Per-release procedure

1. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`; commit.
2. Export the env vars above, then `scripts/release.sh --dry-run` (prints the plan and which credentials were detected; never prints secret values). Only `--dry-run` is accepted; any other argument aborts.
3. `scripts/release.sh` (or `pnpm release`). It runs `pnpm tauri build --target universal-apple-darwin`, then automatically runs `lipo -archs` on the built binary (fails unless it prints `x86_64 arm64`) and prints artifact paths and SHA-256s. Notes: unsigned builds unset `APPLE_CERTIFICATE*` and all other Apple variables; if both notarization credential sets are present it warns and uses the API key.
4. Outputs are in `src-tauri/target/universal-apple-darwin/release/bundle/` (`dmg/`, `macos/`).
5. When `TAURI_SIGNING_PRIVATE_KEY` is set the script also writes `bundle/latest.json` via `scripts/make-latest-json.mjs` (`version` from `tauri.conf.json`, `notes` from `$RELEASE_NOTES`, default `Release v<version>`). The tarball URL is `https://github.com/OWNER/REPO/releases/download/v<version>/<tarball>` (OWNER/REPO taken from `plugins.updater.endpoints[0]`; spaces in the file name become dots, as GitHub renames uploaded assets; override the whole URL with `$RELEASE_DOWNLOAD_URL`). Both `darwin-aarch64` and `darwin-x86_64` point at the one universal tarball.
6. Verify: `codesign -dv --verbose=2 <app>`; `spctl -a -vv <app>`; `xcrun stapler validate <dmg>`.
7. Create the GitHub Release `v<version>` and upload the DMG, the `.app.tar.gz` and `latest.json` (`.sig` is already embedded in `latest.json`; uploading it is optional). Because the endpoint is `releases/latest/download/latest.json`, only the newest non-prerelease release is served.

The app sandbox stays OFF (it spawns CLIs in PTYs). Hardened runtime is ON (`bundle.macOS.hardenedRuntime`; Tauri applies it when signing). `Entitlements.plist` is empty by design; add `com.apple.security.cs.allow-jit` only if the notarization log asks.

## Auto-update (the one network exception)

The app otherwise makes no network calls (agent data never leaves your machine). The updater is the single exception: it fetches `latest.json` and, only when you click "Restart to update", the signed `.app.tar.gz` from the configured GitHub host. Signatures are verified against `pubkey`.

It never runs when any of these hold (decided in Rust before any request): a debug build; `pubkey` is still `REPLACE_WITH_UPDATER_PUBLIC_KEY`; the user turned off "Check for updates automatically" (Town Hall panel, persisted as `settings.updatesEnabled`). Otherwise it checks 10 s after start and every 6 h. Failures are logged and invisible in the UI. After installing, the app restarts through the quit guard: with running sessions it asks first, and cancelling leaves the update installed for the next launch.

Until you replace the placeholders the shipped app is fully functional and updates itself never.

## Public-name / rename checklist

- `identifier` in `src-tauri/tauri.conf.json` is `dev.clashofclaudes.app`. Tauri warns because it ends with `.app` (conflicts with the macOS bundle extension). Changing it moves the app data directory (existing `state.json` and sessions are orphaned), so change it deliberately and migrate/copy the old data dir.
- `productName` ("Clash of Claudes") — also the `.app`/DMG name and window titles (`app.windows[].title`).
- Icons in `src-tauri/icons/` (regenerate with `pnpm tauri icon <source.png>`).
- `package.json` `name`, `Cargo.toml` package name/authors/description, updater endpoint URL, DMG window layout if names change.
- Art/trademark: no Supercell names or assets; verify the public name does not imply affiliation.
