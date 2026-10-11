import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp, openDb } from '../server.js';
import { createStore } from '../web/store.js';

// The browser's store has to keep the record exactly as the server does, so both are given the same
// changes and must end with the same record. Ids differ, so each is compared by its place in its table.
let app, base;
before(async () => {
  app = createApp(openDb(':memory:'));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}/api/`;
});
after(() => app.close());

async function server(method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function memoryStore() {
  const written = [];
  const store = createStore({ start: async () => {}, write: async (ops) => void written.push(...ops) });
  return { api: store.api, written };
}

// The same family history, told to either keeper.
async function story(api) {
  const person = async (given, family, extra = {}) => (await api('POST', 'nodes', { kind: 'person', facts: { name: { given, family }, ...extra } })).id;
  const somchai = await person('Somchai', 'Srisai', { born: { date: '2490' }, sex: { sex: 'male' } });
  const malee = (await api('POST', 'relatives', { person: somchai, relation: 'partner', other: { facts: { name: { given: 'Malee', family: 'Kaewta' } } }, takeName: 'other', married: '2515' })).id;
  const household = (await api('GET', 'graph')).nodes.find((n) => n.kind === 'household').id;
  const child = (await api('POST', 'relatives', { person: somchai, relation: 'child', other: { facts: { name: { given: 'Nid' } } }, household, kind: 'adopted' })).id;
  await api('POST', 'relatives', { person: child, relation: 'sibling', other: { facts: { name: { given: 'Noi' } } } });
  await api('POST', 'relatives', { person: somchai, relation: 'parent', other: { facts: { name: { given: 'Boon' } } } });
  await api('PUT', 'nodes/' + malee, { props: { nickname: 'Lek' }, facts: { name: { given: 'Mali' }, born: { date: '2495' }, sex: { sex: '' } } });

  const place = (await api('POST', 'nodes', { kind: 'place', name: 'Chiang Mai' })).id;
  const born = (await api('POST', 'versions', { node: somchai, field: 'BORN_IN', target: place })).id;
  const source = (await api('POST', 'sources', { kind: 'certificate', title: 'Birth certificate', note: 'copy' })).id;
  const fact = (await api('GET', 'graph')).versions.find((v) => v.id === born).fact;
  const rival = (await api('POST', 'versions', { node: somchai, field: 'BORN_IN', target: place, fact, accordingTo: 'an aunt', accordingNode: malee, sources: [source] })).id;
  await api('POST', `versions/${rival}/accept`);
  await api('PUT', 'versions/' + born, { value: { note: 'doubtful' }, sources: [source] });
  await api('DELETE', 'versions/' + rival);
  await api('PUT', 'sources/' + source, { kind: 'register', title: 'House register' });
  await api('DELETE', 'sources/' + source);
  await api('PUT', 'colors', { family: { Srisai: '#aa0000' } });
  await api('DELETE', 'nodes/' + malee);

  const undo = async (action) => api('POST', `log/${(await api('GET', 'log')).find((entry) => entry.summary.action === 'removed' && !entry.undone && action(entry.summary)).id}/undo`);
  await undo((s) => s.kind === 'person');
  await undo((s) => s.kind === 'source');
  await assert.rejects(api('POST', 'relatives', { person: child, relation: 'parent', other: { facts: { name: { given: 'Third' } } } }), /rel\.twoParents/);
  await assert.rejects(api('POST', 'versions/999999/accept'));
  return { graph: await api('GET', 'graph'), log: await api('GET', 'log') };
}

function byPlace({ graph, log }) {
  const place = (rows) => new Map([...rows].sort((a, b) => a.id - b.id).map((row, i) => [row.id, i]));
  const [nodes, versions, sources] = [place(graph.nodes), place(graph.versions), place(graph.sources)];
  const at = (map, id) => (id === null ? null : map.get(id));
  const sorted = (rows) => [...rows].sort((a, b) => a.id - b.id);
  return {
    nodes: sorted(graph.nodes).map(({ id, photo, ...node }) => ({ ...node, photo: !!photo })),
    versions: sorted(graph.versions).map((v) => ({
      ...v, id: at(versions, v.id), fact: at(versions, v.fact), node: at(nodes, v.node), target: at(nodes, v.target),
      accordingNode: at(nodes, v.accordingNode), sources: v.sources.map((id) => at(sources, id)),
    })),
    sources: sorted(graph.sources).map(({ id, ...source }) => source),
    colors: graph.colors,
    log: log.map(({ summary, undone, removable }) => ({ summary, undone: !!undone, removable: !!removable })),
  };
}

test('the browser store keeps the same record as the server', async () => {
  const { api, written } = memoryStore();
  assert.deepEqual(byPlace(await story(api)), byPlace(await story(server)));
  assert.ok(written.length, 'changes are handed to the keeper');
});

test("a source's file goes with the source and comes back with it", async () => {
  const store = createStore({ start: async () => {}, write: async () => {} });
  const { id } = await store.api('POST', 'sources', { kind: 'photo', title: 'Wedding' });
  const file = async () => (await store.api('GET', 'graph')).sources[0]?.file;
  assert.equal(await file(), '');
  await assert.rejects(store.api('PUT', 'files/999', { type: 'image/jpeg', data: 'data:,' }), /No such source/);
  await store.api('PUT', `files/${id}`, { type: 'image/jpeg', data: 'data:image/jpeg;base64,AAAA' });
  assert.equal(await file(), 'image/jpeg');
  assert.equal(store.file(id), 'data:image/jpeg;base64,AAAA');

  await store.api('DELETE', `sources/${id}`);
  assert.equal(store.file(id), '');
  await store.api('POST', `log/${(await store.api('GET', 'log')).find((entry) => entry.removable).id}/undo`);
  assert.equal(await file(), 'image/jpeg');
  assert.equal(store.file(id), 'data:image/jpeg;base64,AAAA');
});

test('a change the keeper cannot write is not kept', async () => {
  let refuse = false;
  const store = createStore({ start: async () => {}, write: async () => { if (refuse) throw new Error('error.readOnly'); } });
  await store.api('POST', 'nodes', { kind: 'place', name: 'Lampang' });
  refuse = true;
  await assert.rejects(store.api('POST', 'nodes', { kind: 'place', name: 'Phrae' }), /error\.readOnly/);
  assert.deepEqual((await store.api('GET', 'graph')).nodes.map((n) => n.name), ['Lampang']);
});
