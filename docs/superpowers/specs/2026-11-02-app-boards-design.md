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

## Rendering (revised 2026-11-02: snapshots, not live previews)

The first version showed each app live in an iframe under a transparent canvas. Measured on the
owner's portfolio (Next.js dev, three.js): the preview alone cost ~6% web-process CPU, ~4% GPU-process
CPU and ~200 MB, spiked the GPU process to 107% while loading, and ran on the village's main thread
(WKWebView keeps cross-origin iframes in the same web process). The pop-out ran a second copy.

Now:
- `src-tauri/src/snapshot.rs`: one hidden, borderless window loads the page at 1280x800, waits for
  it to load plus 2.2 s, takes WebKit's snapshot at 360 pt wide (JPEG, ~25 KB), then goes to
  `about:blank`, so the app runs only those few seconds, in its own web process. The window closes
  after 45 s without a capture. Window events from it are ignored; closing the main window closes it.
- `src/state/snapshots.ts`: one capture at a time, a board's page with no picture first, then the
  stalest past 45 s; failures retried after 60 s; only while the window is visible, focused and not
  covered.
- The board draws the picture onto its screen face in its baked texture (a card until the first
  one). The canvas is opaque again; no iframes on boards.
- The live app runs only in the pop-out. While a full-window view is open (app or terminal pop-out,
  Kanban) the village stops drawing.
- Detection counts only pages: a successful or redirecting HTML response at `/` (tools' local
  servers and APIs answering 401/404/JSON are not apps).

## Layout

Boards take 2×2 spots like structures (same finder, same compound expansion), count for the
walls and walkable ground, and block structure/house drags. Their spots live in the store only
(not persisted) and move with their compound. Boards cannot be dragged (a click opens them).

## Owner checks

- Release build: confirm the pop-out shows the app from the `tauri://` origin (WebKit treats
  `http://localhost` as potentially trustworthy; only the dev origin was verified). Board pictures
  come from a top-level window, so they do not depend on this.
