# Clash of Claudes site: design record

Built with the `awwwards` skill. The owner asked not to be asked anything, so every decision
below was made without them and is written down here so it can be changed later.

## Brief (Phase 0)

- **Subject:** Clash of Claudes, a macOS desktop app (Tauri) that shows every running coding
  agent session (Claude Code, Codex, Antigravity CLI, OpenCode, Grok Build, or any command) as a builder in
  an isometric village. Each workspace is a walled compound; each session a builder raising a
  tent in it.
- **Audience:** the owner's friends, mostly developers who already run two or more agent CLIs.
- **Job:** get them to download the beta DMG, install it in under a minute, and send bugs and
  feature requests from inside the app.
- **Assets:** app icon (knight), one real screenshot, the painted game art (builders, tents,
  Town Hall, trees, status bubbles). Font Lilita One (the app's UI font).
- **Constraints:** the source is public under the Business Source License 1.1 (since 2026-11-13).
  Call it "source available" or "the source is on GitHub", never "open source" (the BSL is not an
  OSI license). The footer links the repo; the FAQ explains the license in plain words.
  Not affiliated with Anthropic, OpenAI or Google. No reference to any existing game brand.
  Download URL is the stable `releases/latest/download/Clash-of-Claudes.dmg`.

### Assumptions (owner may change)

- The beta is not called "free" anywhere: pricing was not stated.
- No email or social links: feedback goes through the app (Help menu, Settings), as the owner
  described. The public releases page is the only external link.
- Builder ranks shown on the site follow the app code (`src/village/look.ts`): the model picks
  the rank (Apprentice, Craftsman, Master), effort picks the hammer. The roster shows one rank
  per agent purely for variety.
- Codex and OpenCode support is described honestly as "written from their docs, waiting for
  real runs", as the README says. Beta testers are asked to help confirm it.

## Concepts (Phase 1)

| | Idea | Anchor | Signature | O / F / Fe / P |
|---|---|---|---|---|
| A. Process | The page plays one agent session from first task to shipped: a builder walks onto an empty plot, hammers, raises a "!" when it needs you, and cheers when the tent stands | the app's real status model (working, needs you, finished) drawn as builder animations | sticky stage: scroll drives the session through its states while the tent rises from its foundation | 4 / 5 / 4 / 1 |
| B. Formal | The site is a game HUD: corner pills count real things as you read (builders met, sessions shipped) | the app's top bar ("Builders busy", "Shipped today") | counters tick as sections are read | 3 / 4 / 5 / 3 |
| C. Place | The page is a walk through the village from the forest edge to the Town Hall | the screenshot's ring of forest around a clearing | tree line parts as you scroll in | 3 / 3 / 3 / 3 |

**Pick A.** Only this product turns agent status into a builder's day, and it explains the app
better than any feature list. **Stolen from B:** the stage's "Shipped today" HUD pill ticks
from 0 to 1 when the session finishes. **Stolen from C:** the forest tree line is the page
transition and the edge of the footer.

## Concept card

```
Idea:        Every agent session is a builder; the page plays one session from first task to shipped.
Metaphor:    a cozy isometric building game, where status is something you see, not read.
Signature:   sticky "one session" stage: scroll walks a builder through Idle, Working, Needs you,
             Allowed, Finished; the tent rises out of its foundation, a "!" bubble pops, the builder
             cheers and the Shipped today counter ticks. (motion.md pinned chapters, done with
             CSS sticky + ScrollTrigger chapter toggles; src/motion/session.ts)
Emotion:     the warm "oh, it's a little game" smile, then "oh, that's actually how I'd want to see my agents".
Motion verb: place and settle. Things land like a building placed on the map: drop a little, squash,
             settle, with a puff of dust. Buttons press down like chunky game buttons.
Screenshot:  the hero: the game-title headline beside a living plot with the Town Hall, four agent
             tents and four builders, one hammering, one with a red "!" over its head, one cheering.
```

## Art direction (Phase 2)

### Palette (from the game art, not from a trend)

| Role | Hex | Source |
|---|---|---|
| `meadow` (ground, hero and stage) | `#5d9a35` | the village grass in the screenshot |
| `meadow-lit` (plots, highlights) | `#7cb64a` | sunlit grass |
| `forest` (dark ground, curtain, footer) | `#11301a` | the pine ring around the village |
| `ink` (text, outlines) | `#18210f` | the dark outline on every sprite and HUD pill |
| `parchment` (panels, text on forest) | `#f7ead0` | the builder roster cards |
| `gold` (CTA, focus ring) | `#ffc53a` | crowns, pennants, the "finished" medal |
| `alert` (needs you, used only for that state) | `#e2453a` | the "!" bubble |

Agent colours come from the app (`PALETTE` in `look.ts`): Claude `#d97757`, Codex `#e6e3dc`,
Antigravity `#4f7cf0`, OpenCode `#33a889`, Grok Build `#3a3a40`. They are used only to tag each agent.

### Type

- **Display:** Lilita One (the app's own UI font, self-hosted). Set like a game title: parchment
  fill, 0.06em ink outline painted under the fill (`paint-order: stroke fill`), hard ink drop
  shadow straight down. Tracking -0.01em (Lilita is already tight); leading 0.95.
- **Text and UI:** Host Grotesk 400 to 700 (Google, OFL, variable). Calm and readable next to a
  loud display face. Body 17 to 18 px, leading 1.55.
- **Code (agent commands):** the system monospace stack, tiny and functional only.

### Grid and rhythm

12 columns, fluid gutter, outer margin = gutter. Two strong verticals: column 1 (all text starts
here) and column 7 (scenes and media start here). Section moods: hero full viewport, statement
airy, stage tall (sticky, 4 chapters), roster normal, village tight, privacy normal, beta airy,
footer full.

### Shape

One rule: game UI. Every panel, pill and button is a rounded rectangle (`--radius: 14px`, pills
fully round) with a 3px ink outline and a hard 4px ink shadow straight down. Nothing soft, no
blur shadows, no glass.

### Motion language

- Eases from the engine: `expo.out` for entrances, `expo.inOut` for the transition, `back.out`
  only for the "place and settle" landing of sprites and bubbles.
- Durations: hover 0.25 s, sprite landings 0.7 s, text lines 1.1 s, curtain 0.8 s each way.
- Treatments (one per role):
  - **Primary buttons:** chunky press. Hover lifts 3px and the shadow grows; active presses
    down 3px and the shadow disappears. Under reduced motion: fill brightens instead.
  - **Nav links:** label roll inside the pill.
  - **Roster cards:** the builder is "picked up": it hops and switches to the cheer frame.
  - **Inline links:** underline at rest that thickens into a gold band.
- Idle: builders in the hero and the stage run their own sprite loops (hammer, bubble bob).
  These are CSS `steps()` keyframes on `background-position`, not JS loops; they stop under
  reduced motion and show the idle frame.
- Transition between pages: the forest closes in. A forest-green panel with a scalloped tree
  line edge rises from the bottom, then lifts off the new page.

### Composition plan

```
HERO (scene / split frame)          meadow
[icon Clash of Claudes BETA]          [How it works  Agents  Beta guide] [Download]
 Run all your coding                 .-----------------------------.
 agents from one village.            |   tree  tree    tree         |
 lede (2 lines)                      |  tent  HALL  tent  builders  |
 [Download for Mac] macOS 13+...     |   tent       tent  ! bubble  |
 version                             '-----------------------------'

STATEMENT (statement)               parchment
           Twelve terminal tabs can't tell you who is waiting.  (cols 1-9, t-xl)
           paragraph (cols 5-10)

STAGE (sticky narrative, 4 chapters) meadow
 chapter text scrolls (cols 1-5)  | sticky stage (cols 7-12): plot, tent, builder, HUD

ROSTER (cards, the app's own roster UI) forest
 h2 cols 1-6 + note           four parchment cards with builder, agent, command, support
 custom command line

VILLAGE (full-bleed media + list)    meadow-dark
 real screenshot, cols 1-8, in an ink frame | list of what you see, cols 9-12

PRIVACY (facts)                      parchment
 h2 "Your agents' work stays on your Mac"   4 facts in a 2x2 with real paths in code

BETA (sequence: steps are real)      meadow
 1 Download 2 Drag 3 Launch | feedback from the Help menu | requirements

FOOTER (finale)                      forest with tree line edge
 Raise your village.  [Download for Mac]   links   not-affiliated note
```

Inner pages: `/beta/` (beta guide: install, first run, feedback, updates, requirements, FAQ),
`/privacy/` (what the app does and never does on your Mac), designed `/404`.

### Genericness test

- A generic model would ship a dark SaaS page with a gradient and three feature cards. Changed:
  the whole page is the game's world (meadow, forest, parchment), the type is the app's font set
  as a game title, and the feature explanation is the stage, not cards.
- The roster cards are four equal cards, which is a tell. Kept on purpose: they copy the app's
  own builder roster (the screenshot's bottom bar), with the real support matrix inside.
- The "1 2 3" install steps are a real sequence, so the numbers stay.

## Stack

**Astro 7 (static)**, GSAP + ScrollTrigger + SplitText, Lenis. Reason: a content-only launch
page where motion is the product; static HTML is the fastest thing to serve and needs no
server. No WebGL: the art is painted sprites, and GL would add weight without adding meaning.
No loader: a product page earns the craft, not the theatre.

## Decisions made without the owner

- Version label: fetched client-side from the GitHub releases API, silent on failure (the repo
  may not exist yet). Without it the button still works.
- No analytics, no cookies, nothing to consent to.
- No newsletter or email capture: the brief is a download and in-app feedback.
- Not-affiliated note in the footer, naming the agent makers.

## QA record

- Production builds checked with the awwwards `shoot.mjs --crawl --nav` and `audit.mjs`, plus
  the gstack `browse` skill against the live URL (menu focus trap, Escape, download href).
- Still at rest by decision: the privacy page's builder stands idle (the page is a reference
  document; the hover and the transition carry the life there).
- Critic pass 1 (separate subagent): 7.1 weighted (Design 7, Usability 7, Creativity 7,
  Content 8, all developer areas 7 to 8). Fixes applied in pass 2: doc page heroes rebuilt,
  TOC marks the current section, the HUD gets a solid bar once scrolled, the statement got its
  "tabs vs builder" figure, phone hero puts the village under the headline, mobile wraps fixed.
- Critic passes 2 and 3 (fresh subagents each time): 7.1 weighted both times (Design 7,
  Usability 7, Creativity 7, Content 8; developer areas 7 to 8). After pass 3: phone hero puts the
  CTA right under the village, phone chapters align with the stage, bigger chapter titles,
  tighter village section.
- Version label: baked in at build time from the GitHub API, refreshed in the browser on the home
  page only, cached for an hour in localStorage. During QA the test machine's IP hit GitHub's
  unauthenticated rate limit (60/h), so the crawl logged 403s in the console; real visitors make
  at most one call an hour. Decision: keep the refresh so the label is never stale after a release.

## Revision 2 (2026-11-04, owner request)

The owner asked for: the domain clashofclaudes.crevn.xyz, no "white patches" in the art, current
screenshots, more effects, "Built by crevn.xyz" and an X contact, and proper SEO and AEO.

- **Domain:** `site.url` and `astro.config.mjs` now use https://clashofclaudes.crevn.xyz (canonical,
  OG, sitemap, robots, JSON-LD). DNS is an A record in Cloudflare (`clashofclaudes` → 76.76.21.21, DNS
  only). clashofclaudes.vercel.app 308-redirects to it, set on the Vercel project's domain
  settings (a vercel.json host redirect is ignored for this static build).
- **White patches:** the sprites themselves had no halos, checked on meadow green in Chromium and
  WebKit. What read as white patches were the bare pale foundation tarps: two in the hero, a big
  one on the stage, one on the beta page. They are now `RisingTent.astro`, the finished tent
  revealed from the ground up (`--rise`). The stage tent climbs with the chapters (0.32, 0.55,
  0.78, 1). The 404 page keeps its empty plot on purpose ("This plot is still empty").
- **Current art:** the hero now draws a compound per workspace, as the app does today: the
  workspace's house (`house-*.webp` from `house-stage-2-<colour>`), the agent's tent and its
  builder, on a patch of bare earth.
- **Screenshots:** `village-*.webp` and `kanban-*.webp` are the real app (dev build, throwaway
  data folder, staged sample workspaces and sessions), captured with the app's own window snapshot
  with the builder portraits composited in. `scripts/assets.mjs <app> <shots dir>` rebuilds them.
- **New signature (two):** "The real app, up close". The section pins while a camera flies over
  the real window, stopping on five points of interest (`tour` in site.ts, `src/motion/tour.ts`),
  with a ring pulsing on each. Under reduced motion it shows the full window and all stops as a
  list.
- **Effects:** cloud shadows drift over the hero meadow; the hero village leans toward the pointer
  in depth layers; a builder strolls the path; tents rise while builders hammer; the Kanban shot
  stands up from the table on scroll; clicks kick up a puff of dust; fireflies drift in the
  footer forest. All of it is off under reduced motion.
- **Credits and contact:** the footer has "Built by crevn.xyz" and a "DM @fabianferno on X" button.
  The FAQ points there too. This replaces the earlier "no socials" assumption.
- **SEO and AEO:** one JSON-LD graph per page (Organization Crevn, Person Fabian Ferno,
  WebSite, SoftwareApplication with featureList and softwareVersion), FAQPage on home (nine
  questions people actually search, answered in full on the page), BreadcrumbList on inner pages,
  `twitter:site` and `twitter:creator`, and `/llms.txt` generated from the content file. robots.txt
  allows every crawler. The hero lede and the doc ledes render without waiting for JS, so the
  throttled phone LCP is 0.7 s on home (was 3.75 s).

## Polish pass (2026-11-05, impeccable)

The owner said the page read as "vibecoded". What caused it, and what changed:

- **Bug:** GSAP folds a sprite's CSS `translate` into its own transform when it animates the
  landing, and lost the `-100%`. Every hero house, tent and builder sat one full height below its
  plot. Hero sprites are now anchored with `left`/`bottom` (no translate).
- **Cloud shadows** were clipped by the scene's box and showed a hard vertical edge. They are now
  clipped to the land diamond.
- **One costume, not ten:** the outlined game title is kept for the hero, the footer finale and
  the inner page heroes. Section titles are set plain (ink on meadow, parchment on forest). The
  hard ink lip stays on the game buttons only; panels, cards, the stage and the screenshots rest
  on `--lift-shadow` (a hairline and a long soft drop).
- **Display face at display sizes only:** small headings (tour stops, Kanban notes, privacy
  facts, beta panel, FAQ) use Host Grotesk 600 to 700, not Lilita.
- **Fewer labels:** no "1 of 4" eyebrow over chapters; agent rank is a plate on the card's tile;
  the check status is a dotted line, not a coloured box; the version is text, not a pill.
- **Lists, not cards:** FAQ is a ruled list on the forest; install steps are a ruled sequence;
  the footer contact is a plain line (no dashed box); footer links underline on hover only.
- **Phone hero:** the lede now comes before the download button.

## One screen per section (2026-11-05, owner request)

On desktop and landscape tablets (wider than 860px, taller than 600px), the hero, statement,
agents, tour, Kanban, privacy, FAQ, beta and footer each fill exactly one viewport, content centred
below the HUD. Titles, the hero scene, card tiles, the Kanban shot and FAQ rows are capped in `svh`
so nothing overflows down to 1366x768; short sections (statement, privacy) scale up instead.
Checked at 1280x800, 1366x768, 1440x900 and 1920x1080. The session stage stays a scroll story.
Phones keep the natural flow: four agent cards and nine questions do not fit on one phone screen.

## Centred hero and wider margins (2026-11-05, owner request)

- **Hero:** the headline, lede and download sit centred. The village floats around them
  (`HeroScene.astro`): trees, a house per workspace, tents and the four builders in their states,
  in three depth layers that drift against the pointer (`src/motion/hero.ts`), each piece bobbing
  on its own slow cycle with a soft drop shadow. Pieces are sized in `min(1vw, 1.7svh)` so they
  never grow into the copy on a short screen. Phones show the Town Hall, two houses and two
  builders along the bottom, below the copy.
- **Margins:** `--gutter` (the page margin) is now `max(clamp(1.375rem, 5.5vw, 7rem), (100vw - 1280px) / 2)`,
  so content keeps clear of the edges and never runs wider than 1280px. Column gaps are a separate,
  tighter `--col-gap`.

## Agents as a network (2026-11-05, owner request, after october.dev's "agents talk" section)

The agents section is now a graph: the app's icon ("Your village") in the middle, the four agents'
real marks around it on parchment tiles (`AgentLogo.astro`, the same marks and tiles as the app's
`src/agentMarks.ts`), joined by dotted lines. `src/motion/agents.ts` plays one report at a time:
the agent's bubble opens with a state in the app's words (needs you, working, finished, stuck),
a gold dot travels its line, the village icon takes it with a bump. It loops while the section is
on screen. Unlike the reference, agents do not talk to each other here: the app does not do that,
so each one reports to the village. Under reduced motion the graph is still and every bubble stays
open (phones hide them, since they would stack). The facts per agent sit under the graph as a
five-column list, the fifth being "Any command".

## Shaped like the ad (2026-11-05, owner request)

The owner liked the 43-second ad (made with the brag skill, `brag-output/` in the app repo) and asked
for the page to follow it, keeping "Bring the agents you already use".

- **Hero:** the copy stays as it was ("Run all your coding agents from one village."); the owner
  tried the ad's "All builders busy." hook there and asked for the original text back. The floating
  village keeps its depth layers, now with parallax on scroll as well (far trees lag, builders
  lead), on phones too.
- **The ad** follows the hero (`Trailer.astro`): poster with a gold Play label, sound on, native
  controls, pauses when scrolled away. Nothing downloads until it is played.
- **Feature reel** (new signature, `Reel.astro`, `src/motion/reel.ts`): the ad's beats as a scroll
  story. Nine beats on the left (every session is a builder, needs you, outfits, ranks and hammers,
  elixir, minions, rune stones and boards, levelling up, the Kanban), a sticky frame on the right
  playing each beat's loop of real app footage (`public/reel/*.mp4`, cut from the ad's raw shots,
  about 5 MB in all, each loaded only when its beat comes up). The Kanban beat pans the real
  screenshot. The active beat is read from live positions on every scroll. Phones pin the frame to
  the top and scroll the beats under it. The section is parchment (owner asked for a change from
  dark green): ink titles with the ad's key word on a gold band.
- **Removed:** the statement ("Four agents in four repos..."), the one-session stage, the window
  fly-over tour and the separate Kanban section. Their facts live on in the reel, the agents
  section and the FAQ.
- **Hero follow-ups:** the lede says "Agent sessions" instead of listing the agents, and a looping
  strip of the supported agents (logo pills, pauses on hover, still and wrapped under reduced
  motion) sits under it. The headline is 20% smaller. No "isometric" in visitor-facing copy.
- `llms.txt` lists the reel beats; the SoftwareApplication `featureList` names the new features.
