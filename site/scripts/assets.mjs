// Builds the site's images from the app's brand art. Run once after the art changes:
//   node scripts/assets.mjs [path to the app repo]
// Outputs are committed (public/img, favicons), so deploys never need the app repo.
import sharp from 'sharp';
import fs from 'node:fs';

const APP = process.argv[2] || '/Users/fabianferno/Documents/clashofclaudes';
const V = `${APP}/public/assets/village/`;
const OUT = 'public/img/';
fs.mkdirSync(OUT, { recursive: true });
const webp = (img, name, q = 82) => img.webp({ quality: q, alphaQuality: 90, effort: 6 }).toFile(OUT + name);

// Builders: 7 frames of 220x260 (idle, walk, walk, hammer up, hammer down, cheer, back).
// Re-pack each frame as a tight 130x172 cell so the CSS sprite stays small.
const FX = 50, FY = 40, FW = 130, FH = 172;
const builders = ['master-claude', 'craftsman-codex', 'apprentice-antigravity', 'craftsman-opencode'];
for (const b of builders) {
  const src = `${V}sheets/builder-${b}.png`;
  const comps = [];
  for (let i = 0; i < 7; i++) {
    comps.push({ input: await sharp(src).extract({ left: i * 220 + FX, top: FY, width: FW, height: FH }).toBuffer(), left: i * FW, top: 0 });
  }
  await webp(sharp({ create: { width: FW * 7, height: FH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comps), `builder-${b}.webp`);
}

// Tents share one box so the foundation and the finished tent line up exactly.
const tent = { left: 40, top: 100, width: 360, height: 330 };
await webp(sharp(`${V}structures/structure-foundation.png`).extract(tent), 'tent-foundation.webp');
for (const a of ['claude', 'codex', 'antigravity', 'opencode']) {
  await webp(sharp(`${V}structures/structure-complete-${a}.png`).extract(tent), `tent-${a}.webp`);
}
await webp(sharp(`${V}buildings/hall.png`).extract({ left: 130, top: 0, width: 500, height: 570 }), 'hall.webp');
for (const [i, name] of ['oak', 'pine', 'elm', 'fir'].entries()) {
  await webp(sharp(`${V}sheets/trees-sheet.png`).extract({ left: i * 200, top: 0, width: 200, height: 260 }), `tree-${name}.webp`);
}
for (const u of ['bubble-needs', 'ribbon', 'puff']) await webp(sharp(`${V}ui/${u}.png`), `${u}.webp`, 90);

// Each workspace's house, at the size the app grows it to after a few shipped sessions.
const house = { left: 70, top: 100, width: 440, height: 500 };
for (const c of ['orange', 'purple', 'blue', 'teal']) await webp(sharp(`${V}buildings/house-stage-2-${c}.png`).extract(house), `house-${c}.webp`);

// Real app screenshots, staged in a throwaway dev data folder (sample workspaces, builders and
// sessions), captured with the app's own window snapshot. Pass the folder holding village.png
// and kanban.png as the second argument; without it the committed images stay as they are.
const SHOTS = process.argv[3];
if (SHOTS) {
  const v = sharp(`${SHOTS}/village.png`);
  const { width, height } = await v.metadata();
  const box = { left: 0, top: 0, width, height: Math.min(height, Math.round(width / 1.6)) };
  for (const w of [2400, 1600, 820]) await webp(sharp(`${SHOTS}/village.png`).extract(box).resize(w), `village-${w}.webp`, 80);
  const k = await sharp(`${SHOTS}/kanban.png`).metadata();
  const kbox = { left: 0, top: 0, width: k.width, height: Math.round(k.height * 0.36) };
  for (const w of [2000, 820]) await webp(sharp(`${SHOTS}/kanban.png`).extract(kbox).resize(w), `kanban-${w}.webp`, 82);
}

// App icon (1024 with transparent margins; the artwork fills 100..924).
const icon = `${APP}/docs/brand/app-icon.png`;
await webp(sharp(icon).resize(160), 'icon-160.webp', 88);
const inner = () => sharp(icon).extract({ left: 100, top: 100, width: 824, height: 824 });
await inner().resize(32).png().toFile('public/favicon-32.png');
await inner().resize(180).flatten({ background: '#3b78d4' }).png().toFile('public/apple-touch-icon.png');
await inner().resize(256).png({ palette: true }).toFile('public/icon-256.png');
console.log('done');
