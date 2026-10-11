// Where the record is kept when the page is a claude.ai artifact: the artifact's own shared database,
// one document per row, so everyone the artifact is shared with sees and edits the same family.
// Opened where there is no such database (signed out, or straight from a file), it keeps the record
// in memory only and says so.
import { createStore, TABLES } from './store.js';

const ERRORS = {
  invalid_argument: 'error.readOnly', not_granted: 'error.readOnly', revoked: 'error.readOnly', quota_exceeded: 'error.full',
  too_large: 'error.fileTooLarge', unsupported_type: 'error.fileKind', quota_or_state: 'error.full',
};
const AT_ONCE = 4;

let db = null;
let assets = null; // the artifact's own file store; only those who may change the record are given it

const keeper = {
  // Each table is a collection, watched for as long as the page is open.
  start: (onTable) => Promise.all(TABLES.map((table) => new Promise((resolve) => {
    if (!db) return resolve();
    // A first answer from the cache may be incomplete, so wait a little for the real one.
    const giveUp = setTimeout(resolve, 8000);
    db.collection(table).onSnapshot((snap) => {
      onTable(table, snap.docs.map((doc) => doc.data()));
      if (snap.metadata.fromCache) return;
      clearTimeout(giveUp);
      resolve();
    }, () => resolve());
  }))),

  async write(ops) {
    if (!db) return;
    try {
      // Different documents may be written together; a few at a time keeps within the store's limits.
      for (let i = 0; i < ops.length; i += AT_ONCE) {
        await Promise.all(ops.slice(i, i + AT_ONCE).map(({ table, id, row }) => {
          const doc = db.collection(table).doc(String(id));
          return row ? doc.set(row) : doc.delete();
        }));
      }
    } catch (err) {
      throw new Error(ERRORS[err?.code] ?? 'error.notSaved');
    }
  },
};

const store = createStore(keeper);

export const api = store.api;
export const onChange = store.onChange;
export const photoUrl = store.photo;
export const fileUrl = store.file;

// A source's file is too big for a row of the database, so it goes to the artifact's file store and the
// row keeps where to read it from. A removed source leaves its file there, for undoing the removal.
export async function putFile(sourceId, blob) {
  if (!assets) throw new Error('error.readOnly');
  let kept;
  try {
    kept = await assets.upload(blob);
  } catch (err) {
    throw new Error(ERRORS[err?.code] ?? 'error.notSaved');
  }
  await store.api('PUT', `files/${sourceId}`, { type: blob.type, data: '/_blob/' + kept.id });
}

export async function putPhoto(nodeId, jpeg) {
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('error.image'));
    reader.readAsDataURL(jpeg);
  });
  await store.api('PUT', `photos/${nodeId}`, { data });
}

export async function start() {
  db = (await window.claude?.use('db')) ?? null;
  assets = (await window.claude?.use('assets')) ?? null;
  await store.start();
  return db ? null : 'notice.unsaved';
}
