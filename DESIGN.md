# Clash of Claudes site: design record

Built with the `awwwards` skill. The owner asked not to be asked anything, so every decision
below was made without them and is written down here so it can be changed later.

## Brief (Phase 0)

- **Subject:** Clash of Claudes, a macOS desktop app (Tauri) that shows every running coding
  agent session (Claude Code, Codex, Antigravity CLI, OpenCode, or any command) as a builder in
  an isometric village. Each workspace is a walled compound; each session a builder raising a
  tent in it.
- **Audience:** the owner's friends, mostly developers who already run two or more agent CLIs.
- **Job:** get them to download the beta DMG, install it in under a minute, and send bugs and
  feature requests from inside the app.
- **Assets:** app icon (knight), one real screenshot, the painted game art (builders, tents,
  Town Hall, trees, status bubbles). Font Lilita One (the app's UI font).
- **Constraints:** source is private (no "open source", no repo link, no stars, no license).
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

Agent colours come from the app (`PALETTE` in `look.ts`): Claude `#d97757`, Codex `#3a3a40`,
Antigravity `#4f7cf0`, OpenCode `#33a889`. They are used only to tag each agent.

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
