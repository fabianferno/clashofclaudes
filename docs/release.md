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
   Put the **public key contents** (not a path) in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`, and the endpoint (`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`) under `plugins.updater.endpoints`. Export `TAURI_SIGNING_PRIVATE_KEY` (path or content) and, if set, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `.env` files are not read. Without the key the release script skips updater artifacts and the build still succeeds.
4. **GitHub repo for releases**: create it, push, and use GitHub Releases to host the DMG, `.app.tar.gz`, `.sig` and `latest.json`.

## Per-release procedure

1. Bump `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`; commit.
2. Export the env vars above, then `scripts/release.sh --dry-run` (prints the plan and which credentials were detected; never prints secret values).
3. `scripts/release.sh` (or `pnpm release`). Runs `pnpm tauri build --target universal-apple-darwin`; prints artifact paths and SHA-256s. The script adds `createUpdaterArtifacts` only when `TAURI_SIGNING_PRIVATE_KEY` is set.
4. Outputs are in `src-tauri/target/universal-apple-darwin/release/bundle/` (`dmg/`, `macos/`).
5. Verify: `lipo -archs "<app>/Contents/MacOS/<bin>"` shows `x86_64 arm64`; `codesign -dv --verbose=2 <app>`; `spctl -a -vv <app>`; `xcrun stapler validate <dmg>`.
6. Write `latest.json` (`version`, `notes`, `pub_date`, `platforms.darwin-aarch64` and `darwin-x86_64` each with `url` to the `.app.tar.gz` and `signature` = contents of its `.sig`), create the GitHub Release, upload DMG, tar.gz, .sig, latest.json.

The app sandbox stays OFF (it spawns CLIs in PTYs). Hardened runtime is ON (`bundle.macOS.hardenedRuntime`; Tauri applies it when signing). `Entitlements.plist` is empty by design; add `com.apple.security.cs.allow-jit` only if the notarization log asks.

Note: the updater plugin itself (`tauri-plugin-updater`, `plugins.updater`) is not wired in this task.

## Public-name / rename checklist

- `identifier` in `src-tauri/tauri.conf.json` is `dev.clashofclaudes.app`. Tauri warns because it ends with `.app` (conflicts with the macOS bundle extension). Changing it moves the app data directory (existing `state.json` and sessions are orphaned), so change it deliberately and migrate/copy the old data dir.
- `productName` ("Clash of Claudes") — also the `.app`/DMG name and window titles (`app.windows[].title`).
- Icons in `src-tauri/icons/` (regenerate with `pnpm tauri icon <source.png>`).
- `package.json` `name`, `Cargo.toml` package name/authors/description, updater endpoint URL, DMG window layout if names change.
- Art/trademark: no Supercell names or assets; verify the public name does not imply affiliation.
