// The latest release tag, read once at build time so the page ships with it baked in.
// Any failure (repo missing, rate limit, offline build) leaves it empty; the label stays hidden.
import { site } from './site';

async function latestTag(): Promise<string> {
  try {
    const r = await fetch(site.latestApi, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return '';
    const j = (await r.json()) as { tag_name?: unknown };
    const tag = typeof j.tag_name === 'string' ? j.tag_name.trim() : '';
    return /^v?\d+(\.\d+){0,3}([-.+][\w.]+)?$/.test(tag) ? (tag.startsWith('v') ? tag : `v${tag}`) : '';
  } catch {
    return '';
  }
}

export const builtVersion = await latestTag();
