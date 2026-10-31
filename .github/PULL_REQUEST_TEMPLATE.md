## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## How I checked it

- [ ] `pnpm exec tsc --noEmit && pnpm test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- [ ] Ran it with `pnpm app` (screenshot for visual changes)

## Ground rules

- [ ] Nothing writes to `~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode` or a project's agent config
- [ ] No new network connections
