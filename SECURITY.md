# Security

Clash of Claudes runs coding agents in real terminals on your machine, so please report anything that could let a web page, another local process or a malicious repository act through it.

**Report privately** through GitHub's "Report a vulnerability" (Security tab), not in a public issue. Expect a first reply within a week.

Worth knowing when you look:

- Agent status events arrive on a localhost-only HTTP server; each session has its own random token.
- The test driver (`COC_DRIVER=1`) only ever starts in debug builds; release builds ignore the variable.
- Outbound connections: the optional update check (downloads are verified with a signing key), reports the user chooses to send (to a Discord webhook), and opt-in anonymous usage counts (to PostHog's EU cloud). Builds from source make the last two only with their own keys (`src-tauri/build.rs`).
- Approving a permission prompt from a macOS notification (`approve_if` in `sessions.rs`) answers only the prompt the notification was shown for.
