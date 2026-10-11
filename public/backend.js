// Where the record is kept. Here it is the local server (server.js); the builds that run without one
// swap this file for their own with the same exports (see web/).

export async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export const photoUrl = (nodeId) => '/api/photos/' + nodeId;

export async function putPhoto(nodeId, jpeg) {
  const res = await fetch('/api/photos/' + nodeId, { method: 'PUT', body: jpeg });
  if (!res.ok) throw new Error((await res.json()).error);
}

// Get ready to read the record. Resolves to the name of a text to keep on screen, or null.
export const start = async () => null;

// `changed()` is called when someone else changes the record. The local server has one user.
export function onChange() {}
