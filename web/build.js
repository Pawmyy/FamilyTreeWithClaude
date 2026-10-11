// Build the page for a claude.ai artifact into dist/artifact/: the same page as public/, with the record
// kept in the artifact's database instead of the local server (see backend.artifact.js).
//
//   node web/build.js
//
// An artifact may only load scripts from a few hosts, so the 3D libraries come from jsDelivr, all of
// them sharing one copy of three.js, and the label sprite is the copy in web/vendor/.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const at = (path) => new URL('../' + path, import.meta.url);
const read = (path) => readFileSync(at(path), 'utf8');
const write = (path, text) => writeFileSync(at('dist/artifact/' + path), text);
const swap = (text, from, to) => {
  if (!text.includes(from)) throw new Error('Nothing to replace: ' + from);
  return text.replaceAll(from, to);
};

const THREE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/+esm';

rmSync(at('dist/artifact'), { recursive: true, force: true });
mkdirSync(at('dist/artifact'), { recursive: true });

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

console.log('Built dist/artifact/');
