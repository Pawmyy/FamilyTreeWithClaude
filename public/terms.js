// The everyday word for a kinship, in English or Thai.
// `rel` comes from kinship(); A is the person being described, B the person they are related to,
// and via is B's parent on that side of the family. Each is { sex, born } or undefined.
// With sex or birth years missing, the wording falls back to a neutral phrase.

import { yearOf } from './record.js';

// Whether a is 'older' or 'younger' than b, or undefined when the record cannot tell.
function age(a, b) {
  const gap = yearOf(a?.born) - yearOf(b?.born);
  return gap < 0 ? 'older' : gap > 0 ? 'younger' : undefined;
}

const bySex = (person, male, female, neutral) =>
  person?.sex === 'male' ? male : person?.sex === 'female' ? female : neutral;

const great = (n) => 'great-'.repeat(n);
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];
const TIMES = ['', ' once removed', ' twice removed'];

const EN = {
  self: () => 'self',
  partner: ({ A }) => bySex(A, 'husband', 'wife', 'partner'),
  ancestor: ({ rel, A }) => (rel.generations === 1
    ? bySex(A, 'father', 'mother', 'parent')
    : great(rel.generations - 2) + bySex(A, 'grandfather', 'grandmother', 'grandparent')),
  descendant: ({ rel, A }) => (rel.generations === 1
    ? bySex(A, 'son', 'daughter', 'child')
    : great(rel.generations - 2) + bySex(A, 'grandson', 'granddaughter', 'grandchild')),
  sibling: ({ rel, A }) => (rel.half ? 'half-' : '') + bySex(A, 'brother', 'sister', 'sibling'),
  pibling: ({ rel, A }) => great(rel.generations - 1) + bySex(A, 'uncle', 'aunt', 'aunt/uncle'),
  nibling: ({ rel, A }) => great(rel.generations - 1) + bySex(A, 'nephew', 'niece', 'niece/nephew'),
  cousin: ({ rel }) =>
    `${ORDINAL[rel.degree - 1] ?? rel.degree + 'th'} cousin${TIMES[rel.removed] ?? ` ${rel.removed} times removed`}`,
};

const TH = {
  self: () => 'ตัวเอง',
  partner: ({ A }) => bySex(A, 'สามี', 'ภรรยา', 'คู่ครอง'),
  // Thai names grandparents by side: ปู่ ย่า on the father's, ตา ยาย on the mother's.
  ancestor: ({ rel, A, via }) => {
    if (rel.generations === 1) return bySex(A, 'พ่อ', 'แม่', 'พ่อหรือแม่');
    if (rel.generations === 2) {
      return bySex(via, bySex(A, 'ปู่', 'ย่า', 'ปู่หรือย่า'), bySex(A, 'ตา', 'ยาย', 'ตาหรือยาย'), bySex(A, 'ปู่หรือตา', 'ย่าหรือยาย', 'ปู่ย่าตายาย'));
    }
    return rel.generations === 3 ? 'ทวด' : `บรรพบุรุษ ${rel.generations} รุ่นก่อน`;
  },
  descendant: ({ rel, A }) => {
    if (rel.generations === 1) return bySex(A, 'ลูกชาย', 'ลูกสาว', 'ลูก');
    if (rel.generations === 2) return bySex(A, 'หลานชาย', 'หลานสาว', 'หลาน');
    return rel.generations === 3 ? 'เหลน' : rel.generations === 4 ? 'โหลน' : `ลูกหลานรุ่นที่ ${rel.generations}`;
  },
  // พี่ is older, น้อง is younger.
  sibling: ({ rel, A, B }) => {
    const order = age(A, B);
    const word = order === 'older' ? bySex(A, 'พี่ชาย', 'พี่สาว', 'พี่')
      : order === 'younger' ? bySex(A, 'น้องชาย', 'น้องสาว', 'น้อง')
      : bySex(A, 'พี่ชายหรือน้องชาย', 'พี่สาวหรือน้องสาว', 'พี่น้อง');
    return rel.half ? `${word}ต่างบิดาหรือมารดา` : word;
  },
  // A parent's older sibling is ลุง or ป้า; a younger one is อา on the father's side, น้า on the mother's.
  pibling: ({ rel, A, via }) => {
    if (rel.generations > 1) return rel.generations === 2 ? 'พี่น้องของปู่ย่าตายาย' : 'พี่น้องของบรรพบุรุษ';
    const order = age(A, via);
    if (order === 'older') return bySex(A, 'ลุง', 'ป้า', 'ลุงหรือป้า');
    if (order === 'younger') return bySex(via, 'อา', 'น้า', 'น้าหรืออา');
    return bySex(via, 'พี่น้องของพ่อ', 'พี่น้องของแม่', 'พี่น้องของพ่อแม่');
  },
  nibling: ({ rel, A }) => (rel.generations === 1
    ? `${bySex(A, 'หลานชาย', 'หลานสาว', 'หลาน')} (ลูกของพี่น้อง)`
    : 'ลูกหลานของพี่น้อง'),
  cousin: ({ rel }) => (rel.degree === 1 && !rel.removed
    ? 'ลูกพี่ลูกน้อง'
    : `ญาติ (ลูกพี่ลูกน้องชั้นที่ ${rel.degree}${rel.removed ? ` ต่างกัน ${rel.removed} รุ่น` : ''})`),
};

export function kinshipTerm(rel, lang, { A, B, via } = {}) {
  return (lang === 'th' ? TH : EN)[rel.kind]({ rel, A, B, via });
}
