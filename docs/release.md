# Releasing Clash of Claudes

Universal (arm64 + x86_64) macOS 13+ DMG. Signed and notarized when credentials are present; otherwise the build succeeds unsigned and prints `UNSIGNED BUILD — not for distribution`.

## Shipping a beta: `pnpm ship <version>`

`scripts/publish.sh` does the whole release from a clean, up-to-date `main`:

1. Finds the credentials on this Mac (each can be overridden by its env var):
   - `APPLE_SIGNING_IDENTITY`: the first **Developer ID Application** certificate in the keychain (the team's).
   - `NOTARY_PROFILE`: a `notarytool store-credentials` keychain profile; tries `clashofclaudes`, then the team's `typewiser`.
   - `TAURI_SIGNING_PRIVATE_KEY`: the updater key, from `~/.tauri/clashofclaudes.key`, else the login keychain item "Clash of Claudes updater key" (a backup of the same key). **Losing this key means installed apps can never update again**; keep a copy in a password manager.
   - the bug webhook (`COC_BUG_WEBHOOK` or `src-tauri/bug-webhook.txt`); it refuses to ship a build that can't send feedback.
2. Bumps `version` in `tauri.conf.json`, `package.json`, `Cargo.toml` (+ `Cargo.lock`).
3. Runs `scripts/release.sh`: universal build, signed; DMG notarized and stapled; updater tarball + `latest.json`; a copy of the DMG named `Clash-of-Claudes.dmg`.
4. Verifies `codesign`, `stapler validate` and `spctl`; if anything fails the version bump is undone.
5. Commits `Release v<version>`, tags `v<version>`, pushes to the private repo.
6. Creates the GitHub Release `v<version>` on the **public** releases repo, [fabianferno/clashofclaudes-releases](https://github.com/fabianferno/clashofclaudes-releases), with the versioned DMG, `Clash-of-Claudes.dmg`, the `.app.tar.gz` and `latest.json`. Notes are the commit subjects since the last tag, or `--notes <file>`.

`pnpm ship <version> --dry-run` shows the plan and the notes without changing anything.

The source repo is private, so release files live in the separate public repo: GitHub serves private-repo assets only to signed-in collaborators, which would break both the download link and the updater.

**Download link** (always the newest release, used by the landing page): `https://github.com/fabianferno/clashofclaudes-releases/releases/latest/download/Clash-of-Claudes.dmg`.

## How installed apps update

The updater reads `https://github.com/fabianferno/clashofclaudes-releases/releases/latest/download/latest.json` (`plugins.updater.endpoints`), and verifies the tarball against `plugins.updater.pubkey`. Only the newest non-prerelease release is served, so never mark a beta as a prerelease if testers should get it.

In the app: a check 10 s after launch and every 6 h; when a newer version exists a toast offers **Update**, shows download progress, then **Restart to update** (with running sessions it asks first; cancelling keeps the update for the next launch). **Settings › Check now** checks at once, and the automatic check can be turned off there.

## Lower-level: `scripts/release.sh`

Builds without publishing. Credentials come only from the environment: `APPLE_SIGNING_IDENTITY` plus one notarization method (`NOTARY_PROFILE`, or `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`, or `APPLE_API_ISSUER`/`APPLE_API_KEY`/`APPLE_API_KEY_PATH`), and `TAURI_SIGNING_PRIVATE_KEY` for updater files. Without them it builds unsigned and prints `UNSIGNED BUILD — not for distribution`. `--dry-run` prints the plan. Outputs land in `src-tauri/target/universal-apple-darwin/release/bundle/`.

The app sandbox stays OFF (it spawns CLIs in PTYs). Hardened runtime is ON (`bundle.macOS.hardenedRuntime`; Tauri applies it when signing). `Entitlements.plist` is empty by design; add `com.apple.security.cs.allow-jit` only if the notarization log asks.

## Auto-update (the one network exception)

The app otherwise makes no network calls (agent data never leaves your machine). The updater is the single exception: it fetches `latest.json` and, only when you click "Restart to update", the signed `.app.tar.gz` from the configured GitHub host. Signatures are verified against `pubkey`.

It never runs when any of these hold (decided in Rust before any request): a debug build; `pubkey` is still `REPLACE_WITH_UPDATER_PUBLIC_KEY` (or empty); an endpoint still names `OWNER/REPO` (or there is none); the user turned off "Check for updates automatically" (Town Hall panel, persisted as `settings.updatesEnabled`). Otherwise it checks 10 s after start and every 6 h. Failures are logged and invisible in the UI. After installing, the app restarts through the quit guard: with running sessions it asks first, and cancelling leaves the update installed for the next launch.

Until you replace the placeholders the shipped app is fully functional and updates itself never.

## Identifier

The bundle identifier is `dev.clashofclaudes.desktop` (until 0.2.0 it was `dev.clashofclaudes.app`, which Tauri warned about). On first launch a new build moves `~/Library/Application Support/dev.clashofclaudes.app` to `.../dev.clashofclaudes.desktop` and leaves a link at the old path (`migrate_old_data_dir` in `lib.rs`). Changing it again would need the same kind of migration. `pnpm app` keeps its own data in `dev.clashofclaudes.app.dev` regardless.

Art/trademark: no Supercell names or assets; the public name must not imply affiliation.
