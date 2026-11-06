// /llms.txt: a plain summary for AI answer engines (llmstxt.org), built from the same content file.
import type { APIRoute } from 'astro';
import { agents, faq, privacy, reel, site } from '../data/site';

export const GET: APIRoute = () => {
  const body = `# ${site.name}

> ${site.description}

${site.name} is a macOS desktop app (beta) built by ${site.studio.name} (${site.studio.url}). It runs coding agent CLIs in real terminals and shows each session as a builder in a village: each project folder is a walled compound around the Town Hall. Hammering means working, a red "!" means the agent is waiting on a permission prompt, a medal means it finished.

- Download (signed and notarized DMG): ${site.download}
- Requirements: ${site.requirements}, plus at least one agent CLI installed and signed in
- Release notes: ${site.releases}
- Contact: DM @${site.maker.handle} on X (${site.maker.x})

## What you see

${reel.map((r) => `- ${r.title.replaceAll('*', '')} — ${r.text}`).join('\n')}

## Supported agents

${agents.map((a) => `- ${a.name} (\`${a.command}\`): ${a.reports} Permission prompts: ${a.approve}${a.verified ? '' : ' (built from its docs; testers are confirming it)'}`).join('\n')}
- Any other command: working while it prints, finished after it goes quiet, stuck if it errors or stays silent too long.

## Privacy

${privacy.map((p) => `- ${p.title}: ${p.text}`).join('\n')}

## FAQ

${faq.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n')}

## Pages

- [Home](${site.url}/): what the app does, a 43-second ad and its features in real footage, the agents it supports, FAQ
- [Beta guide](${site.url}/beta/): install, first village, sending feedback, updates, known limits
- [Privacy](${site.url}/privacy/): what the app touches, sends and never does

Not affiliated with Anthropic, OpenAI, Google, xAI or the OpenCode team.
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
