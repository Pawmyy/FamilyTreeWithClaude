import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fuzzyScore, rank } from '../public/finder.js';
import { has, keysOf } from '../public/i18n.js';

test('English and Thai define exactly the same texts', () => {
  assert.deepEqual(keysOf('th'), keysOf('en'));
});

test('every text the page asks for by name exists', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const asked = [
    ...[...page.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]),
    // Only whole keys; t('kind.' + kind) and the like are built at run time.
    ...[...app.matchAll(/\bt\('([^']+)'\s*[,)]/g)].map((m) => m[1]),
  ];
  assert.deepEqual(asked.filter((key) => !has(key)), []);
});

test('the finder ranks names, in English or Thai, forgiving skipped letters', () => {
  const items = [
    { id: 1, label: 'Somsri Boonmee', keys: ['Somsri Boonmee', 'Noi', 'Kaewta'] },
    { id: 2, label: 'Somchai Srisai', keys: ['Somchai Srisai'] },
    { id: 3, label: 'มาลี ศรีใส', keys: ['มาลี ศรีใส', 'เล็ก'] },
  ];
  const ids = (query) => rank(query, items).map((item) => item.id);
  assert.deepEqual(ids('som'), [2, 1], 'both match; the tighter match first');
  assert.deepEqual(ids('kaewta'), [1], 'found by a former family name');
  assert.deepEqual(ids('NOI'), [1], 'found by nickname, any letter case');
  assert.deepEqual(ids('smsr'), [1, 2], 'letters in order, with gaps; fewer gaps first');
  assert.deepEqual(ids('ศรี'), [3]);
  assert.deepEqual(ids('เล็ก'), [3]);
  assert.deepEqual(ids('zzz'), []);
  assert.equal(ids('').length, 3, 'an empty search lists everyone');
  assert.ok(fuzzyScore('som', 'Somsri') > fuzzyScore('som', 'Awesome'));
});
