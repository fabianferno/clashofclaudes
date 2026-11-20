// The board handle's own routes: Vercel wakes the watchers through GET, and a deploy registers
// them with one POST. That POST comes from the Mac that deployed, with the setup secret.
import * as api from '../../../../lib/api';
import { deps, team } from '../../../../lib/board';

export const dynamic = 'force-dynamic';

export const GET = team.fetch;

export function POST(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/watchers') && !api.mayRegister(request, deps)) {
    return Response.json({ error: 'the setup secret is missing or wrong' }, { status: 403 });
  }
  return team.fetch(request);
}
