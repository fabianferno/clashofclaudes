# App boards: live previews of the apps running in a workspace

Owner request (2026-11-02): "another structure, like a board, to preview any app opened, like a
browser. It shows a small preview on it; when clicked it opens", then: "when I click on the preview
it must open in a pop out like how the session pop out works today". The owner skipped the design
questions; the calls below are the builder's.

## What it does

- Every local web app running in a workspace gets a **board** in that workspace's compound: a
  wooden panel on posts, made up as a browser window, whose screen shows the app **live**.
- A name bar over the board shows the page title (or the process name) and the port.
- **Click** a board: the app pops out full-window over the village (same overlay as the session
  pop-out: title, Reload, Open in browser, ✕; Esc closes it).
- A page that forbids framing (`X-Frame-Options`, CSP `frame-ancestors`) gets a card on the board
  (its name and an ↗) and a click opens it in the system browser instead, since it would pop out blank.
- The board goes away when the server stops.

## Opening a browser yourself

Owner request: "I must also be able to open a browser just like how we do the terminal and the
session". The workspace panel has **+ Browser** next to + Terminal: it asks for an address
(`localhost:3000` by default; bare hosts get `http://`, only http(s) is accepted), puts up a board
for it and pops it out at once. The pop-out's address is editable (Enter goes there; an opened
browser's board follows). The panel lists every board under "Browsers": the owner's own (with ✕
to close) and the apps running there. Opened browsers live in the store only, like sessions they
do not survive a restart. A detected app at the same address as an opened browser is not shown
twice (the opened one stands for it). Opened browsers are assumed frameable (no probe); a site
that refuses framing shows blank and "Open in browser" is the way out.

## Detection (src-tauri/src/apps.rs)

Every 4 s: `lsof` lists listening loopback/wildcard TCP sockets and their processes' working
folders. A socket belongs to a workspace when its process works inside the workspace folder or a
session's worktree (deepest root wins). Each new (pid, port) gets one HTTP probe (`GET /`, 1.5 s);
non-HTTP ports are retried after 20 s. Results go out as `apps-updated`; `get_apps` returns the
latest. Excluded: the app's own process and, in dev builds, its own dev server port.

This catches servers however they were started (an agent's background shell, a terminal session,
or a shell outside the app) without parsing anyone's output.

## Rendering

- The village canvas is transparent (`backgroundAlpha: 0`; the host paints the same green).
- Each live board has an iframe under the canvas, laid onto the board's screen with a CSS matrix
  every frame (follows camera, drags and compound moves). The page is laid out at 1280 px wide.
- Right after the board sprite, a `hole` sprite with blend mode `erase` cuts the screen out of the
  canvas, so the iframe shows through and anything standing in front still covers it.
- Preview iframes are sandboxed (`allow-scripts allow-same-origin allow-forms`), take no pointer
  events or focus; the pop-out's iframe also allows modals, popups and downloads.

## Layout

Boards take 2×2 spots like structures (same finder, same compound expansion), count for the
walls and walkable ground, and block structure/house drags. Their spots live in the store only
(not persisted) and move with their compound. Boards cannot be dragged (a click opens them).

## Owner checks

- Release build: confirm the preview shows from the `tauri://` origin (WebKit treats
  `http://localhost` as potentially trustworthy, so it should not count as mixed content; only
  the dev origin was verified).
