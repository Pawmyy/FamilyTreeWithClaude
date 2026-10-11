import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createApp, graph, openDb } from '../server.js';

let app, base;

before(async () => {
  app = createApp(openDb(':memory:'));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const getGraph = async () => (await call('GET', '/api/graph')).body;
const person = async (given, family, extra = {}) =>
  (await call('POST', '/api/nodes', { kind: 'person', facts: { name: { given, family }, ...extra } })).body.id;
const find = (g, id) => g.nodes.find((n) => n.id === id);

test('a person is described by their accepted versions, and the edit form corrects them', async () => {
  const id = await person('Malee', 'Srisai', { born: { date: '2505' }, sex: { sex: 'female' } });
  let node = find(await getGraph(), id);
  assert.deepEqual(
    [node.name, node.familyName, node.birthFamilyName, node.born, node.died, node.sex],
    ['Malee Srisai', 'Srisai', 'Srisai', '2505', '', 'female'],
  );

  await call('PUT', `/api/nodes/${id}`, { props: { nickname: 'Lek' }, facts: { name: { given: 'Mali', family: 'Srisai' }, born: { date: '' } } });
  const g = await getGraph();
  node = find(g, id);
  assert.deepEqual([node.name, node.born, node.props.nickname], ['Mali Srisai', '', 'Lek']);
  assert.equal(g.versions.filter((v) => v.node === id && v.field === 'name').length, 1, 'corrected in place, not duplicated');
  assert.equal(g.versions.filter((v) => v.node === id && v.field === 'born').length, 0, 'blanking a field removes it');
});

test('the name record: the latest name is shown, the birth family name is remembered', async () => {
  const id = await person('Somsri', 'Kaewta');
  await call('POST', '/api/versions', { node: id, field: 'name', value: { given: 'Somsri', family: 'Boonmee', from: '2530', reason: 'marriage' } });
  const node = find(await getGraph(), id);
  assert.deepEqual([node.name, node.familyName, node.birthFamilyName], ['Somsri Boonmee', 'Boonmee', 'Kaewta']);
});

test('a person with only a nickname, or nothing, still has a display name', async () => {
  const nick = (await call('POST', '/api/nodes', { kind: 'person', props: { nickname: 'Paa' } })).body.id;
  const none = (await call('POST', '/api/nodes', { kind: 'person' })).body.id;
  const g = await getGraph();
  assert.deepEqual([find(g, nick).name, find(g, none).name], ['Paa', '']);
});

test('rival versions: one accepted per fact, accepting swaps, removing the accepted one promotes a rival', async () => {
  const child = await person('Chai', 'Srisai');
  const a = (await call('POST', '/api/nodes', { kind: 'household' })).body.id;
  const b = (await call('POST', '/api/nodes', { kind: 'household' })).body.id;
  const source = (await call('POST', '/api/sources', { kind: 'register', title: 'Temple register' })).body.id;

  const first = (await call('POST', '/api/versions', { node: child, field: 'CHILD_OF', target: a, value: { kind: 'birth' } })).body.id;
  const rival = (await call('POST', '/api/versions', {
    node: child, field: 'CHILD_OF', target: b, value: { kind: 'adopted' }, fact: first, accordingTo: 'Aunt Mali', sources: [source],
  })).body.id;

  const versions = async () => (await getGraph()).versions.filter((v) => v.fact === first);
  assert.deepEqual((await versions()).map((v) => [v.id, v.accepted]), [[first, true], [rival, false]]);
  assert.deepEqual((await versions())[1], {
    id: rival, fact: first, node: child, field: 'CHILD_OF', target: b, value: { kind: 'adopted' },
    accepted: false, accordingTo: 'Aunt Mali', accordingNode: null, sources: [source],
  });

  await call('POST', `/api/versions/${rival}/accept`);
  assert.deepEqual((await versions()).map((v) => v.accepted), [false, true]);

  await call('DELETE', `/api/versions/${rival}`);
  assert.deepEqual((await versions()).map((v) => [v.id, v.accepted]), [[first, true]]);

  assert.equal((await call('POST', '/api/versions', { node: child, field: 'born', value: {}, fact: 99999 })).status, 400);
});

test('changing a link and attaching sources', async () => {
  const p = await person('Nok', '');
  const h = (await call('POST', '/api/nodes', { kind: 'household' })).body.id;
  const s = (await call('POST', '/api/sources', { kind: 'memory', title: 'Grandmother told me' })).body.id;
  const link = (await call('POST', '/api/versions', { node: p, field: 'PARTNER_IN', target: h })).body.id;

  await call('PUT', `/api/versions/${link}`, { field: 'CHILD_OF', value: { kind: 'foster' }, accordingNode: p, sources: [s] });
  let version = (await getGraph()).versions.find((v) => v.id === link);
  assert.deepEqual(
    [version.field, version.value, version.accordingNode, version.sources, version.accepted],
    ['CHILD_OF', { kind: 'foster' }, p, [s], true],
  );

  await call('DELETE', `/api/sources/${s}`);
  version = (await getGraph()).versions.find((v) => v.id === link);
  assert.deepEqual(version.sources, []);
});

test('removing a person goes to the log and can be undone, photo and links included', async () => {
  const p = await person('Dao', 'Srisai');
  const h = (await call('POST', '/api/nodes', { kind: 'household' })).body.id;
  await call('POST', '/api/versions', { node: p, field: 'PARTNER_IN', target: h });
  await fetch(`${base}/api/photos/${p}`, { method: 'PUT', body: new Uint8Array([7, 8, 9]) });
  const before = await getGraph();

  await call('DELETE', `/api/nodes/${p}`);
  let g = await getGraph();
  assert.equal(find(g, p), undefined);
  assert.equal(g.versions.some((v) => v.node === p), false);

  const [entry] = (await call('GET', '/api/log')).body;
  assert.deepEqual([entry.summary, entry.removable, entry.undone], [{ action: 'removed', kind: 'person', name: 'Dao Srisai' }, 1, 0]);
  await call('POST', `/api/log/${entry.id}/undo`);

  g = await getGraph();
  assert.deepEqual(find(g, p), find(before, p));
  assert.deepEqual(g.versions.filter((v) => v.node === p), before.versions.filter((v) => v.node === p));
  const photo = await fetch(`${base}/api/photos/${p}`);
  assert.deepEqual([...new Uint8Array(await photo.arrayBuffer())], [7, 8, 9]);

  assert.equal((await call('POST', `/api/log/${entry.id}/undo`)).status, 400, 'cannot undo twice');
});

test('undoing the removal of an accepted version gives it its place back', async () => {
  const p = await person('Fon', '');
  const first = (await call('POST', '/api/versions', { node: p, field: 'born', value: { date: '2433' } })).body.id;
  const rival = (await call('POST', '/api/versions', { node: p, field: 'born', value: { date: '2436' }, fact: first })).body.id;

  await call('DELETE', `/api/versions/${first}`);
  assert.equal(find(await getGraph(), p).born, '2436');
  await call('POST', `/api/log/${(await call('GET', '/api/log')).body[0].id}/undo`);

  const g = await getGraph();
  assert.equal(find(g, p).born, '2433');
  assert.deepEqual(g.versions.filter((v) => v.fact === first).map((v) => [v.id, v.accepted]), [[first, true], [rival, false]]);
});

test('adding relatives builds the households in between', async () => {
  const me = await person('Poom', 'Srisai');
  const newPerson = (given, family) => ({ facts: { name: { given, family } } });
  const add = async (body) => (await call('POST', '/api/relatives', { person: me, ...body })).body.id;
  const links = async () => (await getGraph()).versions.filter((v) => v.target !== null).map((v) => [v.node, v.field, v.target, v.value.kind]);

  // A sibling first: no parents known, so a household is started with both as children.
  const sibling = await add({ relation: 'sibling', other: newPerson('Ploy', 'Srisai') });
  let all = await links();
  const home = all.find(([node, field]) => node === me && field === 'CHILD_OF')[2];
  assert.deepEqual(all.filter(([, , target]) => target === home), [[me, 'CHILD_OF', home, 'birth'], [sibling, 'CHILD_OF', home, 'birth']]);

  // Parents join that same household, and a third is refused.
  const mother = await add({ relation: 'parent', other: newPerson('Mae', 'Srisai') });
  const father = await add({ relation: 'parent', other: newPerson('Por', 'Srisai') });
  all = await links();
  assert.deepEqual(all.filter(([, field, target]) => field === 'PARTNER_IN' && target === home).map(([node]) => node), [mother, father]);
  const third = await call('POST', '/api/relatives', { person: me, relation: 'parent', other: newPerson('X', '') });
  assert.deepEqual([third.status, third.body.error], [400, 'rel.twoParents']);
  assert.equal((await getGraph()).nodes.some((n) => n.name === 'X'), false, 'the refused parent was not left behind');

  // A partner who takes my family name, then a child in that household, then one with the other parent unknown.
  const partner = await add({ relation: 'partner', other: newPerson('Dao', 'Kaewta'), takeName: 'other', married: '2560' });
  let g = await getGraph();
  assert.deepEqual([find(g, partner).name, find(g, partner).birthFamilyName], ['Dao Srisai', 'Kaewta']);
  const ours = (await links()).find(([node, field]) => node === partner && field === 'PARTNER_IN')[2];
  assert.equal(find(g, ours).props.start, '2560', 'the household began on the marriage date');
  assert.equal(g.versions.find((v) => v.node === partner && v.value.reason === 'marriage').value.from, '2560');
  const child = await add({ relation: 'child', other: newPerson('Nong', 'Srisai'), household: ours, kind: 'adopted' });
  const alone = await add({ relation: 'child', other: sibling });
  all = await links();
  assert.deepEqual(all.find(([node]) => node === child), [child, 'CHILD_OF', ours, 'adopted']);
  const second = all.find(([node, field, target]) => node === sibling && field === 'CHILD_OF' && target !== home)[2];
  assert.equal(alone, sibling, 'an existing person can be attached instead of a new one');
  assert.deepEqual(all.filter(([, field, target]) => field === 'PARTNER_IN' && target === second).map(([node]) => node), [me]);
});

test('a photo can be uploaded, replaced and fetched; oversized uploads are refused', async () => {
  const id = await person('Ben', '');
  const photo = `${base}/api/photos/${id}`;
  assert.equal((await fetch(photo)).status, 404);

  await fetch(photo, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
  await fetch(photo, { method: 'PUT', body: new Uint8Array([4, 5]) });
  const res = await fetch(photo);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [4, 5]);
  assert.equal(find(await getGraph(), id).photo, 1);

  const tooBig = await fetch(photo, { method: 'PUT', body: new Uint8Array(1024 * 1024 + 1) });
  assert.equal(tooBig.status, 400);
});

test('a source can be renamed and carry a file, which goes and comes back with it', async () => {
  const id = (await call('POST', '/api/sources', { kind: 'other', title: 'scan0001' })).body.id;
  const source = async () => (await getGraph()).sources.find((s) => s.id === id);
  assert.equal((await source()).file, '');

  await call('PUT', `/api/sources/${id}`, { kind: 'certificate', title: 'Birth certificate' });
  assert.deepEqual(await source(), { id, kind: 'certificate', title: 'Birth certificate', note: '', file: '' });

  const file = `${base}/api/files/${id}`;
  const put = (type, body) => fetch(file, { method: 'PUT', headers: { 'content-type': type }, body });
  assert.equal((await fetch(file)).status, 404);
  assert.equal((await put('text/html', '<script>')).status, 400, 'only a picture or a PDF is kept');
  assert.equal((await put('application/pdf', new Uint8Array(5 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await fetch(`${base}/api/files/999999`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: 'x' })).status, 400);
  assert.equal((await put('application/pdf', new Uint8Array([7, 8, 9]))).status, 200);
  assert.equal((await source()).file, 'application/pdf');
  const read = async () => {
    const res = await fetch(file);
    return [res.status, res.headers.get('content-type'), [...new Uint8Array(await res.arrayBuffer())]];
  };
  assert.deepEqual(await read(), [200, 'application/pdf', [7, 8, 9]]);

  await call('DELETE', `/api/sources/${id}`);
  assert.equal((await fetch(file)).status, 404);
  const log = (await call('GET', '/api/log')).body;
  await call('POST', `/api/log/${log.find((entry) => entry.summary.action === 'removed').id}/undo`);
  assert.deepEqual(await read(), [200, 'application/pdf', [7, 8, 9]]);
});

test('color choices are kept with the record, and a place keeps where it is', async () => {
  assert.deepEqual((await getGraph()).colors, {});
  const colors = { family: { Srisai: '#ff00aa' }, link: { CHILD_OF: '#123456' }, kind: { place: '#00ff00' } };
  await call('PUT', '/api/colors', colors);
  assert.deepEqual((await getGraph()).colors, colors);

  const place = (await call('POST', '/api/nodes', { kind: 'place', name: 'Chiang Mai' })).body.id;
  await call('PUT', `/api/nodes/${place}`, { name: 'Chiang Mai', props: { lat: 18.79, lng: 98.98 } });
  assert.deepEqual(find(await getGraph(), place).props, { lat: 18.79, lng: 98.98 });
});

test('bad requests are refused without changing anything', async () => {
  const before = (await getGraph()).versions.length;
  assert.equal((await call('POST', '/api/versions', { node: 99999, field: 'PARTNER_IN', target: 99998 })).status, 400);
  assert.equal((await call('POST', '/api/nowhere', {})).status, 404);
  assert.equal((await getGraph()).versions.length, before);
});

test('a version-1 database is carried over, with a backup left beside it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'family-')), 'family.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', props TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE edges (id INTEGER PRIMARY KEY, src INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dst INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, type TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE photos (node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, data BLOB NOT NULL);
    INSERT INTO nodes VALUES (1, 'person', 'Poom', '{"start":"2540","notes":"me"}'), (2, 'person', 'Mae', '{}'),
      (5, 'union', '', '{"start":"2535"}'), (6, 'place', 'Bangkok', '{}');
    INSERT INTO edges VALUES (1, 2, 5, 'PARTNER_IN', '{}'), (2, 1, 5, 'CHILD_OF', '{"kind":"birth"}'), (3, 1, 6, 'LIVED_IN', '{}');
    INSERT INTO photos VALUES (1, x'0102');
  `);
  old.close();

  const db = openDb(path);
  const g = graph(db);
  assert.deepEqual(
    g.nodes.map((n) => [n.id, n.kind, n.name, n.photo]),
    [[1, 'person', 'Poom', 1], [2, 'person', 'Mae', 0], [5, 'household', '', 0], [6, 'place', 'Bangkok', 0]],
  );
  assert.deepEqual([g.nodes[0].born, g.nodes[0].props], ['2540', { notes: 'me' }]);
  assert.deepEqual(g.nodes[2].props, { start: '2535' });
  assert.deepEqual(
    g.versions.filter((v) => v.target !== null).map((v) => [v.node, v.field, v.target, v.value, v.accepted]),
    [[2, 'PARTNER_IN', 5, {}, true], [1, 'CHILD_OF', 5, { kind: 'birth' }, true], [1, 'LIVED_IN', 6, {}, true]],
  );
  assert.ok(existsSync(path + '.v1.bak'));

  db.close();
  assert.equal(graph(openDb(path)).nodes.length, 4, 'opening again does not migrate twice');
});

test('serves the UI and refuses paths outside public/', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/kinship.js')).status, 200);
  assert.equal((await fetch(base + '/..%2Fserver.js')).status, 404);
});
