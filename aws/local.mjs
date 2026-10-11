// The website on this computer, for trying it out: `npm run website`, then http://localhost:3100.
//
// The page and the service are the real ones. Signing in is real too, against the sign-in the stack
// set up (CLOUD_REGION and CLOUD_CLIENT_ID, from the environment or .env), so it needs the internet
// and a deployed stack. But the records and files are kept only in this program's memory: nothing
// here reaches the records on AWS, and everything is gone when it stops.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, createService, Problem } from './api/service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = join(ROOT, 'dist', 'cloud', '/');
const PORT = process.env.PORT ?? 3100;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch { /* no .env */ }
execFileSync(process.execPath, [join(ROOT, 'web', 'build.js'), 'cloud'], { stdio: 'inherit' });

const items = new Map();
const kept = new Map(); // files: path -> { type, data }
const key = (pk, sk) => pk + '\n' + sk;
const db = {
  get: async (pk, sk) => structuredClone(items.get(key(pk, sk))),
  put: async (item) => void items.set(key(item.pk, item.sk), structuredClone(item)),
  putAll: async (all) => { for (const item of all) await db.put(item); },
  del: async (pk, sk) => void items.delete(key(pk, sk)),
  query: async (pk, { prefix = '' } = {}) => ({ items: structuredClone([...items.values()].filter((item) => item.pk === pk && item.sk.startsWith(prefix))) }),
  async bump(pk, sk, field) {
    const item = items.get(key(pk, sk)) ?? { pk, sk };
    item[field] = (item[field] ?? 0) + 1;
    items.set(key(pk, sk), item);
    return item[field];
  },
};
const files = {
  putUrl: async (path) => `http://localhost:${PORT}/local-files/${path}`,
  getUrl: async (path) => `http://localhost:${PORT}/local-files/${path}`,
  removeAll: async (prefix) => { for (const path of kept.keys()) if (path.startsWith(prefix)) kept.delete(path); },
};
// Here a deleted account only loses its records; the sign-in itself is left alone.
const users = { remove: async () => {} };
const route = createRouter(createService({ db, files, users }));

const body = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};
const send = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/local-files/')) {
      const path = pathname.slice('/local-files/'.length);
      if (req.method === 'PUT') {
        kept.set(path, { type: req.headers['content-type'], data: await body(req) });
        return res.writeHead(200).end();
      }
      const file = kept.get(path);
      return file ? res.writeHead(200, { 'content-type': file.type }).end(file.data) : res.writeHead(404).end();
    }
    if (pathname.startsWith('/api/')) {
      // On AWS the sign-in is checked before the service is reached. Here it is only read, which is
      // enough on a computer nobody else can reach.
      const claims = JSON.parse(Buffer.from((req.headers.authorization ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}');
      if (!claims.sub) return send(res, 401, { error: 'account.signedOut' });
      const user = { id: claims.sub, name: claims.name || claims.email, email: claims.email };
      const sent = (await body(req)).toString();
      return send(res, 200, await route(user, req.method, pathname.slice('/api'.length), sent ? JSON.parse(sent) : {}, Object.fromEntries(searchParams)));
    }
    const file = join(PAGE, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(PAGE)) throw new Problem(404, 'Not found');
    const data = await readFile(file).catch(() => { throw new Problem(404, 'Not found'); });
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch (err) {
    send(res, err instanceof Problem ? err.status : 500, { error: err instanceof Problem ? err.message : 'error.notSaved' });
    if (!(err instanceof Problem)) console.error(err);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`The website is running on this computer at http://localhost:${PORT} (records are kept in memory only)`));
