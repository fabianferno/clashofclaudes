import * as api from '../../../lib/api';
import { deps } from '../../../lib/board';

export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return api.pair(request, deps);
}
