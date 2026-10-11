import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildForest, layoutForest } from '../public/tree.js';

// The sample family, with the family names people were born with.
const NAMES = {
  george: 'Hale', helen: 'Moss', anna: 'Hale', frank: 'Hale', ben: 'Reyes', dee: 'Okafor', ivy: 'Lind',
  cara: 'Reyes', eli: 'Reyes', gus: 'Reyes', jack: 'Hale', kai: 'Tran', mona: 'Diaz', lily: 'Tran', noah: 'Hale',
  kanya: 'Tran', prem: 'Tran',
};
const people = Object.entries(NAMES).map(([id, name]) => ({ id, familyName: name, birthFamilyName: name, born: '' }));
const households = [];
const edges = [];
function household(id, partners, children) {
  households.push({ id });
  for (const p of partners) edges.push({ src: p, dst: id, type: 'PARTNER_IN', props: {} });
  for (const [child, kind = 'birth'] of children) edges.push({ src: child, dst: id, type: 'CHILD_OF', props: { kind } });
}
household('GH', ['george', 'helen'], [['anna'], ['frank']]);
household('AB', ['anna', 'ben'], [['cara']]);
household('BD', ['ben', 'dee'], [['eli'], ['gus', 'adopted'], ['cara', 'step']]);
household('FI', ['frank', 'ivy'], [['jack']]);
household('CK', ['cara', 'kai'], [['lily']]);
household('JM', ['jack', 'mona'], [['noah']]);
household('KP', ['kanya', 'prem'], [['kai']]); // Kai's own parents

const forest = buildForest(people, households, edges);
const root = (id) => forest.find((tree) => tree.person === id);
const union = (node, household) => node.unions.find((u) => u.household === household);
const child = (u, id) => u.children.find((c) => c.person === id);

test('one tree per line of descent, the longest first', () => {
  assert.deepEqual(forest.map((tree) => tree.person), ['george', 'ben', 'kanya']);
});

test('a founder who married in stands beside their partner, in full', () => {
  assert.deepEqual(union(root('george'), 'GH').partner, { person: 'helen', copy: false });
  assert.deepEqual(union(root('ben'), 'BD').partner, { person: 'dee', copy: false });
});

test('children are drawn under the parent whose family name they carry', () => {
  // Cara Reyes is under Ben Reyes, not under her mother Anna Hale.
  assert.deepEqual(union(root('ben'), 'AB').children.map((c) => c.person), ['cara']);
  const anna = child(union(root('george'), 'GH'), 'anna');
  assert.deepEqual(union(anna, 'AB'), { household: 'AB', partner: { person: 'ben', copy: true }, children: [], elsewhere: true });
});

test('someone with parents of their own is full under them and a marked copy beside their partner', () => {
  // Lily Tran follows Kai Tran, who is drawn in full under his own parents.
  const kai = child(union(root('kanya'), 'KP'), 'kai');
  assert.equal(kai.copy, false);
  assert.deepEqual(union(kai, 'CK').partner, { person: 'cara', copy: true });
  assert.deepEqual(union(kai, 'CK').children.map((c) => c.person), ['lily']);
  const cara = child(union(root('ben'), 'AB'), 'cara');
  assert.deepEqual(union(cara, 'CK').partner, { person: 'kai', copy: true });
  assert.equal(union(cara, 'CK').elsewhere, true);
});

test('a wife who took her husband\'s name does not pull the children into her own line', () => {
  const trees = buildForest(
    [
      { id: 1, birthFamilyName: 'ศรีสุข', familyName: 'ศรีสุข' }, // her father
      { id: 2, birthFamilyName: 'ศรีสุข', familyName: 'ทองดี' }, // she took her husband's name
      { id: 3, birthFamilyName: 'ทองดี', familyName: 'ทองดี' }, // her husband
      { id: 4, birthFamilyName: 'ทองดี', familyName: 'ทองดี' }, // their child
    ],
    [{ id: 'A' }, { id: 'B' }],
    [
      { src: 1, dst: 'A', type: 'PARTNER_IN', props: {} }, { src: 2, dst: 'A', type: 'CHILD_OF', props: {} },
      { src: 2, dst: 'B', type: 'PARTNER_IN', props: {} }, { src: 3, dst: 'B', type: 'PARTNER_IN', props: {} },
      { src: 4, dst: 'B', type: 'CHILD_OF', props: {} },
    ],
  );
  assert.deepEqual(trees.map((tree) => tree.person), [1, 3]);
  assert.deepEqual(trees[1].unions[0].children.map((c) => c.person), [4]);
  assert.equal(trees[0].unions[0].children[0].unions[0].elsewhere, true);
});

test('step-children stay with the household they descend from', () => {
  assert.deepEqual(union(root('ben'), 'BD').children.map((c) => c.person), ['eli', 'gus']);
});

test('everyone is drawn in full exactly once', () => {
  const { people: drawn } = layoutForest(forest);
  const full = drawn.filter((p) => !p.copy).map((p) => p.person).sort();
  assert.deepEqual(full, Object.keys(NAMES).sort());
  assert.deepEqual(drawn.filter((p) => p.copy).map((p) => p.person).sort(), ['anna', 'ben', 'cara', 'kai']);
});

test('with no family names recorded, the tree reaches children through whoever comes first', () => {
  const plain = people.map((p) => ({ ...p, familyName: '', birthFamilyName: '' }));
  const trees = buildForest(plain, households, edges);
  // George's line now runs through Anna to Cara to Lily; Kai still has his own parents, so he is the copy there.
  assert.deepEqual(trees.map((tree) => tree.person), ['george', 'ben', 'kanya']);
  const cara = child(union(child(union(trees[0], 'GH'), 'anna'), 'AB'), 'cara');
  assert.deepEqual(union(cara, 'CK').children.map((c) => c.person), ['lily']);
  assert.deepEqual(union(cara, 'CK').partner, { person: 'kai', copy: true });
});

test('siblings with unknown parents hang from an empty household, and a looping record still ends', () => {
  const trees = buildForest(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    [{ id: 'H' }, { id: 'X' }, { id: 'Y' }],
    [
      { src: 1, dst: 'H', type: 'CHILD_OF', props: {} }, { src: 2, dst: 'H', type: 'CHILD_OF', props: {} },
      // 3 and 4 are recorded as each other's parent
      { src: 3, dst: 'X', type: 'PARTNER_IN', props: {} }, { src: 4, dst: 'X', type: 'CHILD_OF', props: {} },
      { src: 4, dst: 'Y', type: 'PARTNER_IN', props: {} }, { src: 3, dst: 'Y', type: 'CHILD_OF', props: {} },
    ],
  );
  assert.deepEqual(trees[0], { person: null, copy: false, unions: [{ household: 'H', partner: null, children: [
    { person: 1, copy: false, unions: [] }, { person: 2, copy: false, unions: [] },
  ] }] });
  assert.deepEqual(layoutForest(trees).people.filter((p) => !p.copy).map((p) => p.person).sort(), [1, 2, 3, 4]);
});

test('layout: generations in rows, a couple over the middle of their children, nothing overlapping', () => {
  const { people: drawn, households: hubs, lines } = layoutForest(forest);
  const at = (id) => drawn.find((p) => p.person === id && !p.copy);
  assert.ok(at('george').y > at('anna').y && at('anna').y > at('jack').y - 1, 'older generations are higher');
  assert.equal(at('anna').y, at('frank').y);
  const gh = hubs.find((h) => h.key === 'GH');
  assert.ok(at('george').x < gh.x && gh.x < at('helen').x);

  const spots = [...drawn, ...hubs].map((item) => `${Math.round(item.x)},${item.y}`);
  assert.equal(new Set(spots).size, spots.length, 'no two things share a spot');
  for (const row of new Set(drawn.map((p) => p.y))) {
    const xs = drawn.filter((p) => p.y === row).map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 40, `people in row ${row} are apart`);
  }
  const keys = new Set([...drawn, ...hubs].map((item) => item.key));
  assert.ok(lines.every((l) => keys.has(l.source) && keys.has(l.target)), 'every line joins two drawn things');
});
