// What the website's service does, apart from where it keeps things: accounts' records, the codes that
// share them, their members, and the rows of each record (the same rows web/store.js keeps).
//
// There are no owners and no roles: a record belongs equally to everyone who is a member of it, and
// a code is all it takes to become one.
//
// `db` keeps items by two keys, pk and sk:
//   get(pk, sk) -> item | undefined      put(item)      del(pk, sk)
//   query(pk, { prefix, cursor }) -> { items, next }    a page of a pk's items whose sk starts with prefix
//   bump(pk, sk, field) -> the field's new value, one more than before, counted safely
//   putAll(items)                         many at once
// `files` keeps the pictures and PDFs of sources: putUrl(key, type, size), getUrl(key), removeAll(prefix).
// `users` removes a sign-in: remove(userId).
//
//   R#<record>  !count              { seq }           how many changes the record has had
//               !code               { code }          the code that shares it, once someone has asked for one
//               !member#<user>      { name, email }
//               row#<table>#<id>    { table, id, row, rev }   row is null once removed
//   U#<user>    R#<record>          a record this person is a member of
//               !last               { record }        the one they had open last
//   C#<code>    !                   { record }
import { randomInt, randomUUID } from 'node:crypto';

export const TABLES = ['nodes', 'versions', 'sources', 'photos', 'files', 'log', 'settings'];
const FILE_TYPES = ['image/jpeg', 'application/pdf'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROW_CHARS = 350_000; // the database refuses items much larger than this
const MAX_OPS = 2000;
const GONE_AFTER = 7 * 24 * 3600; // seconds a removed row is remembered, for pages still open to hear of it
// No 0/O, 1/I/L or U, so a code survives being read out over the phone.
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

// Something the person asked for that cannot be done. `message` names a text in public/i18n.js.
export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const R = (record) => 'R#' + record;
const U = (user) => 'U#' + user;
const C = (code) => 'C#' + code;
const tidy = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const shown = (code) => code.match(/.{4}/g).join('-');

export function createService({ db, files, users }) {
  async function all(pk, prefix) {
    const items = [];
    let cursor;
    do {
      const page = await db.query(pk, { prefix, cursor });
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items;
  }

  const membersOf = async (record) =>
    (await all(R(record), '!member#')).map((m) => ({ id: m.sk.slice('!member#'.length), name: m.name, email: m.email }));

  async function mustBeMember(record, user) {
    if (!await db.get(R(record), '!member#' + user.id)) throw new Problem(403, 'account.notMember');
  }

  async function addMember(record, user) {
    await db.put({ pk: R(record), sk: '!member#' + user.id, name: user.name, email: user.email });
    await db.put({ pk: U(user.id), sk: 'R#' + record });
    await db.put({ pk: U(user.id), sk: '!last', record });
  }

  // A new code for a record, in place of any it had. The old one stops working at once.
  async function newCode(record) {
    const old = await db.get(R(record), '!code');
    if (old) await db.del(C(old.code), '!');
    const code = Array.from({ length: 12 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    await db.put({ pk: C(code), sk: '!', record });
    await db.put({ pk: R(record), sk: '!code', code });
    return shown(code);
  }

  // The record and everything in it, for good. Only ever done when nobody is left in it.
  async function destroy(record) {
    const code = await db.get(R(record), '!code');
    if (code) await db.del(C(code.code), '!');
    for (const item of await all(R(record), '')) await db.del(item.pk, item.sk);
    await files.removeAll(`records/${record}/`);
  }

  async function removeMember(record, user, target) {
    await mustBeMember(record, user);
    await db.del(R(record), '!member#' + target);
    await db.del(U(target), 'R#' + record);
    if (!(await membersOf(record)).length) {
      await destroy(record);
      return { deleted: true };
    }
    // Someone put out by the others must not walk back in with the code they were given.
    if (target !== user.id && await db.get(R(record), '!code')) await newCode(record);
    return { deleted: false };
  }

  return {
    // Who is signed in, and the records they can open, each told apart by who is in it.
    async me(user) {
      const mine = (await all(U(user.id), 'R#')).map((item) => item.sk.slice(2));
      const records = await Promise.all(mine.map(async (id) => ({ id, members: (await membersOf(id)).map((m) => m.name) })));
      return { id: user.id, name: user.name, email: user.email, records, last: (await db.get(U(user.id), '!last'))?.record ?? null };
    },

    // A new, empty record with this person as its only member. It has no code until one is asked for.
    async start(user) {
      const id = randomUUID();
      await db.put({ pk: R(id), sk: '!count', seq: 0 });
      await addMember(id, user);
      return { id };
    },

    async join(user, code) {
      const found = await db.get(C(tidy(code)), '!');
      if (!found) throw new Problem(404, 'account.badCode');
      await addMember(found.record, user);
      return { id: found.record };
    },

    async open(record, user) {
      await mustBeMember(record, user);
      await db.put({ pk: U(user.id), sk: '!last', record });
      const code = await db.get(R(record), '!code');
      return { id: record, code: code ? shown(code.code) : null, members: await membersOf(record) };
    },

    // The code that shares a record: made the first time it is asked for, and then the same one for
    // every member until someone replaces it.
    async code(record, user, replace) {
      await mustBeMember(record, user);
      const kept = await db.get(R(record), '!code');
      return { code: kept && !replace ? shown(kept.code) : await newCode(record) };
    },

    // Anyone in a record can take anyone out of it, themselves included.
    removeMember,

    // The sign-in and every membership go; the records stay for whoever else is in them.
    async forget(user) {
      for (const item of await all(U(user.id), 'R#')) await removeMember(item.sk.slice(2), user, user.id);
      await db.del(U(user.id), '!last');
      await users.remove(user.id);
      return {};
    },

    // How many changes the record has had: cheap to ask, so a page asks often and reads rows only when it grows.
    async count(record, user) {
      await mustBeMember(record, user);
      return { seq: (await db.get(R(record), '!count'))?.seq ?? 0 };
    },

    // A page of the record's rows changed after change number `since`. With since 0 it is the whole
    // record as it stands, so rows already removed are left out.
    async rows(record, user, { since = 0, cursor } = {}) {
      await mustBeMember(record, user);
      const seq = cursor ? undefined : (await db.get(R(record), '!count'))?.seq ?? 0;
      const page = await db.query(R(record), { prefix: 'row#', cursor });
      const rows = page.items.filter((item) => item.rev > since && (since > 0 || item.row !== null))
        .map(({ table, id, row, rev }) => ({ table, id, row, rev }));
      return { seq, rows, next: page.next ?? null };
    },

    // Changes to rows: [{ table, id, row, base }], where a null row removes and `base` is the change
    // number of the row as this person last saw it (absent for a new row).
    async write(record, user, ops) {
      await mustBeMember(record, user);
      if (!Array.isArray(ops) || ops.length > MAX_OPS) throw new Problem(400, 'error.notSaved');
      for (const op of ops) {
        if (!TABLES.includes(op.table) || op.id === undefined || op.id === null) throw new Problem(400, 'error.notSaved');
        if (JSON.stringify(op.row ?? null).length > MAX_ROW_CHARS) throw new Problem(413, 'error.full');
      }
      const rev = await db.bump(R(record), '!count', 'seq');
      const gone = Math.floor(Date.now() / 1000) + GONE_AFTER;
      const puts = [];
      for (const op of ops) {
        const sk = `row#${op.table}#${op.id}`;
        if (op.table === 'versions' && op.row && op.base !== undefined) {
          // Someone else changed this version since this person read it. Theirs is not lost: it
          // stays as another version of the same fact, and the one arriving now is the one shown.
          const theirs = await db.get(R(record), sk);
          if (theirs?.row && theirs.rev > op.base && saysOtherwise(theirs.row, op.row)) {
            const id = Date.now() * 1000 + (puts.length % 1000);
            puts.push({ pk: R(record), sk: `row#versions#${id}`, table: 'versions', id, row: { ...theirs.row, id, accepted: false }, rev });
          }
        }
        // The edit log says who made each change.
        const row = op.table === 'log' && op.row && op.base === undefined ? { ...op.row, by: user.name } : op.row ?? null;
        puts.push({ pk: R(record), sk, table: op.table, id: op.id, row, rev, ...(row === null && { gone }) });
      }
      await db.putAll(puts);
      return { seq: rev };
    },

    // Where to send, or read, the file of a source. The addresses work for a few minutes only.
    async fileUpload(record, user, source, { type, size }) {
      await mustBeMember(record, user);
      if (!FILE_TYPES.includes(type)) throw new Problem(400, 'error.fileKind');
      if (!(size > 0 && size <= MAX_FILE_BYTES)) throw new Problem(413, 'error.fileTooLarge');
      return { url: await files.putUrl(`records/${record}/files/${Number(source)}`, type, size) };
    },
    async fileDownload(record, user, source) {
      await mustBeMember(record, user);
      return { url: await files.getUrl(`records/${record}/files/${Number(source)}`) };
    },
  };
}

// Whether two accounts of a version disagree about the fact itself, not only about its sources or standing.
const saysOtherwise = (a, b) => said(a) !== said(b);
// The same text for the same account, whatever order its fields were written in.
const said = (v) => JSON.stringify([v.node, v.field, v.target, Object.entries(v.value ?? {}).sort(([x], [y]) => (x < y ? -1 : 1))]);

// The service by request: (user, 'GET', '/records/abc/rows', body, query) -> the answer.
export function createRouter(service) {
  // "METHOD /path/with/:names" -> what to do with (user, the names, the body, the query).
  const ROUTES = {
    'GET /me': (user) => service.me(user),
    'DELETE /me': (user) => service.forget(user),
    'POST /records': (user) => service.start(user),
    'POST /join': (user, _, body) => service.join(user, body.code),
    'GET /records/:record': (user, { record }) => service.open(record, user),
    'POST /records/:record/code': (user, { record }, body) => service.code(record, user, !!body.replace),
    'DELETE /records/:record/members/:member': (user, { record, member }) => service.removeMember(record, user, member),
    'GET /records/:record/count': (user, { record }) => service.count(record, user),
    'GET /records/:record/rows': (user, { record }, _, query) => service.rows(record, user, { since: Number(query.since ?? 0), cursor: query.cursor }),
    'POST /records/:record/rows': (user, { record }, body) => service.write(record, user, body.ops),
    'POST /records/:record/files/:source': (user, { record, source }, body) => service.fileUpload(record, user, source, body),
    'GET /records/:record/files/:source': (user, { record, source }) => service.fileDownload(record, user, source),
  };

  function find(method, path) {
    const parts = path.split('/');
    for (const [route, run] of Object.entries(ROUTES)) {
      const [routeMethod, routePath] = route.split(' ');
      const shape = routePath.split('/');
      if (routeMethod !== method || shape.length !== parts.length) continue;
      const names = {};
      if (shape.every((piece, i) => (piece.startsWith(':') ? (names[piece.slice(1)] = decodeURIComponent(parts[i])) : piece === parts[i]))) return { run, names };
    }
  }

  return async (user, method, path, body = {}, query = {}) => {
    const found = find(method, path);
    if (!found) throw new Problem(404, 'Not found');
    return found.run(user, found.names, body, query);
  };
}
