import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kinship, shortestPath } from '../public/kinship.js';
import { kinshipTerm } from '../public/terms.js';

// Tiny fixture builder: people are just string ids.
let nextId = 1;
const edges = [];
function family(partners, children) {
  const union = 'u' + nextId++;
  for (const p of partners) edges.push({ id: nextId++, src: p, dst: union, type: 'PARTNER_IN', props: {} });
  for (const [child, kind = 'birth'] of children) {
    edges.push({ id: nextId++, src: child, dst: union, type: 'CHILD_OF', props: { kind } });
  }
}

family(['george', 'helen'], [['anna'], ['frank']]);
family(['anna', 'ben'], [['cara']]);
family(['ben', 'dee'], [['eli'], ['gus', 'adopted'], ['cara', 'step']]);
family(['frank', 'ivy'], [['jack']]);
family(['cara', 'kai'], [['lily']]);
family(['jack', 'mona'], [['noah']]);
family(['lily', 'omar'], [['pia']]);
family([], [['quin'], ['rae']]); // parents not recorded
family(['rae', 'sol'], [['tess']]);
edges.push({ id: nextId++, src: 'ivy', dst: 'cara', type: 'GODPARENT_OF', props: {} });
edges.push({ id: nextId++, src: 'zed', dst: 'town', type: 'LIVED_IN', props: {} });

// The neutral English wording, with nothing known about anyone's sex or age.
const rel = (a, b) => {
  const found = kinship(a, b, edges);
  return found && kinshipTerm(found, 'en');
};

// Wording when sexes and birth years are recorded.
const PEOPLE = {
  george: { sex: 'male', born: '1935' }, helen: { sex: 'female', born: '2481' }, // Buddhist Era for 1938
  anna: { sex: 'female', born: '1962' }, frank: { sex: 'male', born: '1965' }, ben: { sex: 'male', born: '1960' },
  cara: { sex: 'female', born: '1991' }, eli: { sex: 'male', born: '2004' }, jack: { sex: 'male', born: '1993' },
  lily: { sex: 'female', born: '2019' }, kai: { sex: 'male' },
};
const term = (a, b, lang) => {
  const found = kinship(a, b, edges);
  return kinshipTerm(found, lang, { A: PEOPLE[a], B: PEOPLE[b], via: PEOPLE[found.via] });
};

test('direct line', () => {
  assert.equal(rel('anna', 'cara'), 'parent');
  assert.equal(rel('cara', 'anna'), 'child');
  assert.equal(rel('george', 'cara'), 'grandparent');
  assert.equal(rel('lily', 'george'), 'great-grandchild');
  assert.equal(rel('george', 'pia'), 'great-great-grandparent');
});

test('siblings and half-siblings', () => {
  assert.equal(rel('anna', 'frank'), 'sibling');
  assert.equal(rel('cara', 'eli'), 'half-sibling');
});

test('children of a family with no recorded parents are still siblings', () => {
  assert.equal(rel('quin', 'rae'), 'sibling');
  assert.equal(rel('quin', 'tess'), 'aunt/uncle');
  assert.equal(rel('quin', 'cara'), null);
});

test('adoption counts as descent, step does not', () => {
  assert.equal(rel('gus', 'eli'), 'sibling');
  assert.equal(rel('ben', 'gus'), 'parent');
  assert.equal(rel('dee', 'cara'), null);
});

test('aunts, uncles, nieces, nephews', () => {
  assert.equal(rel('frank', 'cara'), 'aunt/uncle');
  assert.equal(rel('cara', 'frank'), 'niece/nephew');
  assert.equal(rel('frank', 'lily'), 'great-aunt/uncle');
  assert.equal(rel('lily', 'frank'), 'great-niece/nephew');
});

test('cousins', () => {
  assert.equal(rel('cara', 'jack'), 'first cousin');
  assert.equal(rel('lily', 'noah'), 'second cousin');
  assert.equal(rel('lily', 'jack'), 'first cousin once removed');
  assert.equal(rel('pia', 'noah'), 'second cousin once removed');
  assert.equal(rel('pia', 'jack'), 'first cousin twice removed');
});

test('partners, in-laws, strangers', () => {
  assert.equal(rel('anna', 'ben'), 'partner');
  assert.equal(rel('ivy', 'anna'), null);
  assert.equal(rel('cara', 'cara'), 'self');
});

test('English uses sex when it is recorded', () => {
  assert.equal(term('anna', 'cara', 'en'), 'mother');
  assert.equal(term('george', 'lily', 'en'), 'great-grandfather');
  assert.equal(term('frank', 'cara', 'en'), 'uncle');
  assert.equal(term('cara', 'frank', 'en'), 'niece');
  assert.equal(term('eli', 'cara', 'en'), 'half-brother');
  assert.equal(term('kai', 'cara', 'en'), 'husband');
});

test('Thai picks the word by sex, side of the family and who is older', () => {
  assert.equal(term('george', 'cara', 'th'), 'ตา', "mother's father");
  assert.equal(term('helen', 'cara', 'th'), 'ยาย', "mother's mother");
  assert.equal(term('george', 'jack', 'th'), 'ปู่', "father's father");
  assert.equal(term('helen', 'jack', 'th'), 'ย่า', "father's mother");
  assert.equal(term('frank', 'cara', 'th'), 'น้า', "mother's younger sibling");
  assert.equal(term('anna', 'jack', 'th'), 'ป้า', "father's older sister");
  assert.equal(term('anna', 'frank', 'th'), 'พี่สาว');
  assert.equal(term('frank', 'anna', 'th'), 'น้องชาย');
  assert.equal(term('cara', 'jack', 'th'), 'ลูกพี่ลูกน้อง');
  assert.equal(term('lily', 'george', 'th'), 'เหลน');
});

test('Thai falls back to a neutral phrase when sex or age is not recorded', () => {
  const neutral = (a, b) => kinshipTerm(kinship(a, b, edges), 'th');
  assert.equal(neutral('frank', 'cara'), 'พี่น้องของพ่อแม่');
  assert.equal(neutral('george', 'cara'), 'ปู่ย่าตายาย');
  assert.equal(neutral('anna', 'frank'), 'พี่น้อง');
});

test('shortestPath walks any link type in either direction', () => {
  const path = shortestPath('ivy', 'cara', edges);
  assert.deepEqual(path.map((s) => s.edge.type), ['GODPARENT_OF']);

  const inLaw = shortestPath('kai', 'anna', edges);
  assert.deepEqual(inLaw.map((s) => s.to).at(-1), 'anna');
  assert.equal(inLaw.length, 4); // kai -> union -> cara -> union -> anna

  assert.deepEqual(shortestPath('cara', 'cara', edges), []);
  assert.equal(shortestPath('cara', 'zed', edges), null);
});
