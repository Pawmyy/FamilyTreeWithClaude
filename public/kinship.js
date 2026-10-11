// Pure graph logic, shared by the browser UI and the tests.
// Edges are { id, src, dst, type, props }; see README for the conventions.

// CHILD_OF kinds that count as descent when naming a relationship.
// Step and foster links still show up in shortestPath.
const DESCENT = ['birth', 'adopted'];

export const isDescent = (e) => e.type === 'CHILD_OF' && DESCENT.includes(e.props.kind ?? 'birth');

function parentsOf(id, edges) {
  return edges.filter((e) => isDescent(e) && e.src === id).flatMap((e) => {
    const partners = edges.filter((p) => p.type === 'PARTNER_IN' && p.dst === e.dst).map((p) => p.src);
    // A union with no recorded partners stands in for the unknown parents, so its children are still siblings.
    return partners.length ? partners : [e.dst];
  });
}

// Map of ancestor id -> generations up (self is 0).
function ancestors(id, edges) {
  const depth = new Map([[id, 0]]);
  const queue = [id];
  for (const cur of queue) {
    for (const parent of parentsOf(cur, edges)) {
      if (depth.has(parent)) continue;
      depth.set(parent, depth.get(cur) + 1);
      queue.push(parent);
    }
  }
  return depth;
}

function arePartners(a, b, edges) {
  const unionsOf = (id) => edges.filter((e) => e.type === 'PARTNER_IN' && e.src === id).map((e) => e.dst);
  const mine = unionsOf(a);
  return unionsOf(b).some((u) => mine.includes(u));
}

// What `a` is to `b`, as a description that terms.js puts into words, or null if no kinship is recorded.
//   { kind: 'self' | 'partner' }
//   { kind: 'ancestor' | 'descendant', generations }      1 = parent / child, 2 = grandparent / grandchild
//   { kind: 'sibling', half }
//   { kind: 'pibling' | 'nibling', generations }          a parent's sibling / a sibling's child; 2 = great-
//   { kind: 'cousin', degree, removed }
// `via` is b's parent on the line up to the common ancestor, which tells which side of the family a is on.
export function kinship(a, b, edges) {
  if (a === b) return { kind: 'self' };
  if (arePartners(a, b, edges)) return { kind: 'partner' };

  // Closest common ancestor: `up` generations above a, `down` generations above b.
  const mine = ancestors(a, edges);
  let common, up, down;
  for (const [id, d] of ancestors(b, edges)) {
    if (mine.has(id) && (up === undefined || mine.get(id) + d < up + down)) {
      common = id;
      up = mine.get(id);
      down = d;
    }
  }
  if (up === undefined) return null;
  const via = parentsOf(b, edges).find((p) => ancestors(p, edges).get(common) === down - 1);

  if (up === 0) return { kind: 'ancestor', generations: down, via };
  if (down === 0) return { kind: 'descendant', generations: up };
  if (up === 1 && down === 1) {
    const pa = parentsOf(a, edges);
    const pb = parentsOf(b, edges);
    const shared = pa.filter((p) => pb.includes(p)).length;
    return { kind: 'sibling', half: shared === 1 && pa.length === 2 && pb.length === 2 };
  }
  if (up === 1) return { kind: 'pibling', generations: down - 1, via };
  if (down === 1) return { kind: 'nibling', generations: up - 1 };
  return { kind: 'cousin', degree: Math.min(up, down) - 1, removed: Math.abs(up - down) };
}

// Each household's partners and the children who descend from it.
function households(edges) {
  const found = new Map();
  const of = (id) => found.get(id) ?? found.set(id, { partners: [], children: [] }).get(id);
  for (const e of edges) {
    if (e.type === 'PARTNER_IN') of(e.dst).partners.push(e.src);
    else if (isDescent(e)) of(e.dst).children.push(e.src);
  }
  return found;
}

// Closeness: how many steps apart two people are on the family tree. Parent to child is one step and
// partners are one step, so siblings are 2 apart, first cousins 4, a partner's cousin 5.
// Returns steps(a, b): a number, or undefined when nothing joins them.
export function closeness(edges) {
  const beside = new Map();
  const join = (a, b) => {
    for (const [from, to] of [[a, b], [b, a]]) beside.set(from, (beside.get(from) ?? new Set()).add(to));
  };
  for (const [id, { partners, children }] of households(edges)) {
    for (const p of partners) for (const q of partners) if (p !== q) join(p, q);
    // With no parents recorded, an unnamed parent stands in, so brothers and sisters are still two steps apart.
    for (const child of children) for (const parent of partners.length ? partners : ['unknown parent of ' + id]) join(child, parent);
  }

  const reached = new Map();
  function from(start) {
    if (!reached.has(start)) {
      const steps = new Map([[start, 0]]);
      const queue = [start];
      for (const cur of queue) {
        for (const next of beside.get(cur) ?? []) {
          if (steps.has(next)) continue;
          steps.set(next, steps.get(cur) + 1);
          queue.push(next);
        }
      }
      reached.set(start, steps);
    }
    return reached.get(start);
  }
  return (a, b) => from(a).get(b);
}

// How many descendants each person has, as a Map from person to count. People with none are absent.
export function descendantCounts(edges) {
  const childrenOf = new Map();
  for (const { partners, children } of households(edges).values()) {
    for (const p of partners) childrenOf.set(p, [...(childrenOf.get(p) ?? []), ...children]);
  }
  const counts = new Map();
  for (const person of childrenOf.keys()) {
    const below = new Set();
    const queue = [person];
    for (const cur of queue) {
      for (const child of childrenOf.get(cur) ?? []) {
        if (below.has(child) || child === person) continue;
        below.add(child);
        queue.push(child);
      }
    }
    counts.set(person, below.size);
  }
  return counts;
}

// Shortest chain of links of any type between two nodes, ignoring direction.
// Returns [{ edge, from, to }, ...] in walking order, or null if unconnected.
export function shortestPath(a, b, edges) {
  const adjacent = new Map();
  for (const edge of edges) {
    for (const [from, to] of [[edge.src, edge.dst], [edge.dst, edge.src]]) {
      if (!adjacent.has(from)) adjacent.set(from, []);
      adjacent.get(from).push({ edge, from, to });
    }
  }

  const reachedBy = new Map([[a, null]]);
  const queue = [a];
  for (const cur of queue) {
    if (cur === b) break;
    for (const step of adjacent.get(cur) ?? []) {
      if (reachedBy.has(step.to)) continue;
      reachedBy.set(step.to, step);
      queue.push(step.to);
    }
  }
  if (!reachedBy.has(b)) return null;

  const path = [];
  for (let step = reachedBy.get(b); step; step = reachedBy.get(step.from)) path.unshift(step);
  return path;
}
