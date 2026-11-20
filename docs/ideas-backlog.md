# Ideas backlog

Parked on 2026-11-10 from a product brainstorm. Nothing here is decided: the owner will go
through it to keep or drop each one. Already built from the same list: elixir that drives
decisions (forecast, reserve, stand-ins), app-wide sounds (Settings › Sounds), the menu bar
mini-village, opening a plan from the briefing for review, day and night from the clock, the village ambience,
sounds for XP and level-ups, a notepad per workspace, and the daily raid report (2026-11-20).

## Later, or worth a debate

- **Pipelines.** "When Claude finishes, Codex reviews it" as a drag-to-chain blueprint; reusable
  task templates (write tests, fix lint, review) as blueprint scrolls.
- **A forge that shows what runs in it.** A watchtower with a lit beacon while a dev server runs,
  a training dummy for tests, a scribe for an editor, a messenger for ssh. Needs the foreground
  command (the group leader's arguments), read in the session code. Skipped on 2026-11-20 to see
  how the plain forge does first.
- **Phone approvals** and **shared team villages.** Both big, and both clash with the privacy
  model. Probably skip for now.

## Publishing: the forge (2026-11-20)

Terminals stand as forges, not rune stones (commits `ce87d49`, `46266d2`, `16e802a`), and night
lights no longer glow by day (`8506e8c`). None of it is released yet.

- **Release it.** Ship a release with the forge and the night-light fix (`docs/release.md`).
- **Push the site after the release.** `28e850b` says "Terminals = forges" on the feature card and
  in the feature list; pushing `main` deploys the site, so push once the release is out.
- **New footage of a forge.** The reel's `stones` clip (`site/public/reel/`) still shows a rune stone
  under the "forges" card. Record a forge (hot, embers, cold, smoke and sparks) and cut a new loop.
- **The ad.** Its footage shows rune stones. Re-record those shots, or leave the ad as it is. Its
  description (`site/src/pages/index.astro`) and the trailer lede (`Trailer.astro`) list what the
  footage shows, so they dropped the rune stone; add the forge back to both once the footage has one.
- **Build the site locally.** Astro needs Node 22.23.4 or newer; this Mac has 22.23.1.
