# Clash of Claudes site

Landing and download page for the Clash of Claudes macOS beta. Astro 7 (static), GSAP, Lenis.
Design record and decisions: `DESIGN.md`. All copy and links: `src/data/site.ts`.

```sh
pnpm install
pnpm build            # needs Node >= 22.23.4 (Astro 7)
pnpm preview          # serves dist/
```

Deploys: every push to `main` in the app repo builds this folder on Vercel (project `clashofclaudes`,
Root Directory `site`, served at https://clashofclaudes.crevn.xyz). Pushes that change nothing under
`site/` skip the build. Other branches get preview URLs. For a manual deploy, run `vercel --prod`
from the repo root, not from `site/`.

- Images are built from the app's art by `node scripts/assets.mjs [path/to/app]` and committed.
- `node scripts/og.mjs http://127.0.0.1:4321/` re-renders `public/og.png` from the running hero.
- The download button always points at
  `github.com/fabianferno/clashofclaudes/releases/latest/download/Clash-of-Claudes.dmg`;
  the version label is read from the GitHub API in the browser and hidden if that fails.
