import * as api from '../../../lib/api';
import { deps } from '../../../lib/board';

export const dynamic = 'force-dynamic';

export function GET() {
  return api.version(deps);
}
