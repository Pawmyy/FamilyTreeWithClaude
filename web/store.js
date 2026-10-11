// The record, kept in the browser: what server.js does with SQLite, done over plain rows in memory.
// Where the rows are stored for good is the keeper's business (see backend.*.js).
//
//   nodes     { id, kind, name, props }
//   versions  { id, fact, node, field, target, value, accepted, accordingTo, accordingNode, sources: [id] }
//   sources   { id, kind, title, note }
//   files     { id: the source's id, type, data: where the file is read from, a data: URL or a path }
//   photos    { id: the node's id, data: a JPEG as a data: URL }
//   log       { id, at, summary, removed, undone }
//   settings  { id: 'colors', value }
//
// A keeper has start(onTable) -> Promise, calling onTable(table, rows) with a table's rows whenever they
// are read or change, and write(ops) -> Promise for ops [{ table, id, row }], where a null row removes.
// Rows are never changed in place: a change puts a new row, so a keeper may hand out frozen ones.
import { fullName, nameRecord } from '../public/record.js';

export const TABLES = ['nodes', 'versions', 'sources', 'photos', 'files', 'log', 'settings'];
const LOG_KEPT = 200;

// The same text for the same rows, whatever order their fields were written in.
const canon = (value) => JSON.stringify(value, (_, v) =>
  (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export function createStore(keeper) {
  let T = Object.fromEntries(TABLES.map((table) => [table, new Map()]));
  let dirty = new Map();
  let lastId = 0;
  let queue = Promise.resolve();
  let shown = ''; // the record as the page last read it
  let watchers = [];
  let noticing = null;

  const rows = (table) => [...T[table].values()].sort((a, b) => a.id - b.id);
  // Ids only ever grow, here and for anyone else adding at the same time, so a removed id is never reused.
  const newId = () => (lastId = Math.max(lastId + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000)));
  const put = (table, row) => {
    T[table].set(row.id, row);
    dirty.set(table + '/' + row.id, { table, id: row.id });
    return row;
  };
  const drop = (table, id) => {
    T[table].delete(id);
    dirty.set(table + '/' + id, { table, id });
  };
  // Photos and files are told apart by size alone: comparing them whole would be slow.
  const picture = () => canon(TABLES.map((table) => (table === 'photos' || table === 'files' ? rows(table).map((p) => [p.id, p.data.length]) : rows(table))));

  // ---- Reading ----

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

  function graph() {
    const versions = rows('versions');
    return {
      nodes: rows('nodes').map((node) => describe({ ...node, photo: T.photos.has(node.id) }, versions)),
      versions,
      // A source's `file` is the type of its file, or '' when it has none.
      sources: rows('sources').map((source) => ({ ...source, file: T.files.get(source.id)?.type ?? '' })),
      colors: T.settings.get('colors')?.value ?? {},
    };
  }

  function who(id) {
    const node = graph().nodes.find((n) => n.id === id);
    return { kind: node?.kind, name: node?.name ?? '' };
  }

  // ---- Writing ----

  function addNode({ kind, name = '', props = {}, facts = {} }) {
    const { id } = put('nodes', { id: newId(), kind, name, props });
    setFacts(id, facts);
    return { id, kind };
  }

  function updateNode(id, { name = '', props = {}, facts = {} }) {
    put('nodes', { ...T.nodes.get(id), name, props });
    setFacts(id, facts);
  }

  // The plain edit form corrects the accepted version of each fact (for names, the current one).
  // Blank removes it. Rival versions are added separately through addVersion.
  function setFacts(node, facts) {
    for (const [field, value] of Object.entries(facts)) {
      const accepted = rows('versions').filter((v) => v.node === node && v.target === null && v.field === field && v.accepted);
      const current = field === 'name' ? nameRecord(accepted).at(-1) : accepted[0];
      const blank = Object.values(value).every((part) => !part);
      if (current && blank) removeVersion(current.id);
      else if (current) updateVersion(current.id, { value: { ...current.value, ...value } });
      else if (!blank) addVersion({ node, field, value: field === 'name' ? { reason: 'birth', ...value } : value });
    }
  }

  // Without `fact` this starts a new fact and is accepted; with it, it is a rival account of that fact.
  function addVersion({ node, field, target = null, value = {}, fact = null, accordingTo = '', accordingNode = null, sources = [] }) {
    if (fact && !rows('versions').some((v) => v.fact === fact)) throw new Error('No such fact.');
    const id = newId();
    put('versions', { id, fact: fact ?? id, node, field, target, value, accepted: !fact, accordingTo, accordingNode, sources });
    return { id };
  }

  function getVersion(id) {
    const row = T.versions.get(id);
    if (!row) throw new Error('No such version.');
    return row;
  }

  function updateVersion(id, patch) {
    const row = getVersion(id);
    put('versions', {
      ...row,
      node: patch.node ?? row.node,
      field: patch.field ?? row.field,
      target: patch.target !== undefined ? patch.target : row.target,
      value: patch.value ?? row.value,
      accordingTo: patch.accordingTo ?? row.accordingTo,
      accordingNode: patch.accordingNode !== undefined ? patch.accordingNode : row.accordingNode,
      sources: patch.sources ?? row.sources,
    });
  }

  function acceptVersion(id) {
    const { fact } = getVersion(id);
    for (const v of rows('versions')) {
      if (v.fact === fact && v.accepted !== (v.id === id)) put('versions', { ...v, accepted: v.id === id });
    }
  }

  // A fact must keep exactly one accepted version: when the accepted one goes, the oldest rival steps up.
  function promoteRivals() {
    const facts = new Map();
    for (const v of rows('versions')) facts.set(v.fact, [...(facts.get(v.fact) ?? []), v]);
    for (const accounts of facts.values()) {
      if (!accounts.some((v) => v.accepted)) put('versions', { ...accounts[0], accepted: true });
    }
  }

  // Each remove* returns the rows it took out, in the shape restore() puts back.
  function removeVersion(id) {
    const removed = { versions: [getVersion(id)] };
    drop('versions', id);
    promoteRivals();
    return removed;
  }

  function removeNode(id) {
    const removed = {
      nodes: [T.nodes.get(id)].filter(Boolean),
      versions: rows('versions').filter((v) => v.node === id || v.target === id),
      photos: [T.photos.get(id)].filter(Boolean),
    };
    for (const v of removed.versions) drop('versions', v.id);
    // Accounts given by the removed person stay, without their name attached.
    for (const v of rows('versions')) if (v.accordingNode === id) put('versions', { ...v, accordingNode: null });
    drop('photos', id);
    drop('nodes', id);
    promoteRivals();
    return removed;
  }

  function removeSource(id) {
    const cited = rows('versions').filter((v) => v.sources.includes(id));
    const removed = {
      sources: [T.sources.get(id)].filter(Boolean),
      citations: cited.map((v) => ({ version: v.id, source: id })),
      files: [T.files.get(id)].filter(Boolean),
    };
    for (const v of cited) put('versions', { ...v, sources: v.sources.filter((other) => other !== id) });
    drop('files', id);
    drop('sources', id);
    return removed;
  }

  // entry: { action, kind?, field?, name?, ... }, see the log.* texts in i18n.js.
  function record(entry, removed = null) {
    put('log', { id: newId(), at: new Date().toISOString().slice(0, 19).replace('T', ' '), summary: entry, removed, undone: false });
    // The log is for undoing recent slips, so only its newest entries are kept.
    for (const old of rows('log').slice(0, -LOG_KEPT)) drop('log', old.id);
  }

  // Add someone to the family by what they are to `person`, creating the household in between when needed.
  // `other` is an existing person's id, or the details of a new person.
  function addRelative({ person, relation, other, kind = 'birth', household = null, takeName = '', married = '' }) {
    const otherId = typeof other === 'number' ? other : addNode({ kind: 'person', ...other }).id;
    const links = rows('versions').filter((v) => v.target !== null && v.accepted);
    const partnersIn = (h) => links.filter((v) => v.field === 'PARTNER_IN' && v.target === h);
    const join = (node, target, field, value = {}) => addVersion({ node, field, target, value });
    const newHousehold = () => addNode({ kind: 'household' }).id;
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
      const h = addNode({ kind: 'household', props: married ? { start: married } : {} }).id;
      join(person, h, 'PARTNER_IN');
      join(otherId, h, 'PARTNER_IN');
      if (takeName === 'other') takeFamilyName(otherId, person, married);
      if (takeName === 'person') takeFamilyName(person, otherId, married);
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
  function takeFamilyName(taker, giver, from) {
    const g = graph();
    const family = g.nodes.find((n) => n.id === giver).familyName;
    if (!family) return;
    const current = nameRecord(g.versions.filter((v) => v.node === taker && v.target === null && v.accepted)).at(-1)?.value;
    addVersion({ node: taker, field: 'name', value: { ...(current?.given && { given: current.given }), family, ...(from && { from }), reason: 'marriage' } });
  }

  // Put back what a removal took out, under the original ids.
  function restore(logId) {
    const entry = T.log.get(logId);
    if (!entry?.removed || entry.undone) throw new Error('That change cannot be undone.');
    for (const table of ['nodes', 'sources', 'versions', 'photos', 'files']) {
      for (const row of entry.removed[table] ?? []) put(table, row);
    }
    for (const { version, source } of entry.removed.citations ?? []) {
      const v = T.versions.get(version);
      if (v && !v.sources.includes(source)) put('versions', { ...v, sources: [...v.sources, source] });
    }
    // A restored accepted version takes its place back from whichever rival stepped up.
    for (const version of entry.removed.versions ?? []) if (version.accepted) acceptVersion(version.id);
    put('log', { ...entry, undone: true });
    return entry.summary;
  }

  // One change to the record. Returns the answer, or undefined if there is no such change.
  function change(route, id, body) {
    const fact = (row) => ({ field: row.target === null ? row.field : 'link', ...who(row.node) });
    switch (route) {
      case 'POST nodes': {
        const node = addNode(body);
        record({ action: 'added', ...who(node.id) });
        return node;
      }
      case 'PUT nodes':
        updateNode(id, body);
        record({ action: 'changed', ...who(id) });
        return { id };
      case 'DELETE nodes': {
        const entry = { action: 'removed', ...who(id) };
        record(entry, removeNode(id));
        return {};
      }
      case 'POST relatives': {
        const relative = addRelative(body);
        record({ action: 'addedRelative', relation: body.relation, name: who(body.person).name });
        return relative;
      }
      case 'POST versions': {
        const version = addVersion(body);
        record({ action: body.fact ? 'addedVersion' : 'added', ...fact(getVersion(version.id)) });
        return version;
      }
      case 'PUT versions':
        updateVersion(id, body);
        record({ action: 'changed', ...fact(getVersion(id)) });
        return { id };
      case 'POST versions accept':
        acceptVersion(id);
        record({ action: 'accepted', ...fact(getVersion(id)) });
        return { id };
      case 'DELETE versions': {
        const entry = { action: 'removed', ...fact(getVersion(id)) };
        record(entry, removeVersion(id));
        return {};
      }
      case 'POST sources': {
        const { id: sourceId } = put('sources', { id: newId(), kind: body.kind, title: body.title, note: body.note ?? '' });
        record({ action: 'added', kind: 'source', name: body.title });
        return { id: sourceId };
      }
      case 'PUT sources': {
        const row = T.sources.get(id);
        if (!row) throw new Error('No such source.');
        const next = put('sources', { ...row, kind: body.kind ?? row.kind, title: body.title ?? row.title, note: body.note ?? row.note });
        record({ action: 'changed', kind: 'source', name: next.title });
        return { id };
      }
      case 'PUT files':
        if (!T.sources.has(id)) throw new Error('No such source.');
        put('files', { id, type: body.type, data: body.data });
        return {};
      case 'DELETE sources': {
        const removed = removeSource(id);
        record({ action: 'removed', kind: 'source', name: removed.sources[0]?.title }, removed);
        return {};
      }
      case 'PUT colors':
        put('settings', { id: 'colors', value: body });
        return {};
      case 'PUT photos':
        put('photos', { id, data: body.data });
        record({ action: 'changed', field: 'photo', name: who(id).name });
        return {};
      case 'POST log undo':
        record({ action: 'undid', of: restore(id) });
        return {};
    }
  }

  // Changes happen one at a time, and all of one change is kept or none of it.
  function mutate(work) {
    const run = queue.then(async () => {
      const before = Object.fromEntries(TABLES.map((table) => [table, new Map(T[table])]));
      dirty = new Map();
      try {
        const result = work();
        const ops = [...dirty.values()].map(({ table, id }) => ({ table, id, row: T[table].get(id) ?? null }));
        await keeper.write(ops);
        // The keeper may have read tables again part-way through; what was just written stands.
        for (const { table, id, row } of ops) row ? T[table].set(id, row) : T[table].delete(id);
        return result;
      } catch (err) {
        T = before;
        throw err;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // The keeper read a table again. If that leaves the record different from what the page last read,
  // someone else changed it.
  function onTable(table, fresh) {
    T[table] = new Map(fresh.map((row) => [row.id, row]));
    for (const row of fresh) if (typeof row.id === 'number') lastId = Math.max(lastId, row.id);
    clearTimeout(noticing);
    noticing = setTimeout(() => queue.then(() => {
      if (shown && picture() !== shown) for (const changed of watchers) changed();
    }), 400);
  }

  return {
    start: () => keeper.start(onTable),
    onChange: (changed) => watchers.push(changed),
    photo: (nodeId) => T.photos.get(nodeId)?.data ?? '',
    file: (sourceId) => T.files.get(sourceId)?.data ?? '',
    // The same requests the local server answers: api('PUT', 'nodes/12', body) and so on.
    async api(method, path, body = {}) {
      const [collection, rawId, action] = path.split('/');
      const route = [method, collection, action].filter(Boolean).join(' ');
      if (route === 'GET graph') {
        await queue;
        shown = picture();
        // A copy, so the page is free to change what it is given.
        return JSON.parse(JSON.stringify(graph()));
      }
      if (route === 'GET log') {
        return rows('log').reverse().slice(0, 100)
          .map(({ id, at, summary, undone, removed }) => ({ id, at, summary, undone, removable: removed !== null }));
      }
      return mutate(() => {
        // A copy, so nothing kept here is shared with the page.
        const result = change(route, Number(rawId), JSON.parse(JSON.stringify(body)));
        if (result === undefined) throw new Error('Not found');
        return result;
      });
    },
  };
}
