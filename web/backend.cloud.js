// Where the record is kept when the page is the website: with the website's service (see aws/), in a
// record shared by everyone who has been given its code. Opening the page means signing in and
// choosing a record first.
import { call, enter, lost } from './account.js';
import { createKeeper } from './keeper.cloud.js';
import { createStore } from './store.js';

let store = null;
let record = null;
const watchers = [];

export const api = (...request) => store.api(...request);
// The page asks to be told of changes before there is a record to watch.
export const onChange = (changed) => watchers.push(changed);
export const photoUrl = (nodeId) => store.photo(nodeId);

// A source's file is kept apart from the rows, and read from an address that works for a few minutes.
export const fileUrl = async (sourceId) => (await call('GET', `records/${record}/files/${sourceId}`)).url;

export async function putFile(sourceId, blob) {
  const { url } = await call('POST', `records/${record}/files/${sourceId}`, { type: blob.type, size: blob.size });
  const sent = await fetch(url, { method: 'PUT', headers: { 'content-type': blob.type }, body: blob });
  if (!sent.ok) throw new Error('error.notSaved');
  await store.api('PUT', `files/${sourceId}`, { type: blob.type, data: 'kept' });
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
  const session = await enter();
  record = session.record;
  store = createStore(createKeeper(call, record, { who: session.name, onLost: lost }));
  for (const changed of watchers) store.onChange(changed);
  await store.start();
  return null;
}
