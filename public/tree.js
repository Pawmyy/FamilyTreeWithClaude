// The traditional family tree: the whole family as descendant trees standing side by side.
//
// The record is a graph, and a tree cannot hold a person in two places, so:
//   - a household's children are drawn under the partner whose family name they carry (its "line");
//   - a person is drawn in full once, under their own parents, and as a marked copy beside a partner elsewhere.
//
// A tree node is { person, copy, unions }, and a union is { household, partner, children, elsewhere }.
// `partner` is { person, copy } or null; `elsewhere` means the children are drawn in the partner's tree.
import { isDescent } from './kinship.js';

const year = (text) => Number(/\d{3,4}/.exec(text ?? '')?.[0] ?? Infinity);

// people: [{ id, familyName, birthFamilyName, born }]; households: [{ id }]; edges: the accepted links.
export function buildForest(people, households, edges) {
  const person = new Map(people.map((p) => [p.id, p]));
  const partnersOf = new Map(households.map((h) => [h.id, []]));
  const childrenOf = new Map(households.map((h) => [h.id, []]));
  const unionsOf = new Map(people.map((p) => [p.id, []]));
  const homeOf = new Map();
  for (const e of edges) {
    if (!person.has(e.src) || !partnersOf.has(e.dst)) continue;
    if (e.type === 'PARTNER_IN') {
      partnersOf.get(e.dst).push(e.src);
      unionsOf.get(e.src).push(e.dst);
    }
    // A child belongs to the first household they descend from; step and foster ties are not part of the tree.
    if (isDescent(e) && !homeOf.has(e.src)) {
      homeOf.set(e.src, e.dst);
      childrenOf.get(e.dst).push(e.src);
    }
  }
  for (const children of childrenOf.values()) {
    children.sort((a, b) => year(person.get(a).born) - year(person.get(b).born) || a - b);
  }

  // The line of a household is the partner more of its children are named after, when that settles it.
  const line = new Map();
  for (const [household, partners] of partnersOf) {
    const namedAfter = (p) => childrenOf.get(household).filter((child) => {
      const name = person.get(child).birthFamilyName;
      return name && (name === person.get(p).familyName || name === person.get(p).birthFamilyName);
    }).length;
    const ranked = partners.map((p) => [namedAfter(p), p]).sort((a, b) => b[0] - a[0]);
    if (ranked.length && ranked[0][0] > (ranked[1]?.[0] ?? 0)) line.set(household, ranked[0][1]);
  }

  const placed = new Set();
  function grow(id) {
    placed.add(id);
    const unions = unionsOf.get(id).map((household) => {
      // With no family names to go by, the line is whoever the tree reaches first.
      if (!line.has(household)) line.set(household, id);
      if (line.get(household) !== id) {
        return { household, partner: { person: line.get(household), copy: true }, children: [], elsewhere: true };
      }
      const other = partnersOf.get(household).find((p) => p !== id) ?? null;
      // A partner with parents, or other partners, of their own has a full place somewhere else.
      const copy = other !== null && (homeOf.has(other) || placed.has(other) || unionsOf.get(other).length > 1);
      if (other !== null && !copy) placed.add(other);
      return { household, partner: other === null ? null : { person: other, copy }, children: growAll(childrenOf.get(household)) };
    });
    return { person: id, copy: false, unions };
  }
  // Someone already drawn (cousins who married, say) appears again only as a copy.
  const growAll = (ids) => ids.map((id) => (placed.has(id) ? { person: id, copy: true, unions: [] } : grow(id)));

  // How many generations hang below someone, so the longest lines come first.
  const heights = new Map();
  function height(id) {
    if (!heights.has(id)) {
      heights.set(id, 0); // guards against a record that loops back on itself
      const below = unionsOf.get(id).flatMap((h) => childrenOf.get(h)).map(height);
      heights.set(id, 1 + Math.max(0, ...below));
    }
    return heights.get(id);
  }

  // Trees start from founders: people whose parents are not in the record.
  const founders = people.filter((p) => !homeOf.has(p.id)).sort((a, b) => height(b.id) - height(a.id) || a.id - b.id);
  const forest = [];
  // First the founders who lead a line; one who only married into lines is drawn beside their partner instead.
  for (const { id } of founders) {
    const leads = !unionsOf.get(id).length || unionsOf.get(id).some((h) => (line.get(h) ?? id) === id);
    if (leads && !placed.has(id)) forest.push(grow(id));
  }
  // Brothers and sisters whose parents are both unknown hang from a household with nobody in it.
  for (const [household, partners] of partnersOf) {
    const waiting = childrenOf.get(household).filter((child) => !placed.has(child));
    if (!partners.length && waiting.length) {
      forest.push({ person: null, copy: false, unions: [{ household, partner: null, children: growAll(waiting) }] });
    }
  }
  for (const { id } of people) if (!placed.has(id)) forest.push(grow(id));
  return forest;
}

const SLOT = 46; // width of one person
const ROW = 70; // height of one generation

// Positions for everything in the forest:
//   people      [{ key, person, copy, x, y }]    key is the person's id, or a made-up one for a copy
//   households  [{ key, household, x, y }]
//   lines       [{ source, target, type, person, household }]   keys, plus the link each line stands for
export function layoutForest(forest) {
  const out = { people: [], households: [], lines: [] };
  let copies = 0;

  const unionWidth = (union) => Math.max(3, union.children.reduce((sum, child) => sum + widthOf(child), 0));
  const widthOf = (node) => (node.unions.length ? node.unions.reduce((sum, union) => sum + unionWidth(union), 0) : 1.2);

  function addPerson(person, copy, x, depth) {
    const key = copy ? `copy-${person}-${++copies}` : person;
    out.people.push({ key, person, copy, x: x * SLOT, y: -depth * ROW });
    return key;
  }

  // Lays a node out from `left`, one generation per row, and returns the key its parents' line attaches to.
  function place(node, left, depth) {
    if (!node.unions.length) return addPerson(node.person, node.copy, left + widthOf(node) / 2, depth);
    let self;
    let x = left;
    node.unions.forEach((union, i) => {
      const width = unionWidth(union);
      const center = x + width / 2;
      // The couple sits over the middle of their children: person, household, partner.
      if (i === 0 && node.person !== null) self = addPerson(node.person, false, center - 1, depth);
      const key = union.elsewhere ? `stub-${union.household}-${++copies}` : union.household;
      out.households.push({ key, household: union.household, x: center * SLOT, y: -depth * ROW });
      if (self !== undefined) out.lines.push({ source: self, target: key, type: 'PARTNER_IN', person: node.person, household: union.household });
      if (union.partner) {
        const partner = addPerson(union.partner.person, union.partner.copy, center + 1, depth);
        out.lines.push({ source: partner, target: key, type: 'PARTNER_IN', person: union.partner.person, household: union.household });
      }
      let childLeft = x + (width - union.children.reduce((sum, child) => sum + widthOf(child), 0)) / 2;
      for (const child of union.children) {
        const childKey = place(child, childLeft, depth + 1);
        out.lines.push({ source: key, target: childKey, type: 'CHILD_OF', person: child.person, household: union.household });
        childLeft += widthOf(child);
      }
      x += width;
    });
    return self;
  }

  let left = 0;
  for (const tree of forest) {
    place(tree, left, 0);
    left += widthOf(tree) + 1;
  }
  return out;
}
