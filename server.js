import { copyFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fullName, nameRecord } from './public/record.js';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// The record (see README and docs/adr/0003):
//   nodes     people, households, places, events. Single-valued details live in props.
//   versions  every fact, as one or more competing accounts sharing a fact_id, exactly one accepted.
//             target_id NULL: something about the node itself (field: name | born | died | sex).
//             target_id set:  a link from node to target (field is the link type, e.g. CHILD_OF).
//   sources   evidence, attachable to any number of versions.
//   files     the scan or document a source is, when there is one: a JPEG or a PDF.
//   log       every change; removals keep the removed rows so they can be restored.
// AUTOINCREMENT keeps ids from being reused, which is what makes restoring by id safe.
const SCHEMA = `
  CREATE TABLE nodes (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind  TEXT NOT NULL,
    name  TEXT NOT NULL DEFAULT '',
    props TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE versions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id        INTEGER,
    node_id        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    field          TEXT NOT NULL,
    target_id      INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    value          TEXT NOT NULL DEFAULT '{}',
    accepted       INTEGER NOT NULL DEFAULT 1,
    according_to   TEXT NOT NULL DEFAULT '',
    according_node INTEGER REFERENCES nodes(id) ON DELETE SET NULL
  );
  CREATE TABLE sources (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind  TEXT NOT NULL,
    title TEXT NOT NULL,
    note  TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE version_sources (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    PRIMARY KEY (version_id, source_id)
  );
  CREATE TABLE photos (
    node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
    data    BLOB NOT NULL
  );
  CREATE TABLE log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL DEFAULT (datetime('now')),
    summary TEXT NOT NULL,
    removed TEXT,
    undone  INTEGER NOT NULL DEFAULT 0
  );
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'edges'").get()) {
      if (path !== ':memory:') copyFileSync(path, path + '.v1.bak');
      migrateV1(db);
    } else {
      db.exec(SCHEMA);
    }
    db.exec('PRAGMA user_version = 2');
  }
  // Choices about how the record is shown, such as colors. Not facts, so not versioned or logged.
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // Added after version 2 was in use, so made here for old and new records alike.
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    source_id INTEGER PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    type      TEXT NOT NULL,
    data      BLOB NOT NULL
  )`);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// v1 kept one value per fact: nodes(name, props.start, props.end) and an edges table.
function migrateV1(db) {
  const nodes = db.prepare('SELECT * FROM nodes').all();
  const edges = db.prepare('SELECT * FROM edges').all();
  const hasPhotos = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'photos'").get();
  const photos = hasPhotos ? db.prepare('SELECT * FROM photos').all() : [];

  db.exec('BEGIN; DROP TABLE IF EXISTS photos; DROP TABLE edges; DROP TABLE nodes;' + SCHEMA);
  const insertNode = db.prepare('INSERT INTO nodes (id, kind, name, props) VALUES (?, ?, ?, ?)');
  for (const node of nodes) {
    const { start, end, ...props } = JSON.parse(node.props);
    if (node.kind !== 'person') {
      insertNode.run(node.id, node.kind === 'union' ? 'household' : node.kind, node.name, node.props);
      continue;
    }
    insertNode.run(node.id, 'person', '', JSON.stringify(props));
    addVersion(db, { node: node.id, field: 'name', value: { given: node.name, reason: 'birth' } });
    if (start) addVersion(db, { node: node.id, field: 'born', value: { date: start } });
    if (end) addVersion(db, { node: node.id, field: 'died', value: { date: end } });
  }
  for (const edge of edges) {
    addVersion(db, { node: edge.src, field: edge.type, target: edge.dst, value: JSON.parse(edge.props) });
  }
  for (const photo of photos) db.prepare('INSERT INTO photos (node_id, data) VALUES (?, ?)').run(photo.node_id, photo.data);
  db.exec('COMMIT');
}

// ---- Reading ----

// Everything the page needs. A person's name and dates are worked out from their accepted versions.
export function graph(db) {
  const sourcesOf = new Map();
  for (const { version_id, source_id } of db.prepare('SELECT * FROM version_sources').all()) {
    sourcesOf.set(version_id, [...(sourcesOf.get(version_id) ?? []), source_id]);
  }
  const versions = db.prepare('SELECT * FROM versions').all().map((v) => ({
    id: v.id, fact: v.fact_id, node: v.node_id, field: v.field, target: v.target_id,
    value: JSON.parse(v.value), accepted: !!v.accepted,
    accordingTo: v.according_to, accordingNode: v.according_node, sources: sourcesOf.get(v.id) ?? [],
  }));
  const nodes = db
    .prepare('SELECT *, EXISTS (SELECT 1 FROM photos WHERE node_id = nodes.id) AS photo FROM nodes')
    .all()
    .map((row) => describe({ ...row, props: JSON.parse(row.props) }, versions));
  const colors = db.prepare("SELECT value FROM settings WHERE key = 'colors'").get();
  // A source's `file` is the type of its file, or '' when it has none.
  const sources = db.prepare("SELECT *, COALESCE((SELECT type FROM files WHERE source_id = sources.id), '') AS file FROM sources").all();
  return { nodes, versions, sources, colors: JSON.parse(colors?.value ?? '{}') };
}

function describe(node, versions) {
  if (node.kind !== 'person') return node;
  const mine = versions.filter((v) => v.node === node.id && v.target === null && v.accepted);
  const value = (field) => mine.find((v) => v.field === field)?.value ?? {};
  const names = nameRecord(mine);
  return {
    ...node,
    name: fullName(names.at(-1)?.value) || node.props.nickname || '',
    familyName: names.at(-1)?.value.family ?? '',
    birthFamilyName: names[0]?.value.family ?? '',
    born: value('born').date ?? '',
    died: value('died').date ?? '',
    sex: value('sex').sex ?? '',
  };
}

// Who a log entry is about. Entries are stored as data, so the page can word them in any language.
function who(db, id) {
  const node = graph(db).nodes.find((n) => n.id === id);
  return { kind: node?.kind, name: node?.name ?? '' };
}

// ---- Writing ----

export function addNode(db, { kind, name = '', props = {}, facts = {} }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO nodes (kind, name, props) VALUES (?, ?, ?)')
    .run(kind, name, JSON.stringify(props));
  const id = Number(lastInsertRowid);
  setFacts(db, id, facts);
  return { id, kind };
}

function updateNode(db, id, { name = '', props = {}, facts = {} }) {
  db.prepare('UPDATE nodes SET name = ?, props = ? WHERE id = ?').run(name, JSON.stringify(props), id);
  setFacts(db, id, facts);
  return { id };
}

// The plain edit form corrects the accepted version of each fact (for names, the current one).
// Blank removes it. Rival versions are added separately through addVersion.
function setFacts(db, node, facts) {
  for (const [field, value] of Object.entries(facts)) {
    const accepted = graph(db).versions.filter((v) => v.node === node && v.target === null && v.field === field && v.accepted);
    const current = field === 'name' ? nameRecord(accepted).at(-1) : accepted[0];
    const blank = Object.values(value).every((part) => !part);
    if (current && blank) removeVersion(db, current.id);
    else if (current) updateVersion(db, current.id, { value: { ...current.value, ...value } });
    else if (!blank) addVersion(db, { node, field, value: field === 'name' ? { reason: 'birth', ...value } : value });
  }
}

// Without `fact` this starts a new fact and is accepted; with it, it is a rival account of that fact.
export function addVersion(db, { node, field, target = null, value = {}, fact = null, accordingTo = '', accordingNode = null, sources = [] }) {
  if (fact && !db.prepare('SELECT 1 FROM versions WHERE fact_id = ?').get(fact)) throw new Error('No such fact.');
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO versions (fact_id, node_id, field, target_id, value, accepted, according_to, according_node)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fact, node, field, target, JSON.stringify(value), fact ? 0 : 1, accordingTo, accordingNode);
  const id = Number(lastInsertRowid);
  if (!fact) db.prepare('UPDATE versions SET fact_id = id WHERE id = ?').run(id);
  setSources(db, id, sources);
  return { id };
}

function getVersion(db, id) {
  const row = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!row) throw new Error('No such version.');
  return row;
}

function updateVersion(db, id, patch) {
  const row = getVersion(db, id);
  db.prepare(`UPDATE versions SET node_id = ?, field = ?, target_id = ?, value = ?, according_to = ?, according_node = ?
              WHERE id = ?`)
    .run(
      patch.node ?? row.node_id,
      patch.field ?? row.field,
      patch.target !== undefined ? patch.target : row.target_id,
      patch.value ? JSON.stringify(patch.value) : row.value,
      patch.accordingTo ?? row.according_to,
      patch.accordingNode !== undefined ? patch.accordingNode : row.according_node,
      id,
    );
  if (patch.sources) setSources(db, id, patch.sources);
  return { id };
}

function setSources(db, versionId, sourceIds) {
  db.prepare('DELETE FROM version_sources WHERE version_id = ?').run(versionId);
  for (const sourceId of sourceIds) {
    db.prepare('INSERT INTO version_sources (version_id, source_id) VALUES (?, ?)').run(versionId, sourceId);
  }
}

function acceptVersion(db, id) {
  db.prepare('UPDATE versions SET accepted = (id = ?) WHERE fact_id = ?').run(id, getVersion(db, id).fact_id);
  return { id };
}

// A fact must keep exactly one accepted version: when the accepted one goes, the oldest rival steps up.
function promoteRivals(db) {
  db.exec(`UPDATE versions SET accepted = 1
           WHERE id IN (SELECT MIN(id) FROM versions GROUP BY fact_id HAVING MAX(accepted) = 0)`);
}

// Each remove* returns the rows it took out, in the shape restore() puts back.
function removeVersion(db, id) {
  const removed = {
    versions: [getVersion(db, id)],
    version_sources: db.prepare('SELECT * FROM version_sources WHERE version_id = ?').all(id),
  };
  db.prepare('DELETE FROM versions WHERE id = ?').run(id);
  promoteRivals(db);
  return removed;
}

function removeNode(db, id) {
  const touching = 'SELECT id FROM versions WHERE node_id = ? OR target_id = ?';
  const removed = {
    nodes: db.prepare('SELECT * FROM nodes WHERE id = ?').all(id),
    versions: db.prepare(`SELECT * FROM versions WHERE id IN (${touching})`).all(id, id),
    version_sources: db.prepare(`SELECT * FROM version_sources WHERE version_id IN (${touching})`).all(id, id),
    photos: db.prepare('SELECT * FROM photos WHERE node_id = ?').all(id)
      .map((photo) => ({ ...photo, data: Buffer.from(photo.data).toString('base64') })),
  };
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  promoteRivals(db);
  return removed;
}

function removeSource(db, id) {
  const removed = {
    sources: db.prepare('SELECT * FROM sources WHERE id = ?').all(id),
    version_sources: db.prepare('SELECT * FROM version_sources WHERE source_id = ?').all(id),
    files: db.prepare('SELECT * FROM files WHERE source_id = ?').all(id)
      .map((file) => ({ ...file, data: Buffer.from(file.data).toString('base64') })),
  };
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  return removed;
}

// Entries written before the log held data are plain sentences; pass those through as they are.
function parseSummary(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { action: 'legacy', text };
  }
}

// entry: { action, kind?, field?, name?, ... }, see the log.* texts in public/i18n.js.
function record(db, entry, removed) {
  db.prepare('INSERT INTO log (summary, removed) VALUES (?, ?)')
    .run(JSON.stringify(entry), removed ? JSON.stringify(removed) : null);
}

// Add someone to the family by what they are to `person`, creating the household in between when needed.
// `other` is an existing person's id, or the details of a new person.
function addRelative(db, { person, relation, other, kind = 'birth', household = null, takeName = '', married = '' }) {
  const otherId = typeof other === 'number' ? other : addNode(db, { kind: 'person', ...other }).id;
  const links = graph(db).versions.filter((v) => v.target !== null && v.accepted);
  const partnersIn = (h) => links.filter((v) => v.field === 'PARTNER_IN' && v.target === h);
  const join = (node, target, field, value = {}) => addVersion(db, { node, field, target, value });
  const newHousehold = () => addNode(db, { kind: 'household' }).id;
  // The household `person` descends from, started now if the record has none.
  const homeOf = () => {
    const home = links.find((v) => v.node === person && v.field === 'CHILD_OF' && ['birth', 'adopted'].includes(v.value.kind ?? 'birth'));
    if (home) return home.target;
    const started = newHousehold();
    join(person, started, 'CHILD_OF', { kind: 'birth' });
    return started;
  };

  if (relation === 'partner') {
    // The date they married, when given, is when the household began and when any name change took effect.
    const h = addNode(db, { kind: 'household', props: married ? { start: married } : {} }).id;
    join(person, h, 'PARTNER_IN');
    join(otherId, h, 'PARTNER_IN');
    if (takeName === 'other') takeFamilyName(db, otherId, person, married);
    if (takeName === 'person') takeFamilyName(db, person, otherId, married);
  } else if (relation === 'child') {
    const h = household ?? newHousehold();
    if (!household) join(person, h, 'PARTNER_IN');
    join(otherId, h, 'CHILD_OF', { kind });
  } else if (relation === 'parent') {
    const h = homeOf();
    if (partnersIn(h).length >= 2) throw new Error('rel.twoParents');
    join(otherId, h, 'PARTNER_IN');
  } else if (relation === 'sibling') {
    join(otherId, homeOf(), 'CHILD_OF', { kind });
  } else {
    throw new Error('Unknown relation.');
  }
  return { id: otherId };
}

// `taker` starts carrying `giver`'s current family name: a new entry in their name record.
function takeFamilyName(db, taker, giver, from) {
  const g = graph(db);
  const family = g.nodes.find((n) => n.id === giver).familyName;
  if (!family) return;
  const current = nameRecord(g.versions.filter((v) => v.node === taker && v.target === null && v.accepted)).at(-1)?.value;
  const value = { ...(current?.given && { given: current.given }), family, ...(from && { from }), reason: 'marriage' };
  addVersion(db, { node: taker, field: 'name', value });
}

// Put back what a removal took out, under the original ids.
function restore(db, logId) {
  const entry = db.prepare('SELECT * FROM log WHERE id = ?').get(logId);
  if (!entry?.removed || entry.undone) throw new Error('That change cannot be undone.');
  const removed = JSON.parse(entry.removed);
  for (const table of ['nodes', 'sources', 'versions', 'version_sources', 'photos', 'files']) {
    for (const row of removed[table] ?? []) {
      if (table === 'photos' || table === 'files') row.data = Buffer.from(row.data, 'base64');
      const columns = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...Object.values(row));
    }
  }
  // A restored accepted version takes its place back from whichever rival stepped up.
  for (const version of removed.versions ?? []) if (version.accepted) acceptVersion(db, version.id);
  db.prepare('UPDATE log SET undone = 1 WHERE id = ?').run(logId);
  return parseSummary(entry.summary);
}

// One change to the record. Returns the response body, or undefined if the route does not exist.
function change(db, route, id, body) {
  const fact = (row) => ({ field: row.target_id === null ? row.field : 'link', ...who(db, row.node_id) });
  switch (route) {
    case 'POST nodes': {
      const node = addNode(db, body);
      record(db, { action: 'added', ...who(db, node.id) });
      return node;
    }
    case 'PUT nodes':
      updateNode(db, id, body);
      record(db, { action: 'changed', ...who(db, id) });
      return { id };
    case 'DELETE nodes': {
      const entry = { action: 'removed', ...who(db, id) };
      record(db, entry, removeNode(db, id));
      return {};
    }
    case 'POST relatives': {
      const relative = addRelative(db, body);
      record(db, { action: 'addedRelative', relation: body.relation, name: who(db, body.person).name });
      return relative;
    }
    case 'POST versions': {
      const version = addVersion(db, body);
      record(db, { action: body.fact ? 'addedVersion' : 'added', ...fact(getVersion(db, version.id)) });
      return version;
    }
    case 'PUT versions':
      updateVersion(db, id, body);
      record(db, { action: 'changed', ...fact(getVersion(db, id)) });
      return { id };
    case 'POST versions accept':
      acceptVersion(db, id);
      record(db, { action: 'accepted', ...fact(getVersion(db, id)) });
      return { id };
    case 'DELETE versions': {
      const entry = { action: 'removed', ...fact(getVersion(db, id)) };
      record(db, entry, removeVersion(db, id));
      return {};
    }
    case 'POST sources': {
      const { lastInsertRowid } = db.prepare('INSERT INTO sources (kind, title, note) VALUES (?, ?, ?)')
        .run(body.kind, body.title, body.note ?? '');
      record(db, { action: 'added', kind: 'source', name: body.title });
      return { id: Number(lastInsertRowid) };
    }
    case 'PUT sources': {
      const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
      if (!row) throw new Error('No such source.');
      const next = { ...row, ...body };
      db.prepare('UPDATE sources SET kind = ?, title = ?, note = ? WHERE id = ?').run(next.kind, next.title, next.note, id);
      record(db, { action: 'changed', kind: 'source', name: next.title });
      return { id };
    }
    case 'DELETE sources': {
      const removed = removeSource(db, id);
      record(db, { action: 'removed', kind: 'source', name: removed.sources[0]?.title }, removed);
      return {};
    }
    case 'PUT colors':
      db.prepare("INSERT INTO settings (key, value) VALUES ('colors', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(body));
      return {};
    case 'POST log undo':
      record(db, { action: 'undid', of: restore(db, id) });
      return {};
  }
}

// ---- HTTP ----

const MAX_PHOTO_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// A source's file is a picture, which the page re-encodes as JPEG, or a PDF. Nothing else is kept or served.
const FILE_TYPES = ['image/jpeg', 'application/pdf'];

async function readBytes(req, limit, tooLarge) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  if (!size) throw new Error('Nothing was sent.');
  return Buffer.concat(chunks);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function serveStatic(root, pathname, res) {
  const file = join(root, pathname === '/' ? 'index.html' : pathname);
  try {
    if (!file.startsWith(root)) throw new Error('outside the page folder');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

// `pageDir` is the folder the page is served from: public/ as written, or a built copy of it.
export function createApp(db, pageDir = PUBLIC) {
  const root = join(pageDir, '/');
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const [, api, collection, rawId, action] = pathname.split('/');
    if (api !== 'api') return serveStatic(root, pathname, res);
    const id = Number(rawId);
    try {
      const route = [req.method, collection, action].filter(Boolean).join(' ');
      if (route === 'GET graph') return send(res, 200, graph(db));
      if (route === 'GET log') {
        const entries = db.prepare('SELECT id, at, summary, undone, removed IS NOT NULL AS removable FROM log ORDER BY id DESC LIMIT 100').all();
        return send(res, 200, entries.map((entry) => ({ ...entry, summary: parseSummary(entry.summary) })));
      }
      if (route === 'GET photos') {
        const photo = db.prepare('SELECT data FROM photos WHERE node_id = ?').get(id);
        if (!photo) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        return res.end(photo.data);
      }
      // Photos are always JPEG: the page crops and re-encodes before uploading.
      if (route === 'PUT photos') {
        db.prepare('INSERT INTO photos (node_id, data) VALUES (?, ?) ON CONFLICT (node_id) DO UPDATE SET data = excluded.data')
          .run(id, await readBytes(req, MAX_PHOTO_BYTES, 'Photo is too large.'));
        record(db, { action: 'changed', field: 'photo', name: who(db, id).name });
        return send(res, 200, {});
      }
      if (route === 'GET files') {
        const file = db.prepare('SELECT type, data FROM files WHERE source_id = ?').get(id);
        if (!file) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': file.type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        return res.end(file.data);
      }
      if (route === 'PUT files') {
        const type = req.headers['content-type'];
        if (!FILE_TYPES.includes(type)) throw new Error('error.fileKind');
        if (!db.prepare('SELECT 1 FROM sources WHERE id = ?').get(id)) throw new Error('No such source.');
        db.prepare('INSERT INTO files (source_id, type, data) VALUES (?, ?, ?) ON CONFLICT (source_id) DO UPDATE SET type = excluded.type, data = excluded.data')
          .run(id, type, await readBytes(req, MAX_FILE_BYTES, 'error.fileTooLarge'));
        return send(res, 200, {});
      }

      const body = await readJson(req);
      db.exec('BEGIN');
      try {
        const result = change(db, route, id, body);
        db.exec('COMMIT');
        if (result === undefined) return send(res, 404, { error: 'Not found' });
        send(res, 200, result);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT ?? 3000;
  // Bound to localhost only: this holds personal data about living people.
  createApp(openDb(process.env.DB ?? 'family.db')).listen(port, '127.0.0.1', () => {
    console.log(`Family graph running at http://localhost:${port}`);
  });
}
