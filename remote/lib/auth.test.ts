import { expect, test } from 'vitest';
import { signedBy } from './auth';
import { FakeBoard, phone, record } from './fake';
import { Records } from './records';

const NOW = 1_800_000_000_000;

async function setup() {
  const board = new FakeBoard();
  const p = await phone();
  record(board, 'ada', p.key, p.pub);
  const records = new Records(board, () => NOW);
  const ask = async (headers: Record<string, string>, method = 'GET', path = '/api/queue', body = '') =>
    signedBy({ method, path, headers: new Headers(headers), body: new TextEncoder().encode(body) }, records, () => NOW);
  return { board, p, ask };
}

test('a request signed by a paired phone passes', async () => {
  const { p, ask } = await setup();
  expect(await ask(await p.headers('ada', 'GET', '/api/queue', NOW))).toEqual({ owner: 'ada', key: p.key, record: 'msg_1' });
  const body = '{"a":1}';
  expect(await ask(await p.headers('ada', 'POST', '/api/act', NOW - 60_000, body), 'POST', '/api/act', body)).not.toBeNull();
});

test('anything else does not', async () => {
  const { p, ask, board } = await setup();
  expect(await ask({})).toBeNull();
  expect(await ask(await p.headers('ada', 'GET', '/api/queue', NOW - 180_000))).toBeNull();
  expect(await ask(await p.headers('ada', 'GET', '/api/queue', NOW + 180_000))).toBeNull();
  // signed for another path, method or body
  expect(await ask(await p.headers('ada', 'GET', '/api/other', NOW))).toBeNull();
  expect(await ask(await p.headers('ada', 'GET', '/api/queue', NOW), 'POST')).toBeNull();
  expect(await ask(await p.headers('ada', 'POST', '/api/act', NOW, '{"a":1}'), 'POST', '/api/act', '{"a":2}')).toBeNull();
  // a phone paired with ada asks for bob's village
  expect(await ask(await p.headers('bob', 'GET', '/api/queue', NOW))).toBeNull();
  // a village that does not exist is never read
  const reads = board.reads;
  for (const o of ['nobody1', 'nobody2', 'nobody3']) expect(await ask(await p.headers(o, 'GET', '/api/queue', NOW))).toBeNull();
  expect(board.reads).toBeLessThanOrEqual(reads + 1);
  // a key nobody paired
  const stranger = await phone();
  expect(await ask(await stranger.headers('ada', 'GET', '/api/queue', NOW))).toBeNull();
  // an owner that is not a username never reaches the board
  expect(await ask({ ...(await p.headers('ada', 'GET', '/api/queue', NOW)), 'x-coc-owner': '../x' })).toBeNull();
  expect(await ask({ ...(await p.headers('ada', 'GET', '/api/queue', NOW)), 'x-coc-ts': 'soon' })).toBeNull();
});
