import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouter, createService } from '../aws/api/service.mjs';
import { createKeeper } from '../web/keeper.cloud.js';
import { createStore } from '../web/store.js';

// The website's service, with a plain list standing in for the database, the file store and the sign-ins.
function world() {
  const items = new Map();
  const key = (pk, sk) => pk + '\n' + sk;
  const removed = { files: [], users: [] };
  const db = {
    get: async (pk, sk) => structuredClone(items.get(key(pk, sk))),
    put: async (item) => void items.set(key(item.pk, item.sk), structuredClone(item)),
    putAll: async (all) => { for (const item of all) await db.put(item); },
    del: async (pk, sk) => void items.delete(key(pk, sk)),
    // Two to a page, so everything that reads has to follow on to the next page.
    async query(pk, { prefix = '', cursor } = {}) {
      const found = [...items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix)).sort((a, b) => (a.sk < b.sk ? -1 : 1));
      const from = cursor ? Number(cursor) : 0;
      return { items: structuredClone(found.slice(from, from + 2)), next: from + 2 < found.length ? String(from + 2) : undefined };
    },
    async bump(pk, sk, field) {
      const item = items.get(key(pk, sk)) ?? { pk, sk };
      item[field] = (item[field] ?? 0) + 1;
      items.set(key(pk, sk), item);
      return item[field];
    },
  };
  const files = { putUrl: async (...args) => 'put:' + args.join('|'), getUrl: async (path) => 'get:' + path, removeAll: async (prefix) => void removed.files.push(prefix) };
  const users = { remove: async (id) => void removed.users.push(id) };
  const route = createRouter(createService({ db, files, users }));
  // What the page's `call` does: one person's requests, with a path and a query.
  const as = (user) => (method, path, body) => {
    const [where, query] = path.split('?');
    return route(user, method, '/' + where, body, Object.fromEntries(new URLSearchParams(query)));
  };
  return { as, items, removed };
}

const malee = { id: 'u-malee', name: 'Malee', email: 'malee@example.com' };
const somchai = { id: 'u-somchai', name: 'Somchai', email: 'somchai@example.com' };
const nid = { id: 'u-nid', name: 'Nid', email: 'nid@example.com' };

// A person's page on a record: the same store the other builds use, kept by the service.
async function page(call, record, user) {
  const keeper = createKeeper(call, record, { every: 0, who: user.name });
  const store = createStore(keeper);
  await store.start();
  return { api: store.api, check: keeper.check };
}

test('a record has no code until one is asked for, and the code lets anyone in as an equal', async () => {
  const { as } = world();
  const { id } = await as(malee)('POST', 'records');
  assert.equal((await as(malee)('GET', `records/${id}`)).code, null);
  await assert.rejects(as(somchai)('GET', `records/${id}`), /account\.notMember/);
  await assert.rejects(as(somchai)('GET', `records/${id}/rows`), /account\.notMember/);
  await assert.rejects(as(somchai)('POST', `records/${id}/rows`, { ops: [] }), /account\.notMember/);

  const { code } = await as(malee)('POST', `records/${id}/code`);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await as(malee)('POST', `records/${id}/code`)).code, code, 'asking again gives the same code');
  await assert.rejects(as(somchai)('POST', 'join', { code: 'AAAA-BBBB-CCCC' }), /account\.badCode/);
  assert.deepEqual(await as(somchai)('POST', 'join', { code: code.toLowerCase().replaceAll('-', ' ') }), { id });

  const opened = await as(somchai)('GET', `records/${id}`);
  assert.equal(opened.code, code, 'every member sees the code');
  assert.deepEqual(opened.members.map((m) => [m.name, m.email]), [['Malee', 'malee@example.com'], ['Somchai', 'somchai@example.com']]);
  const me = await as(somchai)('GET', 'me');
  assert.deepEqual([me.records, me.last], [[{ id, members: ['Malee', 'Somchai'] }], id]);

  const replaced = (await as(somchai)('POST', `records/${id}/code`, { replace: true })).code;
  assert.notEqual(replaced, code);
  await assert.rejects(as(nid)('POST', 'join', { code }), /account\.badCode/, 'the old code stops working');
});

test('anyone can remove anyone: the code is replaced, and the record goes only with its last member', async () => {
  const { as, items, removed } = world();
  const { id } = await as(malee)('POST', 'records');
  const { code } = await as(malee)('POST', `records/${id}/code`);
  await as(somchai)('POST', 'join', { code });
  await as(nid)('POST', 'join', { code });
  await as(malee)('POST', `records/${id}/rows`, { ops: [{ table: 'nodes', id: 1, row: { id: 1, kind: 'place', name: 'Lampang', props: {} } }] });

  assert.deepEqual(await as(nid)('DELETE', `records/${id}/members/${malee.id}`), { deleted: false });
  await assert.rejects(as(malee)('GET', `records/${id}/rows`), /account\.notMember/);
  await assert.rejects(as(malee)('POST', 'join', { code }), /account\.badCode/, 'the removed person cannot walk back in');
  const after = await as(nid)('GET', `records/${id}`);
  assert.notEqual(after.code, code);
  assert.ok(after.code, 'the others get a new code without asking');
  assert.equal((await as(nid)('GET', `records/${id}/rows`)).rows.length, 1, 'the record is untouched');

  assert.deepEqual(await as(somchai)('DELETE', `records/${id}/members/${somchai.id}`), { deleted: false });
  assert.equal((await as(nid)('GET', `records/${id}`)).code, after.code, 'leaving by choice changes no code');
  assert.deepEqual(await as(nid)('DELETE', 'me'), {});
  assert.deepEqual(removed, { files: [`records/${id}/`], users: [nid.id] });
  // What remains is only the note of which record the other two last had open; their sign-ins still stand.
  assert.deepEqual([...items.keys()].filter((key) => !key.endsWith('!last')), [], 'nothing of the record is left');
  assert.deepEqual([...items.keys()].filter((key) => key.includes(nid.id)), [], 'nor of the person who deleted their account');
});

test('two people on one record see each other\'s changes, and the log says who made them', async () => {
  const { as } = world();
  const { id } = await as(malee)('POST', 'records');
  await as(somchai)('POST', 'join', { code: (await as(malee)('POST', `records/${id}/code`)).code });
  const hers = await page(as(malee), id, malee);
  const his = await page(as(somchai), id, somchai);

  const boon = (await hers.api('POST', 'nodes', { kind: 'person', facts: { name: { given: 'Boon' }, born: { date: '2470' } } })).id;
  assert.deepEqual((await his.api('GET', 'graph')).nodes, [], 'not yet looked');
  await his.check();
  assert.deepEqual((await his.api('GET', 'graph')).nodes.map((n) => [n.name, n.born]), [['Boon', '2470']]);
  await his.api('POST', 'nodes', { kind: 'place', name: 'Phrae' });
  await hers.check();
  assert.deepEqual((await hers.api('GET', 'graph')).nodes.map((n) => n.name), ['Boon', 'Phrae']);
  assert.deepEqual((await hers.api('GET', 'log')).map((entry) => entry.by), ['Somchai', 'Malee']);

  // Both change Boon's birth year without having seen the other's change.
  const facts = (date) => ({ props: {}, facts: { name: { given: 'Boon' }, born: { date } } });
  await hers.api('PUT', 'nodes/' + boon, facts('2468'));
  await his.api('PUT', 'nodes/' + boon, facts('2469'));
  await hers.check();
  await his.check();
  for (const view of [hers, his]) {
    const born = (await view.api('GET', 'graph')).versions.filter((v) => v.field === 'born');
    assert.deepEqual(born.map((v) => [v.value.date, v.accepted]).sort(), [['2468', false], ['2469', true]], 'the later is shown, the earlier kept beside it');
    assert.equal(new Set(born.map((v) => v.fact)).size, 1, 'as versions of one fact');
  }

  // A page opened afresh reads the whole record, without the rows since removed.
  await his.api('DELETE', 'nodes/' + boon);
  const fresh = await page(as(malee), id, malee);
  assert.deepEqual((await fresh.api('GET', 'graph')).nodes.map((n) => n.name), ['Phrae']);
  await hers.check();
  assert.deepEqual((await hers.api('GET', 'graph')).nodes.map((n) => n.name), ['Phrae'], 'and an open page hears of the removal');
});

test("a source's file may be a picture or a PDF of up to 5 MB, for members only", async () => {
  const { as } = world();
  const { id } = await as(malee)('POST', 'records');
  assert.equal((await as(malee)('POST', `records/${id}/files/7`, { type: 'application/pdf', size: 1000 })).url, `put:records/${id}/files/7|application/pdf|1000`);
  assert.equal((await as(malee)('GET', `records/${id}/files/7`)).url, `get:records/${id}/files/7`);
  await assert.rejects(as(malee)('POST', `records/${id}/files/7`, { type: 'text/html', size: 10 }), /error\.fileKind/);
  await assert.rejects(as(malee)('POST', `records/${id}/files/7`, { type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }), /error\.fileTooLarge/);
  await assert.rejects(as(somchai)('GET', `records/${id}/files/7`), /account\.notMember/);
});
