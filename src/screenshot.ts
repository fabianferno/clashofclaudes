// Pictures of the whole window: the village canvas, then the DOM over it. Used by the dev driver
// (`domSnapshot`) and by bug reports.

let villageFn: (() => Promise<string>) | null = null;

/** The newest village scene registers how to capture its canvas (base64 PNG); null when none is live. */
export function setVillageSnapshot(fn: (() => Promise<string>) | null): void {
  villageFn = fn;
}

export interface CaptureOptions {
  /** Scale down to at most this many px wide. */
  maxWidth?: number;
  type?: 'image/png' | 'image/jpeg';
  quality?: number;
}

/**
 * Whole-window image (base64): the village canvas first (html-to-image cannot read WebGL), then the
 * DOM over it with a transparent background. The canvas is hidden from the DOM pass. `village`
 * defaults to the registered scene.
 */
export async function captureWindow(village: (() => Promise<string>) | null = villageFn, opts: CaptureOptions = {}): Promise<string> {
  const { toCanvas } = await import('html-to-image');
  const w = window.innerWidth, h = window.innerHeight, dpr = window.devicePixelRatio || 1;
  const k = opts.maxWidth ? Math.min(1, opts.maxWidth / (w * dpr)) : 1;
  const out = document.createElement('canvas');
  out.width = Math.round(w * dpr * k);
  out.height = Math.round(h * dpr * k);
  const ctx = out.getContext('2d')!;
  if (opts.type === 'image/jpeg') {
    ctx.fillStyle = '#2b2018'; // JPEG has no transparency
    ctx.fillRect(0, 0, out.width, out.height);
  }
  const png = village ? await village() : '';
  if (png) {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('village image failed')); img.src = 'data:image/png;base64,' + png; });
    ctx.drawImage(img, 0, 0, out.width, out.height);
  }
  // html-to-image waits on requestAnimationFrame, which never fires while the webview is hidden
  // (occluded or screen locked): run frames off a timer for the duration of the capture.
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  let dom: HTMLCanvasElement;
  try {
    dom = await toCanvas(document.body, {
      width: w, height: h, pixelRatio: dpr * k, backgroundColor: undefined as unknown as string,
      style: { background: 'transparent' },
      filter: (n) => !(n instanceof HTMLCanvasElement) && !(n instanceof HTMLElement && n.classList.contains('village')),
    });
  } finally {
    window.requestAnimationFrame = raf;
  }
  ctx.drawImage(dom, 0, 0, out.width, out.height);
  const url = out.toDataURL(opts.type ?? 'image/png', opts.quality);
  return url.slice(url.indexOf(',') + 1);
}
