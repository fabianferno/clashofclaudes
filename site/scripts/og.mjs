// Renders public/og.png (1200x630) from the live hero, with the header hidden and the intro settled.
//   node scripts/og.mjs http://127.0.0.1:4400/
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:4400/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: `
  .hud__nav, .hud__dl, .hud__menu { display: none !important; }
  .hud { padding: 28px 56px !important; }
  .hero { min-height: 630px !important; height: 630px; padding: 96px 56px 32px !important; align-items: center; }
  .hero__title { font-size: 68px !important; }
  .hero__lede { font-size: 19px !important; max-width: 30rem; }
  .hero__copy { gap: 18px !important; }
  .hero__more, .dl__meta, .marquee { display: none !important; }
  .hero__scene { margin-top: 10px; }
  .btn { pointer-events: none; }
` });
await page.waitForTimeout(3500);
await page.screenshot({ path: 'public/og.png' });
await browser.close();
console.log('wrote public/og.png');
