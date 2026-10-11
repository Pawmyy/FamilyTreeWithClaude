// Loads a small sample family so there is something to look at: `npm run seed`.
import { addNode, addVersion, graph, openDb } from './server.js';

const db = openDb(process.env.DB ?? 'family.db');
if (graph(db).nodes.length) {
  console.error('Database already has data; not seeding.');
  process.exit(1);
}

function person(given, family, born, died) {
  const facts = { name: { given, family }, born: { date: born }, died: { date: died } };
  return addNode(db, { kind: 'person', facts }).id;
}

function household(partners, children, props = {}) {
  const id = addNode(db, { kind: 'household', props }).id;
  for (const p of partners) addVersion(db, { node: p, field: 'PARTNER_IN', target: id });
  for (const [child, kind = 'birth'] of children) {
    addVersion(db, { node: child, field: 'CHILD_OF', target: id, value: { kind } });
  }
}

const george = person('George', 'Hale', '1935', '2010');
const helen = person('Helen', 'Moss', 'c. 1938');
const anna = person('Anna', 'Hale', '1962');
const frank = person('Frank', 'Hale', '1965');
const ben = person('Ben', 'Reyes', '1960');
const dee = person('Dee', 'Okafor', '1968');
const ivy = person('Ivy', 'Lind', '1966');
const cara = person('Cara', 'Reyes', '1991');
const eli = person('Eli', 'Reyes', '2004');
const gus = person('Gus', 'Reyes', '2008');
const jack = person('Jack', 'Hale', '1993');
const kai = person('Kai', 'Tran', '1990');
const mona = person('Mona', 'Diaz', '1994');
const lily = person('Lily', 'Tran', '2019');
const noah = person('Noah', 'Hale', '2021');

// Helen took George's family name when they married.
addVersion(db, { node: helen, field: 'name', value: { given: 'Helen', family: 'Hale', from: '1960', reason: 'marriage' } });

household([george, helen], [[anna], [frank]], { start: '1960' });
household([anna, ben], [[cara]], { start: '1990', end: '2001' });
household([ben, dee], [[eli], [gus, 'adopted'], [cara, 'step']], { start: '2003' });
household([frank, ivy], [[jack]]);
household([cara, kai], [[lily]]);
household([jack, mona], [[noah]]);

const town = addNode(db, { kind: 'place', name: 'Chiang Mai' }).id;
addVersion(db, { node: george, field: 'LIVED_IN', target: town });
addVersion(db, { node: helen, field: 'LIVED_IN', target: town });
addVersion(db, { node: ivy, field: 'GODPARENT_OF', target: cara });

console.log('Seeded sample family.');
