# Security

Clash of Claudes runs coding agents in real terminals on your machine, so please report anything that could let a web page, another local process or a malicious repository act through it.

**Report privately** through GitHub's "Report a vulnerability" (Security tab), not in a public issue. Expect a first reply within a week.

Worth knowing when you look:

- Agent status events arrive on a localhost-only HTTP server; each session has its own random token.
- The test driver (`COC_DRIVER=1`) only ever starts in debug builds; release builds ignore the variable.
- The only outbound connection is the optional update check, verified with a signing key.
