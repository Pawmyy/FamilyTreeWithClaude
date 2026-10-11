// Three film families to explore, kept apart from your own record: `npm run examples`.
// Builds examples.db afresh each time and serves it on http://localhost:3001.
import { rmSync } from 'node:fs';
import { addNode, addVersion, openDb } from './server.js';

rmSync('examples.db', { force: true });
const db = openDb('examples.db');

// person('Luke', 'Skywalker', 'male', '19 BBY', '34 ABY', 'nickname')
function person(given, family, sex, born, died, nickname) {
  const facts = { name: { given, family }, sex: { sex }, born: { date: born }, died: { date: died } };
  return addNode(db, { kind: 'person', props: nickname ? { nickname } : {}, facts }).id;
}

// household([partners], [child, [child, 'adopted'], ...], married)
function household(partners, children = [], married) {
  const id = addNode(db, { kind: 'household', props: married ? { start: married } : {} }).id;
  for (const p of partners) addVersion(db, { node: p, field: 'PARTNER_IN', target: id });
  for (const entry of children) {
    const [child, kind = 'birth'] = [entry].flat();
    addVersion(db, { node: child, field: 'CHILD_OF', target: id, value: { kind } });
  }
}

// Someone took a new family name, here always at marriage.
function renamed(id, given, family, from) {
  addVersion(db, { node: id, field: 'name', value: { given, family, ...(from && { from }), reason: 'marriage' } });
}

const link = (from, type, to) => addVersion(db, { node: from, field: type, target: to });

// ---- Star Wars: the Skywalkers. Dates are in the films' own calendar, so they stay as text. ----
const shmi = person('Shmi', 'Skywalker', 'female', '72 BBY', '22 BBY');
const cliegg = person('Cliegg', 'Lars', 'male', '', '22 BBY');
const owen = person('Owen', 'Lars', 'male', '52 BBY', '0 BBY');
const beru = person('Beru', 'Whitesun', 'female', '47 BBY', '0 BBY');
const anakin = person('Anakin', 'Skywalker', 'male', '41 BBY', '4 ABY', 'Darth Vader');
const padme = person('Padmé', 'Amidala', 'female', '46 BBY', '19 BBY');
const luke = person('Luke', 'Skywalker', 'male', '19 BBY', '34 ABY');
const leia = person('Leia', 'Organa', 'female', '19 BBY', '35 ABY');
const bail = person('Bail', 'Organa', 'male', '67 BBY', '0 BBY');
const breha = person('Breha', 'Organa', 'female', '', '0 BBY');
const han = person('Han', 'Solo', 'male', '32 BBY', '34 ABY');
const ben = person('Ben', 'Solo', 'male', '5 ABY', '35 ABY', 'Kylo Ren');
renamed(beru, 'Beru', 'Lars');

household([shmi], [anakin]); // no father
household([cliegg], [owen]);
household([cliegg, shmi], [[owen, 'step'], [anakin, 'step']]);
household([anakin, padme], [luke, leia], '22 BBY');
household([owen, beru], [[luke, 'foster']]);
household([bail, breha], [[leia, 'adopted']]);
household([han, leia], [ben]);

// ---- The Godfather: the Corleones ----
const vito = person('Vito', 'Andolini', 'male', '1891', '1955', 'Don Corleone');
const carmela = person('Carmela', 'Corleone', 'female', '1897', '1959');
const sonny = person('Santino', 'Corleone', 'male', '1916', '1948', 'Sonny');
const fredo = person('Frederico', 'Corleone', 'male', '1919', '1959', 'Fredo');
const michael = person('Michael', 'Corleone', 'male', '1920', '1997');
const connie = person('Constanzia', 'Corleone', 'female', 'c. 1927', '', 'Connie');
const tom = person('Tom', 'Hagen', 'male', 'c. 1910', '');
const sandra = person('Sandra', 'Corleone', 'female');
const lucy = person('Lucy', 'Mancini', 'female');
const vincent = person('Vincent', 'Mancini', 'male', '1948', '');
const apollonia = person('Apollonia', 'Vitelli', 'female', '', '1948');
const kay = person('Kay', 'Adams', 'female');
const anthony = person('Anthony', 'Corleone', 'male', '1951', '');
const mary = person('Mary', 'Corleone', 'female', '1953', '1979');
const carlo = person('Carlo', 'Rizzi', 'male', '', '1955');
// Vito was given the name of his village on arriving in America.
addVersion(db, { node: vito, field: 'name', value: { given: 'Vito', family: 'Corleone', from: '1901', reason: 'other' } });
renamed(apollonia, 'Apollonia', 'Corleone', '1948');
renamed(kay, 'Kay', 'Corleone', '1951');
renamed(connie, 'Constanzia', 'Rizzi', '1945');

household([vito, carmela], [sonny, fredo, michael, connie, [tom, 'foster']]);
household([sonny, sandra]);
household([sonny, lucy], [vincent]);
household([michael, apollonia], [], '1948');
household([michael, kay], [anthony, mary], '1951');
household([carlo, connie], [], '1945');
const corleone = addNode(db, { kind: 'place', name: 'Corleone, Sicily' }).id;
link(vito, 'BORN_IN', corleone);
link(vito, 'GODPARENT_OF', anthony);

// ---- Harry Potter: the Weasleys and the Potters ----
const arthur = person('Arthur', 'Weasley', 'male', '1950', '');
const molly = person('Molly', 'Prewett', 'female', '1949', '');
const bill = person('William', 'Weasley', 'male', '1970', '', 'Bill');
const charlie = person('Charles', 'Weasley', 'male', '1972', '', 'Charlie');
const percy = person('Percy', 'Weasley', 'male', '1976', '');
const fred = person('Fred', 'Weasley', 'male', '1978', '1998');
const george = person('George', 'Weasley', 'male', '1978', '');
const ron = person('Ronald', 'Weasley', 'male', '1980', '', 'Ron');
const ginny = person('Ginevra', 'Weasley', 'female', '1981', '', 'Ginny');
const fleur = person('Fleur', 'Delacour', 'female', '1977', '');
const hermione = person('Hermione', 'Granger', 'female', '1979', '');
const james = person('James', 'Potter', 'male', '1960', '1981');
const lily = person('Lily', 'Evans', 'female', '1960', '1981');
const petunia = person('Petunia', 'Evans', 'female');
const vernon = person('Vernon', 'Dursley', 'male');
const dudley = person('Dudley', 'Dursley', 'male', '1980', '');
const harry = person('Harry', 'Potter', 'male', '1980', '');
const jamesSirius = person('James Sirius', 'Potter', 'male');
const albus = person('Albus Severus', 'Potter', 'male');
const lilyLuna = person('Lily Luna', 'Potter', 'female');
const rose = person('Rose', 'Granger-Weasley', 'female');
const hugo = person('Hugo', 'Granger-Weasley', 'male');
renamed(molly, 'Molly', 'Weasley');
renamed(lily, 'Lily', 'Potter');
renamed(petunia, 'Petunia', 'Dursley');
renamed(ginny, 'Ginevra', 'Potter');
renamed(fleur, 'Fleur', 'Weasley', '1997');

household([arthur, molly], [bill, charlie, percy, fred, george, ron, ginny]);
household([], [lily, petunia]); // the Evans parents are never named
household([james, lily], [harry]);
household([vernon, petunia], [dudley, [harry, 'foster']]);
household([bill, fleur], [], '1997');
household([harry, ginny], [jamesSirius, albus, lilyLuna]);
household([ron, hermione], [rose, hugo]);

console.log('Built examples.db: the Skywalkers, the Corleones, and the Weasleys and Potters.');
