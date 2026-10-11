// Where the record is kept when the page is an app on a phone or a page installed from the web:
// in this device's own browser database (IndexedDB). Nothing leaves the device.
import { createStore, TABLES } from './store.js';

const ROWS = 'rows';
let idb = null;

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('error.notSaved'));
});

const keeper = {
  async start(onTable) {
    const opening = indexedDB.open('family-graph', 1);
    // Every row of every table in one place, under "table/id".
    opening.onupgradeneeded = () => opening.result.createObjectStore(ROWS, { keyPath: 'key' });
    idb = await done(opening);
    const kept = await done(idb.transaction(ROWS).objectStore(ROWS).getAll());
    for (const table of TABLES) onTable(table, kept.filter((entry) => entry.table === table).map((entry) => entry.row));
    // Ask the browser not to clear the record when the device runs short of space.
    navigator.storage?.persist?.().catch(() => {});
  },

  // All of one change in one transaction, so it is kept whole or not at all.
  write: (ops) => new Promise((resolve, reject) => {
    const tx = idb.transaction(ROWS, 'readwrite');
    for (const { table, id, row } of ops) {
      const key = `${table}/${id}`;
      if (row) tx.objectStore(ROWS).put({ key, table, row });
      else tx.objectStore(ROWS).delete(key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError' ? 'error.full' : 'error.notSaved'));
  }),
};

const store = createStore(keeper);

export const api = store.api;
export const onChange = store.onChange;
export const photoUrl = store.photo;
export const fileUrl = store.file;

const asDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('error.image'));
  reader.readAsDataURL(blob);
});

export async function putPhoto(nodeId, jpeg) {
  await store.api('PUT', `photos/${nodeId}`, { data: await asDataUrl(jpeg) });
}

export async function putFile(sourceId, blob) {
  await store.api('PUT', `files/${sourceId}`, { type: blob.type, data: await asDataUrl(blob) });
}

export async function start() {
  await store.start();
  return null;
}
