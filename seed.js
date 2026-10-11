// Loads a made-up Thai family, four generations across four surnames, so there is something to look at:
// `npm run seed`. Everyone here is invented. Years are in the Buddhist Era, as a Thai family would write them.
import { addNode, addVersion, graph, openDb } from './server.js';

const db = openDb(process.env.DB ?? 'family.db');
if (graph(db).nodes.length) {
  console.error('Database already has data; not seeding.');
  process.exit(1);
}

const M = 'male';
const F = 'female';

// person('สมชาย', 'ศรีสุข', M, '2492', '', 'ชาย')
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

// She took her husband's family name when they married.
function tookName(id, given, family, from) {
  addVersion(db, { node: id, field: 'name', value: { given, family, from, reason: 'marriage' } });
}

const place = (name, lat, lng) => addNode(db, { kind: 'place', name, props: { lat, lng } }).id;
const link = (people, type, where) => people.forEach((p) => addVersion(db, { node: p, field: type, target: where }));

// ---- ศรีสุข, from Chiang Mai ----
const boonmee = person('บุญมี', 'ศรีสุข', M, '2468', '2545');
const khamkaew = person('คำแก้ว', 'ใจดี', F, '2472', '2553');
const somchai = person('สมชาย', 'ศรีสุข', M, '2492', '', 'ชาย');
const somsri = person('สมศรี', 'ศรีสุข', F, '2495', '', 'ศรี');
const somsak = person('สมศักดิ์', 'ศรีสุข', M, '2499', '2560', 'ศักดิ์');
const thanakorn = person('ธนากร', 'ศรีสุข', M, '2519', '', 'ต้น');
const kanokwan = person('กนกวรรณ', 'ศรีสุข', F, '2522', '', 'นก');
const piya = person('ปิยะ', 'ศรีสุข', M, '2528', '', 'ปิ');
const duangjai = person('ดวงใจ', 'ศรีสุข', F, '2533', '', 'ใจ');
const phumiphat = person('ภูมิพัฒน์', 'ศรีสุข', M, '2550', '', 'ภูมิ');
const pimchanok = person('พิมพ์ชนก', 'ศรีสุข', F, '2553', '', 'พิม');

// ---- แก้วมณี, from Khon Kaen ----
const thongkham = person('ทองคำ', 'แก้วมณี', M, '2465', '2540');
const buaphan = person('บัวผัน', 'สีดา', F, '2470', '2548');
const malee = person('มาลี', 'แก้วมณี', F, '2496', '', 'ลี');
const manop = person('มานพ', 'แก้วมณี', M, '2500', '', 'นพ');
const maneerat = person('มณีรัตน์', 'แก้วมณี', F, '2504', '', 'รัตน์');
const anucha = person('อนุชา', 'แก้วมณี', M, '2530', '', 'เอ');
const orathai = person('อรทัย', 'แก้วมณี', F, '2533', '', 'อ้อ');
const kawin = person('กวิน', 'แก้วมณี', M, '2557', '', 'วิน');

// ---- ทองดี, from Bangkok ----
const prasert = person('ประเสริฐ', 'ทองดี', M, '2490', '2562');
const wichai = person('วิชัย', 'ทองดี', M, '2520', '', 'ชัย');
const sudarat = person('สุดารัตน์', 'ทองดี', F, '2524', '', 'แอน');

// ---- วงศ์ใหญ่, from Phuket ----
const sompong = person('สมพงษ์', 'วงศ์ใหญ่', M, '2475', '2550');
const lamduan = person('ลำดวน', 'วงศ์ใหญ่', F, '2478', '');
const weera = person('วีระ', 'วงศ์ใหญ่', M, '2498', '', 'ระ');
const chanpen = person('จันทร์เพ็ญ', 'วงศ์ใหญ่', F, '2503', '', 'เพ็ญ');
const natthida = person('ณัฐธิดา', 'วงศ์ใหญ่', F, '2523', '', 'ฝน');

// ---- Married in ----
const arunee = person('อรุณี', 'บุญมา', F, '2502', '', 'นี');
const suriya = person('สุริยา', 'พรหมมา', M, '2501', '');
const phanuwat = person('ภานุวัฒน์', 'พรหมมา', M, '2535', '', 'ภู');
const witthaya = person('วิทยา', 'บุญมา', M, '2520', '', 'วิท');
const chanida = person('ชนิดา', 'บุญมา', F, '2552', '', 'มายด์');

tookName(khamkaew, 'คำแก้ว', 'ศรีสุข', '2490');
tookName(buaphan, 'บัวผัน', 'แก้วมณี', '2494');
tookName(malee, 'มาลี', 'ศรีสุข', '2517');
tookName(somsri, 'สมศรี', 'ทองดี', '2518');
tookName(natthida, 'ณัฐธิดา', 'ศรีสุข', '2548');
tookName(sudarat, 'สุดารัตน์', 'แก้วมณี', '2555');

household([boonmee, khamkaew], [somchai, somsri, somsak], '2490');
household([thongkham, buaphan], [malee, manop, maneerat], '2494');
household([sompong, lamduan], [weera, chanpen]);
household([somchai, malee], [thanakorn, kanokwan], '2517'); // joins ศรีสุข and แก้วมณี
household([prasert, somsri], [wichai, sudarat], '2518');
household([somsak, arunee], [piya, [duangjai, 'adopted']], '2526'); // อรุณี kept her own family name
household([manop, chanpen], [anucha, orathai], '2528'); // joins แก้วมณี and วงศ์ใหญ่
household([suriya, maneerat], [phanuwat], '2532');
household([weera], [natthida]); // her mother is not recorded
household([thanakorn, natthida], [phumiphat, pimchanok], '2548');
household([witthaya, kanokwan], [chanida], '2550');
household([anucha, sudarat], [kawin], '2555'); // the two families meet again a generation later

const chiangMai = place('เชียงใหม่', 18.7883, 98.9853);
const khonKaen = place('ขอนแก่น', 16.4419, 102.836);
const bangkok = place('กรุงเทพมหานคร', 13.7563, 100.5018);
const phuket = place('ภูเก็ต', 7.8804, 98.3923);
link([boonmee, khamkaew, somchai, somsri, somsak, piya], 'BORN_IN', chiangMai);
link([thongkham, buaphan, malee, manop, maneerat, anucha, orathai], 'BORN_IN', khonKaen);
link([prasert, wichai, sudarat, thanakorn, kanokwan, phumiphat, pimchanok, chanida, kawin], 'BORN_IN', bangkok);
link([sompong, lamduan, weera, chanpen, natthida], 'BORN_IN', phuket);
link([somchai, malee, somsri, thanakorn, natthida, anucha, sudarat], 'LIVED_IN', bangkok);
link([boonmee, khamkaew], 'DIED_IN', chiangMai);
link([thongkham, buaphan], 'DIED_IN', khonKaen);

// One disagreement, to show versions: the family says ปู่บุญมี was born in 2468, the house register says 2470.
const { lastInsertRowid: register } = db
  .prepare('INSERT INTO sources (kind, title, note) VALUES (?, ?, ?)')
  .run('register', 'ทะเบียนบ้าน ศรีสุข', 'สำเนาที่สมศรีเก็บไว้');
const born = graph(db).versions.find((v) => v.node === boonmee && v.field === 'born');
addVersion(db, { node: boonmee, field: 'born', value: { date: '2470' }, fact: born.fact, accordingNode: somsri, sources: [Number(register)] });

console.log('Seeded a sample Thai family.');
