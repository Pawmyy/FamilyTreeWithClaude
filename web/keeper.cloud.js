// A keeper (see store.js) for a record held by the website's service, which several people may be
// changing at once. `call(method, path, body)` asks the service as whoever is signed in.
//
// Every row carries the number of the change that last touched it. The keeper asks now and then how
// many changes the record has had, and reads only the rows changed since it last looked.
import { TABLES } from './store.js';

// `every` is how often to look for other people's changes, in milliseconds (0: only when check() is called).
// `who` is the name of whoever is signed in. `onLost(err)` is called when the record can no longer be read.
export function createKeeper(call, record, { every = 10000, who = '', onLost = () => {} } = {}) {
  const tables = Object.fromEntries(TABLES.map((table) => [table, new Map()]));
  const revs = new Map(); // "table/id" -> the change number of that row as last read or written here
  let seen = 0; // the change number everything here is up to date with
  let tell = () => {};

  async function read(since) {
    const rows = [];
    let seq, cursor;
    do {
      const page = await call('GET', `records/${record}/rows?since=${since}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      seq ??= page.seq;
      rows.push(...page.rows);
      cursor = page.next;
    } while (cursor);
    return { seq, rows };
  }

  function take({ seq, rows }) {
    const changed = new Set();
    for (const { table, id, row, rev } of rows) {
      revs.set(`${table}/${id}`, rev);
      row ? tables[table].set(id, row) : tables[table].delete(id);
      changed.add(table);
    }
    seen = Math.max(seen, seq);
    return changed;
  }

  // Look for changes made elsewhere, and pass on the tables they touched.
  async function check() {
    try {
      if ((await call('GET', `records/${record}/count`)).seq <= seen) return;
      for (const table of take(await read(seen))) tell(table, [...tables[table].values()]);
    } catch (err) {
      onLost(err);
    }
  }

  return {
    who: () => who,
    check,
    async start(onTable) {
      tell = onTable;
      take(await read(0));
      for (const table of TABLES) tell(table, [...tables[table].values()]);
      // Only while the page is in view: a tab left open in the background asks nothing.
      if (every) setInterval(() => document.visibilityState === 'visible' && check(), every);
    },
    async write(ops) {
      const { seq } = await call('POST', `records/${record}/rows`, {
        ops: ops.map(({ table, id, row }) => ({ table, id, row, base: revs.get(`${table}/${id}`) })),
      });
      for (const { table, id, row } of ops) {
        revs.set(`${table}/${id}`, seq);
        row ? tables[table].set(id, row) : tables[table].delete(id);
      }
      // If nobody else changed anything in between, there is nothing new to read.
      if (seq === seen + 1) seen = seq;
    },
  };
}
