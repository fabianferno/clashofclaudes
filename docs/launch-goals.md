# Launch goals

Set by the owner on 2026-10-31.

**Goal:** a solid open-source project (code under the GPL 3.0 or later, art all rights reserved, since 2026-11-13) that gets listed on [Product Hunt](https://www.producthunt.com) and featured on [git-trends](https://git-trends.github.io/).

Every decision should hold up to a stranger landing on the GitHub repo: it installs in a minute, the README shows what it does at a glance, and the code and docs look maintained.

## What that needs (status on 2026-11-13)

| Need | Status |
|---|---|
| Public GitHub repo | `fabianferno/clashofclaudes` exists (private until the owner flips it); `OWNER` placeholder replaced. The updater reads `fabianferno/clashofclaudes`, which must stay up for installed copies |
| License (`LICENSE`) | Code: GPL 3.0 or later (2026-11-13, replacing MIT, then briefly BSL 1.1, before any public push). Art, icon and name: all rights reserved (`ASSETS-LICENSE.md`). Code contributions come in under MIT (CONTRIBUTING). Third-party fonts and icons: `THIRD_PARTY_NOTICES.md` |
| README a stranger can act on: one-line pitch, hero image, install, supported agents | Done: icon, pitch, badges, hero screenshot (`docs/brand/screenshot.jpg`); a hero GIF/video is still to do |
| App icon | Knight artwork (`docs/brand/`) |
| Signed, notarized DMG on GitHub Releases | Done (v0.2.9 in the releases repo) |
| Auto-update from GitHub Releases | Done |
| `CONTRIBUTING.md`, `SECURITY.md`, code of conduct, issue/PR templates, CI running the tests on each PR | Done (CI: `.github/workflows/ci.yml`, macOS runner; first run happens on the first push) |
| Agents verified against real runs | Claude Code, Antigravity CLI. Codex and OpenCode still from docs |
| Product Hunt assets: tagline, gallery images, a short demo video, first comment | Not started |
| Name | Kept as "Clash of Claudes" (owner decision) |
