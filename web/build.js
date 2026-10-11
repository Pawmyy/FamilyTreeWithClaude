// Build the page for the places it runs besides `npm start`, into dist/:
//
//   node web/build.js            all of them
//   node web/build.js artifact   one of them
//
//   artifact  a claude.ai artifact; the record is kept in the artifact's shared database
//   desktop   the desktop app (desktop/main.js); the record is kept by server.js, as with `npm start`
//   mobile    the phone app and the page installed from the web; the record is kept on the device
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (path) => new URL('../' + path, import.meta.url);
// The Google Maps key for the apps, from the environment or a .env file (see public/key.js).
try {
  process.loadEnvFile(fileURLToPath(at('.env')));
} catch { /* no .env */ }
const MAPS_KEY = process.env.GOOGLE_MAPS_KEY ?? '';
const read = (path) => readFileSync(at(path), 'utf8');
const swap = (text, from, to) => {
  if (!text.includes(from)) throw new Error('Nothing to replace: ' + from);
  return text.replaceAll(from, to);
};
function fresh(dir) {
  rmSync(at(dir), { recursive: true, force: true });
  mkdirSync(at(dir), { recursive: true });
  return (path, text) => writeFileSync(at(`${dir}/${path}`), text);
}

// An artifact may only load scripts from a few hosts, so the 3D libraries come from jsDelivr, all of
// them sharing one copy of three.js, and the label sprite is the copy in web/vendor/. It also cannot
// reach a map service, so the map is left out.
function artifact() {
  const THREE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/+esm';
  const write = fresh('dist/artifact');
  for (const file of ['finder.js', 'i18n.js', 'kinship.js', 'record.js', 'terms.js', 'tree.js']) cpSync(at('public/' + file), at('dist/artifact/' + file));
  write('store.js', swap(read('web/store.js'), '../public/record.js', './record.js'));
  cpSync(at('web/backend.artifact.js'), at('dist/artifact/backend.js'));
  cpSync(at('web/map.none.js'), at('dist/artifact/map.js'));
  write('spritetext.js', swap(read('web/vendor/three-spritetext.mjs'), "from 'three'", `from '${THREE}'`));

  let app = read('public/app.js');
  app = swap(app, 'https://esm.sh/3d-force-graph@1.80.1?deps=three@0.186.1', 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.1/+esm');
  app = swap(app, 'https://esm.sh/three-spritetext@1.10.0?deps=three@0.186.1', './spritetext.js');
  app = swap(app, 'https://esm.sh/three@0.186.1', THREE);
  write('app.js', app);

  // The artifact supplies the document around the page, so only the title, the styles and the body go in.
  const page = read('public/index.html');
  const title = page.match(/<title>.*<\/title>/)[0];
  const body = swap(page.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>')), 'src="app.js"', 'src="./app.js"');
  write('index.html', `${title}\n<style>\n${read('public/app.css')}</style>\n${body.trim()}\n`);
}

// An app has to open without the internet, so the page and the libraries it fetches in the browser
// (the copies in node_modules) are packed into one file. `backend` says where the record is kept.
// Only the map still needs the internet: Google's map code cannot be packed.
async function packed(dir, backend) {
  const write = fresh(dir);
  await build({
    entryPoints: [fileURLToPath(at('public/app.js'))],
    outfile: fileURLToPath(at(`${dir}/app.js`)),
    bundle: true, format: 'esm', minify: true, legalComments: 'none', logLevel: 'warning',
    plugins: [{
      name: 'family-graph',
      setup(pack) {
        // https://esm.sh/three@0.186.1 and the like: the package of that name.
        pack.onResolve({ filter: /^https:\/\/esm\.sh\// }, ({ path, resolveDir, kind }) =>
          pack.resolve(path.match(/esm\.sh\/((?:@[^/]+\/)?[^@?]+)/)[1], { resolveDir, kind }));
        if (backend) pack.onResolve({ filter: /^\.\/backend\.js$/ }, () => ({ path: fileURLToPath(at(backend)) }));
        pack.onLoad({ filter: /[\\/]public[\\/]key\.js$/ }, () => ({ contents: `export const GOOGLE_MAPS_KEY = ${JSON.stringify(MAPS_KEY)};` }));
      },
    }],
  });
  if (!MAPS_KEY) console.warn(`${dir}: no GOOGLE_MAPS_KEY, so this build has no map.`);
  write('app.css', read('public/app.css'));
  return { write, page: read('public/index.html') };
}

async function desktop() {
  const { write, page } = await packed('dist/desktop', null);
  write('index.html', page);
}

async function mobile() {
  const { write, page } = await packed('dist/mobile', 'web/backend.local.js');
  cpSync(at('web/manifest.webmanifest'), at('dist/mobile/manifest.webmanifest'));
  cpSync(at('web/sw.js'), at('dist/mobile/sw.js'));
  cpSync(at('web/icons'), at('dist/mobile/icons'), { recursive: true });
  // What a phone needs to install the page as an app and fit it around the notch.
  let installable = swap(page, '<meta name="viewport" content="width=device-width, initial-scale=1">', `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2748c9">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">`);
  installable = swap(installable, '</body>', `<script>
// Inside the phone app the files are already on the device; on the web, keep them for when it is offline.
if ('serviceWorker' in navigator && !window.Capacitor) navigator.serviceWorker.register('sw.js');
</script>
</body>`);
  write('index.html', installable);
}

const targets = { artifact, desktop, mobile };
for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(targets)) {
  if (!targets[name]) throw new Error(`No such build: ${name}. Choose from ${Object.keys(targets).join(', ')}.`);
  await targets[name]();
  console.log(`Built dist/${name}/`);
}
