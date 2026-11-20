import { expect, test } from 'vitest';
import type { BorrowedSession, Compound, Workspace } from '../api/types';
import { CAMP_ID, campCompound, guestCamp, isCampSession } from './guestCamp';

const ws = (id: string, c: Compound | null): Workspace => ({ id, name: id, path: '/', createdAt: 0, missing: false, compound: c, boardShared: false } as Workspace);
const at = (x0: number, y0: number): Compound => ({ x0, y0, w: 12, h: 12, house: { x: x0 + 4, y: y0 + 4 } });
const borrowed = (session: string, wait: string | null, state = 'needs_you'): BorrowedSession => ({ owner: 'ada', session, root: `msg_${session}`, builder: 'Wizard', workspace: 'shop', state, wait });

test('no borrowed builder, no camp', () => {
  expect(guestCamp([], at(0, 0))).toBeNull();
});

test('the camp is one compound with a builder for each borrowed session, standing inside it', () => {
  const c = at(40, 0);
  const camp = guestCamp([borrowed('s1', 'answer'), borrowed('s2', null, 'working'), borrowed('s3', 'review', 'finished')], c)!;
  expect(camp.workspace).toMatchObject({ id: CAMP_ID, name: 'Guest camp', compound: c });
  expect(camp.sessions.map((s) => [s.id, s.workspaceId, s.state.kind])).toEqual([['camp:ada:s1', CAMP_ID, 'needsYou'], ['camp:ada:s2', CAMP_ID, 'working'], ['camp:ada:s3', CAMP_ID, 'finished']]);
  for (const s of camp.sessions) {
    expect(s.spot).not.toBeNull();
    expect(s.spot!.x).toBeGreaterThanOrEqual(c.x0);
    expect(s.spot!.x).toBeLessThan(c.x0 + c.w);
    expect(s.spot!.y).toBeGreaterThanOrEqual(c.y0);
    expect(s.spot!.y).toBeLessThan(c.y0 + c.h);
  }
  // spots do not collide, and stay clear of the house
  const keys = camp.sessions.map((s) => `${s.spot!.x},${s.spot!.y}`);
  expect(new Set(keys).size).toBe(keys.length);
  // each stands with its owner's name on it
  expect(camp.builders.map((b) => b.name)).toEqual(['Wizard · ada', 'Wizard · ada', 'Wizard · ada']);
  expect(isCampSession('camp:ada:s1')).toEqual({ owner: 'ada', session: 's1' });
  expect(isCampSession('s1')).toBeNull();
});

test('the camp keeps its place, or finds one clear of every workspace', () => {
  const kept = at(60, 60);
  expect(campCompound([ws('w1', at(0, 0))], kept)).toBe(kept);
  const placed = campCompound([ws('w1', at(0, 0)), ws('w2', at(20, 0)), ws('w3', null)], null);
  for (const c of [at(0, 0), at(20, 0)]) {
    const apart = placed.x0 >= c.x0 + c.w || c.x0 >= placed.x0 + placed.w || placed.y0 >= c.y0 + c.h || c.y0 >= placed.y0 + placed.h;
    expect(apart).toBe(true);
  }
  // a kept place a workspace has since moved onto is given up
  expect(campCompound([ws('w1', at(60, 60))], kept)).not.toEqual(kept);
});

test('the scene draws the camp: its house and a structure for each borrowed session (the live scene walks a builder to each)', async () => {
  const { buildEntities } = await import('../village/scene');
  const camp = guestCamp([borrowed('s1', 'answer'), borrowed('s2', null, 'working')], campCompound([], null))!;
  const es = buildEntities({ workspaces: [camp.workspace], sessions: camp.sessions, builders: camp.builders });
  expect(es.some((e) => e.kind === 'house')).toBe(true);
  expect(es.filter((e) => e.kind === 'structure').map((e) => e.id)).toEqual(expect.arrayContaining(['struct:camp:ada:s1', 'struct:camp:ada:s2']));
});
