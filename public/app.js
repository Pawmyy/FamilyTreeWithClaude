import ForceGraph3D from 'https://esm.sh/3d-force-graph@1.80.1?deps=three@0.186.1';
import SpriteText from 'https://esm.sh/three-spritetext@1.10.0?deps=three@0.186.1';
import * as THREE from 'https://esm.sh/three@0.186.1';
import { createFinder, rank } from './finder.js';
import { getLang, has, LANGS, setLang, t } from './i18n.js';
import { closeness, isDescent, kinship, shortestPath } from './kinship.js';
import { createMap, lookUp } from './map.js';
import { fullName, nameRecord, yearOf } from './record.js';
import { kinshipTerm } from './terms.js';
import { buildForest, layoutForest } from './tree.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props) => Object.assign(document.createElement(tag), props);
// Show or hide a form control together with its label.
const show = (id, visible) => (($(id).closest('label') ?? $(id)).hidden = !visible);

let g = { nodes: [], edges: [], rivals: [], versions: [], sources: [], log: [], colors: {} };
let byId = new Map();
let selected = null; // { group: 'nodes' | 'edges', id }
let onPath = new Set(); // node ids and 'e' + edge ids on the highlighted path
let view = '3d'; // '3d' | '2d' | 'tree' | 'map'
let framed = false;
let showRivals = false;
let relation = null; // which relative is being added: 'parent' | 'partner' | 'child' | 'sibling'
let flyingUntil = 0; // while the camera is being moved for the user, the pan limit stands aside
let filters = []; // tags chosen in the search box: { kind: 'family' | 'place' | 'born', value, label }
let timeline = null; // a year, while the timeline is on
let seen = new Map(); // what the filters make of each node: 'shown', 'faded' or 'hidden' (see sight)
let maxSteps = 2; // 3D and 2D draw a closeness line between people up to this many steps apart
let shiftHeld = false;
let mapView = null; // made the first time the map is opened
let placing = null; // id of a place waiting for a click on the map
let lookUpNext = null; // id of a place to look up once the record has reloaded

// Remembered between visits; private browsing may refuse, which is fine.
const prefs = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
};

// ---- Theme ----

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (document.documentElement.dataset.theme ?? (systemDark.matches ? 'dark' : 'light')) === 'dark';

// The picture is drawn by WebGL, so it needs the theme's colors as values, not as CSS.
const ink = {};
function readTheme() {
  const style = getComputedStyle(document.documentElement);
  for (const name of ['text', 'muted', 'accent', 'danger', 'stage', 'highlight', 'place', 'event']) {
    ink[name] = style.getPropertyValue('--' + name).trim();
  }
}
if (prefs.get('theme')) document.documentElement.dataset.theme = prefs.get('theme');
readTheme();

function applyTheme() {
  readTheme();
  Graph.backgroundColor(ink.stage);
  draw();
  drawMap();
  select(selected);
}

// ---- Graph view ----

// How long a link wants to be: the closer the tie, the shorter the link.
const DISTANCE = { PARTNER_IN: 18, birth: 30, adopted: 40, step: 70, foster: 70, other: 110 };
// One shape per kind; seen from the front in 2D they read as circle, diamond, square, triangle.
const SHAPE = {
  person: new THREE.SphereGeometry(5, 20, 14),
  household: new THREE.OctahedronGeometry(3.5),
  place: new THREE.BoxGeometry(8, 8, 8),
  event: new THREE.ConeGeometry(5.5, 10, 4),
};
const HALO = new THREE.SphereGeometry(1, 14, 10);

// A color of a given hue that suits the theme: bright on dark, deeper on light.
const hue = (degrees) => `hsl(${degrees}, ${isDark() ? 100 : 80}%, ${isDark() ? 64 : 38}%)`;

// The same text always gives the same hue, so a family's color does not depend on who else is in the record.
function hueOf(text) {
  let hash = 0;
  for (const letter of text) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return hash % 360;
}

const toHex = (color) => '#' + new THREE.Color(color).getHexString();

// Colors are automatic until chosen in the Colors tab: g.colors is { family, link, kind }, each a map to a color.
const AUTOMATIC = {
  family: (name) => hue(hueOf(name)),
  link: (type) => (type === 'PARTNER_IN' ? ink.accent : type === 'CHILD_OF' ? ink.muted : hue(hueOf(type))),
  kind: (kind) => ink[kind],
};
const colorOf = (group, key) => g.colors[group]?.[key] ?? AUTOMATIC[group](key);

// Whose color a node carries: everyone born with the same family name shares one, so it is kept by name.
// Anything else (a household, a place, an event, a person with no family name) can have a color of its own.
const colorKey = (node) => (node.kind === 'person' && node.birthFamilyName ? ['family', node.birthFamilyName] : ['node', String(node.id)]);

function nodeColor(node) {
  const [group, key] = colorKey(node);
  if (group === 'family') return colorOf('family', key);
  return g.colors.node?.[key] ?? (node.kind === 'place' || node.kind === 'event' ? colorOf('kind', node.kind) : ink.muted);
}

const textures = new Map();
function photoTexture(id) {
  if (!textures.has(id)) {
    const texture = new THREE.TextureLoader().load('/api/photos/' + id);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.set(id, texture);
  }
  return textures.get(id);
}

const isSelected = (group, id) => selected?.group === group && selected.id === id;
const isLit = (link) => onPath.has('e' + link.edge) || isSelected('edges', link.edge);

// What is drawn for a node. `ref` is the record's id for it; in the tree one person can be drawn twice.
function nodeObject(node) {
  const group = new THREE.Group();
  const lit = onPath.has(node.ref);
  // Filtered out is fainter than a copy, whose full place in the tree is elsewhere.
  const opacity = node.faded ? 0.12 : node.copy ? 0.4 : 1;
  if (node.photo) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: photoTexture(node.ref), opacity }));
    sprite.scale.set(14 * node.size, 14 * node.size, 1);
    group.add(sprite);
  } else {
    const material = new THREE.MeshLambertMaterial({ color: lit ? ink.highlight : node.color, transparent: true, opacity });
    const shape = new THREE.Mesh(SHAPE[node.kind], material);
    shape.scale.setScalar(node.size);
    group.add(shape);
  }
  if (lit || isSelected('nodes', node.ref)) {
    const halo = new THREE.Mesh(HALO, new THREE.MeshBasicMaterial({ color: ink.highlight, wireframe: true, transparent: true, opacity: 0.35 }));
    halo.scale.setScalar((node.photo ? 12 : 9) * node.size);
    group.add(halo);
  }
  if (node.label) {
    // Names are in the text color so they stay readable; the shape carries the family color.
    const text = new SpriteText(node.copy ? `↗ ${node.label}` : node.label, 4, ink.text);
    text.material.opacity = node.faded ? 0.25 : 1;
    text.position.y = (node.photo ? -14 : -11) * node.size;
    group.add(text);
  }
  return group;
}

const Graph = new ForceGraph3D($('graph'))
  .backgroundColor(ink.stage)
  .showNavInfo(false)
  .nodeLabel('hover')
  .nodeThreeObject(nodeObject)
  .linkLabel('label')
  .linkColor((l) => (isLit(l) ? ink.highlight : l.color))
  // A closeness line is thinner the more steps apart the two people are.
  .linkWidth((l) => (isLit(l) ? 2.5 : l.steps ? Math.max(0.15, 1.8 / l.steps) : l.type === 'PARTNER_IN' ? 1.2 : 0.5))
  .linkVisibility(linkVisible)
  .linkOpacity(0.7)
  .linkDirectionalArrowLength((l) => (l.type === 'PARTNER_IN' || l.elbow || l.steps ? 0 : 3))
  .linkDirectionalArrowRelPos(1)
  // In the tree, a child hangs from its parents by a line with square corners, as on a printed chart.
  .linkThreeObject((l) => l.elbow && new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: isLit(l) ? ink.highlight : l.color })))
  .linkPositionUpdate((line, { start, end }, l) => {
    if (!l.elbow) return false;
    const turn = (start.y + end.y) / 2;
    line.geometry.setFromPoints([[start.x, start.y], [start.x, turn], [end.x, turn], [end.x, end.y]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
    return true;
  })
  .onNodeClick((n) => {
    // A copy takes you to where that person is drawn in full.
    if (n.copy) return openNode(n.ref);
    select({ group: 'nodes', id: n.ref });
    showTab('edit');
  })
  .onLinkClick((l) => {
    // A closeness line stands for no single link in the record.
    if (!l.edge) return;
    select({ group: 'edges', id: l.edge });
    showTab('links');
  })
  .onBackgroundClick(() => selected && select(null))
  .cooldownTime(3000)
  .onEngineStop(() => {
    // Frame the graph when it settles after a change in its shape or view; otherwise the camera is the user's.
    if (!framed) frame();
    framed = true;
  });
// Each link pulls its ends to the distance it asks for. Closeness lines also say how hard.
const usualStrength = Graph.d3Force('link').strength();
Graph.d3Force('link').distance((l) => l.distance).strength((l) => l.strength ?? usualStrength(l));
// Cap the range of repulsion so unconnected families stay nearby instead of drifting off.
Graph.d3Force('charge').distanceMax(120);

// Move the camera for the user. Such a move starts by aiming far ahead of the camera, well outside
// the family, so the pan limit must not act on it.
function fly(position, aim, ms) {
  flyingUntil = performance.now() + ms + 200;
  Graph.cameraPosition(position, aim, ms);
}

// Panning moves the point the camera aims at. Keep that point inside the box around the family,
// carrying the camera along, so the picture can be pushed to the edge of the screen but not off it.
Graph.controls().addEventListener('change', () => {
  const nodes = Graph.graphData().nodes.filter((n) => n.x !== undefined);
  if (!nodes.length || performance.now() < flyingUntil) return;
  // Measured from the nodes' own positions, which are right even while their shapes are being redrawn.
  const edge = (pick) => new THREE.Vector3(...['x', 'y', 'z'].map((axis) => pick(...nodes.map((n) => n[axis] ?? 0))));
  const { target } = Graph.controls();
  const back = target.clone().clamp(edge(Math.min), edge(Math.max)).sub(target);
  if (!back.lengthSq()) return;
  target.add(back);
  Graph.camera().position.add(back);
});

// Lines to or from someone filtered out are not drawn, nor closeness lines beyond the chosen number of steps.
function linkVisible(link) {
  return !link.faded && (!link.steps || (link.steps > 1 && link.steps <= maxSteps));
}

// Dragging turns the 3D view and moves the flat ones. In 3D, hold Shift (or use the right button) to move.
function setMouse() {
  const flat = view !== '3d';
  Graph.controls().noRotate = flat;
  Graph.controls().mouseButtons.LEFT = flat || shiftHeld ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
}
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (evt) => {
    if (evt.key !== 'Shift') return;
    shiftHeld = type === 'keydown';
    setMouse();
  });
}

// Fit every node on screen, then limit zooming to between one node and a little past that fit.
function frame() {
  const controls = Graph.controls();
  controls.minDistance = 60;
  controls.maxDistance = Infinity;
  flyingUntil = performance.now() + 700;
  Graph.zoomToFit(500, 80);
  setTimeout(() => {
    controls.maxDistance = Math.max(120, Graph.camera().position.distanceTo(controls.target) * 1.25);
  }, 600);
}

function showLegend() {
  $('legend').textContent = t({ '3d': 'legend', '2d': 'legend.flat' }[view] ?? 'legend.' + view);
}

function setView(next) {
  view = next;
  for (const b of document.querySelectorAll('#views [data-view]')) b.classList.toggle('active', b.dataset.view === view);
  const onMap = view === 'map';
  $('map').hidden = !onMap;
  $('graph').hidden = onMap;
  // Rival links are drawn only where every link is drawn.
  $('rivals').hidden = view !== '3d' && view !== '2d';
  showLegend();
  if (onMap) {
    Graph.pauseAnimation();
    drawMap();
    mapView.resize();
    return;
  }
  $('unplaced').hidden = true;
  Graph.resumeAnimation();
  const flat = view !== '3d';
  Graph.numDimensions(flat ? 2 : 3);
  setMouse();
  if (flat) {
    Graph.camera().up.set(0, 1, 0);
    Graph.cameraPosition({ x: 0, y: 0, z: 400 }, { x: 0, y: 0, z: 0 });
  }
  // The tree has nothing to settle, so frame it almost at once.
  Graph.cooldownTime(view === 'tree' ? 300 : 3000);
  framed = false;
  draw();
  resize();
}

// How a node and a link look, whichever view draws them.
const face = (node) => ({ ref: node.id, kind: node.kind, photo: node.photo, label: graphLabel(node), hover: label(node), color: nodeColor(node), size: 1 });
const lookOf = (edge) => ({ edge: edge.id, type: edge.type, label: linkText(edge), color: edge.accepted ? colorOf('link', edge.type) : ink.danger });

// Closeness: every two people on the same family tree pull gently toward each other, harder the fewer
// steps apart they are, so near relatives settle together and distant ones apart. One step apart
// (parent and child, partners) is already drawn through their household, so lines start at two steps.
function closenessLinks() {
  const people = g.nodes.filter((n) => n.kind === 'person');
  const steps = closeness(g.edges);
  const links = [];
  people.forEach((a, i) => {
    for (const b of people.slice(i + 1)) {
      const apart = steps(a.id, b.id);
      if (apart === undefined) continue;
      links.push({
        source: a.id, target: b.id, steps: apart, elbow: false, edge: null, type: 'CLOSE',
        label: t('close.steps', { count: apart }), color: ink.muted,
        distance: apart * 40, strength: 0.15 / (apart * apart),
      });
    }
  });
  return links;
}

// 3D and 2D: everything in the record, left to find its own place.
function graphScene() {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, copy: false, ...face(n) })),
    links: [
      ...(showRivals ? [...g.edges, ...g.rivals] : g.edges).map((e) => {
        // CHILD_OF is stored child -> household; draw it household -> child so the arrow lands on the child.
        const [source, target] = e.type === 'CHILD_OF' ? [e.dst, e.src] : [e.src, e.dst];
        const distance = DISTANCE[e.type === 'CHILD_OF' ? e.props.kind ?? 'birth' : e.type] ?? DISTANCE.other;
        return { source, target, elbow: false, distance, ...lookOf(e) };
      }),
      ...closenessLinks(),
    ],
  };
}

// Tree: people and households only, each pinned where the traditional layout puts it (see tree.js).
function treeScene() {
  const laid = layoutForest(buildForest(
    g.nodes.filter((n) => n.kind === 'person'),
    g.nodes.filter((n) => n.kind === 'household'),
    g.edges,
  ));
  const edgeOf = (line) => g.edges.find((e) => e.type === line.type && e.src === line.person && e.dst === line.household);
  return {
    nodes: [
      ...laid.people.map((p) => ({ id: p.key, copy: p.copy, at: p, ...face(byId.get(p.person)) })),
      ...laid.households.map((h) => ({ id: h.key, copy: false, at: h, ...face(byId.get(h.household)) })),
    ],
    links: laid.lines.map((line) => ({ source: line.source, target: line.target, elbow: line.type === 'CHILD_OF', distance: 30, ...lookOf(edgeOf(line)) })),
  };
}

// ---- Filters: tags and the timeline ----

const PLACE_LINKS = ['BORN_IN', 'LIVED_IN', 'DIED_IN'];
// Whether a person fits a tag. A family-name tag fits any name they have ever carried.
const TAG_FITS = {
  family: (person, name) => g.versions.some((v) => v.node === person.id && v.field === 'name' && v.value.family === name),
  place: (person, place) => g.edges.some((e) => e.src === person.id && e.dst === place && PLACE_LINKS.includes(e.type)),
  born: (person, year) => yearOf(person.born) === year,
};

// What the filters make of every node. A person is 'faded' when they do not fit, and 'hidden' when the
// timeline is on and they have no birth date to place them by. Tags of one kind widen the match, different
// kinds narrow it. A household, place or event follows the people joined to it.
function sight() {
  const result = new Map();
  if (!filters.length && timeline === null) return result;
  const kinds = [...new Set(filters.map((f) => f.kind))];
  for (const person of g.nodes.filter((n) => n.kind === 'person')) {
    const born = yearOf(person.born);
    const last = Number.isNaN(yearOf(person.died)) ? born + 100 : yearOf(person.died);
    const fits = kinds.every((kind) => filters.some((f) => f.kind === kind && TAG_FITS[kind](person, f.value)));
    const alive = timeline === null || (born <= timeline && timeline <= last);
    result.set(person.id, timeline !== null && Number.isNaN(born) ? 'hidden' : fits && alive ? 'shown' : 'faded');
  }
  for (const node of g.nodes.filter((n) => n.kind !== 'person')) {
    const joined = g.edges.filter((e) => e.src === node.id || e.dst === node.id)
      .map((e) => result.get(e.src === node.id ? e.dst : e.src)).filter(Boolean);
    result.set(node.id, joined.includes('shown') ? 'shown' : joined.length && joined.every((s) => s === 'hidden') ? 'hidden' : 'faded');
  }
  return result;
}

function draw() {
  seen = sight();
  const scene = view === 'tree' ? treeScene() : graphScene();
  const state = (ref) => seen.get(ref) ?? 'shown';
  scene.nodes = scene.nodes.filter((n) => state(n.ref) !== 'hidden').map((n) => ({ ...n, faded: state(n.ref) === 'faded' }));
  const kept = new Map(scene.nodes.map((n) => [n.id, n]));
  scene.links = scene.links.filter((l) => kept.has(l.source) && kept.has(l.target))
    .map((l) => ({ ...l, faded: kept.get(l.source).faded || kept.get(l.target).faded }));

  // Reuse the existing node objects so nodes keep their positions across reloads.
  const existing = new Map(Graph.graphData().nodes.map((n) => [n.id, n]));
  if (existing.size !== scene.nodes.length) framed = false;
  Graph.graphData({
    nodes: scene.nodes.map((fresh) => {
      const node = Object.assign(existing.get(fresh.id) ?? {}, fresh);
      if (view === 'tree') {
        node.fx = node.x = fresh.at.x;
        node.fy = node.y = fresh.at.y;
      } else {
        delete node.fx;
        delete node.fy;
      }
      return node;
    }),
    links: scene.links,
  });
}

// ---- Map view ----

const isPlaced = (place) => place.props.lat !== undefined;

function drawMap() {
  if (view !== 'map') return;
  mapView ??= createMap($('map'), { onClick: (spot) => {
    if (placing === null) return;
    const id = placing;
    placing = null;
    setPlace(id, spot);
  } });
  const places = g.nodes.filter((n) => n.kind === 'place');
  mapView.show(places.filter(isPlaced).map((place) => ({
    id: place.id, name: place.name, lat: place.props.lat, lng: place.props.lng, color: toHex(nodeColor(place)),
    people: g.edges.filter((e) => e.dst === place.id && PLACE_LINKS.includes(e.type) && (seen.get(e.src) ?? 'shown') === 'shown')
      .map((e) => ({ id: e.src, text: `${label(byId.get(e.src))} · ${edgeText(e)}` })),
  })), openNode);

  const waiting = places.filter((place) => !isPlaced(place));
  $('unplaced').hidden = !waiting.length;
  $('unplaced').replaceChildren(el('span', { textContent: t('map.unplaced') }), ...waiting.map((place) => button(place.name, () => {
    openNode(place.id);
    findPlace(place);
  }, 'ghost')));
}

// Look a place up by its name. One match is used as it is, several are offered, none means asking for a click.
async function findPlace(place) {
  $('whereStatus').textContent = t('map.searching');
  let found = [];
  try {
    found = await lookUp(place.name, getLang());
  } catch {
    // Offline, or the service is down: fall through to placing by hand.
  }
  if (found.length === 1) return setPlace(place.id, found[0]);
  if (!found.length) return placeByHand(place.id, 'map.notFound');
  $('whereStatus').textContent = t('map.choose');
  $('whereChoices').replaceChildren(...found.map((spot) => {
    const row = el('li');
    row.append(button(spot.label, () => setPlace(place.id, spot), 'ghost'));
    return row;
  }));
}

function placeByHand(id, messageKey = 'map.clickMap') {
  placing = id;
  if (view !== 'map') setView('map');
  notify(t(messageKey));
}

function setPlace(id, { lat, lng }) {
  const place = byId.get(id);
  return act(() => api('PUT', 'nodes/' + id, { name: place.name, props: { ...place.props, lat, lng } }), t('map.saved'));
}

// Bring a node to the middle of the picture, close enough to read, without changing which way you are looking.
function lookAt(id) {
  const node = Graph.graphData().nodes.find((n) => n.id === id);
  if (node?.x === undefined) return;
  const aim = new THREE.Vector3(node.x, node.y, node.z ?? 0);
  const backOff = Graph.camera().position.clone().sub(Graph.controls().target).normalize().multiplyScalar(200);
  fly(aim.clone().add(backOff), aim, 800);
}

// ---- Data and text ----

async function api(method, path, body) {
  const res = await fetch('/api/' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

const membersOf = (household, type) =>
  g.edges.filter((e) => e.type === type && e.dst === household).map((e) => byId.get(e.src));

function label(node) {
  if (node.kind === 'person') return node.name || t('person.unnamed');
  if (node.kind !== 'household') return node.name;
  const partners = membersOf(node.id, 'PARTNER_IN');
  if (partners.length) return partners.map(label).join(' & ');
  const children = membersOf(node.id, 'CHILD_OF');
  return children.length ? t('hh.parentsOf', { names: children.map(label).join(', ') }) : t('hh.empty');
}

const lifespan = (node) => (node.born || node.died ? `${node.born || '?'}–${node.died}` : '');

// The line under a name in lists and on the card.
function detail(node) {
  if (node.kind !== 'person') return t('kind.' + node.kind);
  return [node.props.nickname && `“${node.props.nickname}”`, lifespan(node)].filter(Boolean).join(' · ');
}

function graphLabel(node) {
  if (node.kind === 'household') return '';
  const dates = node.kind === 'person' ? lifespan(node) : [node.props.start, node.props.end].filter(Boolean).join('–');
  return dates ? `${label(node)}\n${dates}` : label(node);
}

// A link type in words: the known ones translated, anything else as it was typed.
function edgeText(edge) {
  const key = edge.type === 'CHILD_OF' ? `link.CHILD_OF:${edge.props.kind ?? 'birth'}` : `link.${edge.type}`;
  return has(key) ? t(key) : edge.type.toLowerCase().replaceAll('_', ' ');
}

const linkText = (edge) => edgeText(edge) + (edge.accepted ? '' : ` (${t('links.otherVersion')})`);
const linkSentence = (edge) => `${label(byId.get(edge.src))} — ${linkText(edge)} → ${label(byId.get(edge.dst))}`;

let toastTimer;
function notify(message, isError = false) {
  $('toast').textContent = message;
  $('toast').className = isError ? 'error' : '';
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), isError ? 6000 : 2500);
}

// Run an action, reload the record, then report what happened (or what went wrong).
// An action may return its own message, or false to say it was cancelled.
async function act(action, message) {
  try {
    const result = await action();
    if (result === false) return;
    await refresh();
    const text = typeof result === 'string' ? result : message;
    if (text) notify(text);
  } catch (err) {
    // The server names some errors by their text key.
    notify(has(err.message) ? t(err.message) : err.message, true);
  }
}

function on(buttonId, action) {
  $(buttonId).onclick = () => act(action);
}

function button(text, onclick, className = '') {
  return el('button', { textContent: text, className, onclick });
}

const confirmRemove = () => confirm(t('confirm.remove'));

// ---- Finders: every place a person, household or place is chosen ----

const ALL_KINDS = ['person', 'household', 'place', 'event'];
const FINDER_KINDS = {
  search: ALL_KINDS, relExisting: ['person'], linkFrom: ALL_KINDS, linkTo: ALL_KINDS, relA: ['person'], relB: ['person'],
};
const FINDER_PICKED = {
  search: (item) => item && (item.tag ? addFilter(item) : openNode(item.id)),
  relExisting: (item) => ($('relNew').hidden = !!item),
};

// Found by the name shown, a nickname, or any name they have ever carried.
function itemOf(node) {
  const names = g.versions.filter((v) => v.node === node.id && v.field === 'name').flatMap((v) => [v.value.given, v.value.family]);
  return { id: node.id, label: label(node), detail: detail(node), keys: [label(node), node.props.nickname, ...names].filter(Boolean) };
}

// Tags the search box offers beside people: every family name, every place, every year someone was born.
// Picking one filters the picture instead of opening a person.
function tagItems() {
  const families = new Set(g.versions.filter((v) => v.field === 'name' && v.value.family).map((v) => v.value.family));
  const years = new Set(g.nodes.map((n) => yearOf(n.born)).filter((year) => !Number.isNaN(year)));
  const tag = (kind, value, text, keys) => ({ id: `${kind}:${value}`, tag: { kind, value }, label: `# ${text}`, detail: t('tag.' + kind), keys });
  return [
    ...[...families].map((name) => tag('family', name, name, [name])),
    ...g.nodes.filter((n) => n.kind === 'place').map((place) => tag('place', place.id, place.name, [place.name])),
    // A year is found by either calendar: 1990 and 2533 are the same tag.
    ...[...years].map((year) => tag('born', year, `${year} / ${year + 543}`, [String(year), String(year + 543)])),
  ];
}

function addFilter(item) {
  finders.search.set(null);
  if (!filters.some((f) => f.kind === item.tag.kind && f.value === item.tag.value)) filters.push({ ...item.tag, label: item.label });
  applyFilters();
}

function applyFilters() {
  const chips = filters.map((filter) => button(`${filter.label} ✕`, () => {
    filters = filters.filter((other) => other !== filter);
    applyFilters();
  }, 'ghost'));
  if (timeline !== null) {
    chips.push(button(`${t('filter.alive', { year: timeline })} ✕`, () => {
      $('timelineOn').checked = false;
      syncTimeline();
      applyFilters();
    }, 'ghost'));
  }
  $('chips').replaceChildren(...chips);
  draw();
  drawMap();
  // Fading changes how existing nodes look, so their shapes have to be made again.
  Graph.refresh();
}

// The timeline's slider runs from the earliest year in the record to this year.
function syncTimeline() {
  const years = g.nodes.flatMap((n) => [yearOf(n.born), yearOf(n.died)]).filter((year) => !Number.isNaN(year));
  const slider = $('timelineYear');
  $('timelineOn').disabled = !years.length;
  if (!years.length) $('timelineOn').checked = false;
  const on = $('timelineOn').checked;
  if (years.length) {
    const keep = slider.value;
    slider.min = Math.min(...years);
    slider.max = Math.max(...years, new Date().getFullYear());
    slider.value = on && keep ? keep : slider.max;
  }
  slider.disabled = !on;
  timeline = on ? Number(slider.value) : null;
  $('timelineLabel').textContent = !years.length ? t('timeline.none')
    : on ? t('timeline.year', { year: `${timeline} / ${timeline + 543}` }) : '';
}

const finders = {};
for (const [id, kinds] of Object.entries(FINDER_KINDS)) {
  finders[id] = createFinder($(id), {
    search: (query) => rank(query, [...(id === 'search' ? tagItems() : []), ...g.nodes.filter((n) => kinds.includes(n.kind)).map(itemOf)]),
    onPick: FINDER_PICKED[id],
  });
}

function openNode(id) {
  finders.search.set(null);
  select({ group: 'nodes', id });
  showTab('edit');
  if (view !== 'map') lookAt(id);
  else if (isPlaced(byId.get(id))) mapView.lookAt(byId.get(id).props);
}

// ---- Side panel ----

function showTab(name) {
  document.body.classList.remove('collapsed');
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('active', b.dataset.tab === name);
    $('tab-' + b.dataset.tab).hidden = b.dataset.tab !== name;
  }
  resize();
}

// Fill a fixed-choice dropdown with [value, text] pairs, keeping what was chosen.
function choices(select, pairs) {
  const keep = select.value;
  select.replaceChildren(...pairs.map(([value, text]) => new Option(text, value)));
  select.value = keep;
  if (select.selectedIndex < 0) select.selectedIndex = 0;
}

const SEXES = ['', 'female', 'male', 'other'];
const CHILD_KINDS = ['birth', 'adopted', 'step', 'foster'];
const NAME_REASONS = ['birth', 'marriage', 'divorce', 'other'];
const SOURCE_KINDS = ['certificate', 'register', 'photo', 'interview', 'memory', 'other'];
// "CHILD_OF:adopted" is the link type and, for children, how they joined.
const LINK_KINDS = ['PARTNER_IN', ...CHILD_KINDS.map((kind) => 'CHILD_OF:' + kind), 'BORN_IN', 'LIVED_IN', 'DIED_IN', 'GODPARENT_OF', 'FRIEND_OF', 'OTHER'];

function fillChoices() {
  choices($('kind'), ['person', 'place', 'event', 'household'].map((kind) => [kind, t('kind.' + kind)]));
  for (const id of ['sex', 'relSex']) choices($(id), SEXES.map((sex) => [sex, t('sex.' + sex)]));
  choices($('relKind'), CHILD_KINDS.map((kind) => [kind, t('rel.kind.' + kind)]));
  choices($('linkKind'), LINK_KINDS.map((kind) => [kind, t('link.' + kind)]));
  choices($('sourceKind'), SOURCE_KINDS.map((kind) => [kind, t('source.' + kind)]));
}

// The name and date fields mean different things for each kind of node.
function syncKindFields() {
  const kind = $('kind').value;
  for (const id of ['given', 'family', 'nickname', 'sex']) show(id, kind === 'person');
  show('name', kind === 'place' || kind === 'event');
  $('startLabel').textContent = t(kind === 'person' ? 'field.born' : kind === 'household' ? 'field.began' : 'field.from');
  $('endLabel').textContent = t(kind === 'person' ? 'field.died' : kind === 'household' ? 'field.ended' : 'field.until');
}

function syncLinkFields() {
  show('linkType', $('linkKind').value === 'OTHER');
}

const findLink = (id) => g.edges.find((e) => e.id === id) ?? g.rivals.find((e) => e.id === id);
const currentName = (personId) =>
  nameRecord(g.versions.filter((v) => v.node === personId && v.target === null && v.accepted)).at(-1)?.value;

// ---- Adding a relative ----

function chooseRelation(next) {
  relation = next;
  for (const b of document.querySelectorAll('[data-relation]')) b.classList.toggle('active', b.dataset.relation === relation);
  $('relativeForm').hidden = !relation;
  if (!relation) return;

  const person = byId.get(selected.id);
  finders.relExisting.set(null);
  $('relNew').hidden = false;
  for (const id of ['relGiven', 'relFamily', 'relBorn', 'relSex', 'relMarried']) $(id).value = '';
  $('relKind').value = 'birth';
  show('relHousehold', relation === 'child');
  show('relKind', relation !== 'partner');
  show('relMarried', relation === 'partner');
  show('relTakeName', relation === 'partner');

  if (relation === 'child') {
    // One choice per household this person is a partner in, named by the other partner.
    const rows = g.edges.filter((e) => e.type === 'PARTNER_IN' && e.src === person.id).map((e) => [
      String(e.dst),
      membersOf(e.dst, 'PARTNER_IN').filter((p) => p.id !== person.id).map(label).join(' & '),
    ]);
    // Offer a household with the other parent unknown, unless there already is one.
    if (rows.every(([, names]) => names)) rows.push(['new', '']);
    choices($('relHousehold'), rows.map(([value, names]) => [value, names || t('rel.otherParentUnknown')]));
    $('relHousehold').selectedIndex = 0;
  }
  choices($('relTakeName'), [
    ['', t('rel.name.keep')],
    ['other', t('rel.name.other', { name: label(person) })],
    ['person', t('rel.name.person', { name: label(person) })],
  ]);
  $('relTakeName').value = '';
  $('addRelative').textContent = t('rel.add', { relation: t('rel.' + relation).toLowerCase() });
  suggestFamilyName();
}

// Offer the family name a new relative would most likely carry; filled in only when there is no doubt.
function suggestFamilyName() {
  const person = byId.get(selected.id);
  let names = [];
  if (relation === 'child') {
    const household = Number($('relHousehold').value);
    names = (household ? membersOf(household, 'PARTNER_IN') : [person]).map((p) => p.familyName);
  } else if (relation !== 'partner') {
    names = [person.birthFamilyName];
  }
  names = [...new Set(names.filter(Boolean))];
  $('relFamilies').replaceChildren(...names.map((name) => new Option(name)));
  $('relFamily').value = names.length === 1 ? names[0] : '';
}

on('addRelative', async () => {
  const text = (id) => $(id).value.trim();
  const existing = finders.relExisting.value;
  if (!existing && !text('relGiven') && !text('relFamily')) throw new Error(t('error.nameOrPick'));
  await api('POST', 'relatives', {
    person: selected.id,
    relation,
    other: existing ?? { facts: {
      name: { given: text('relGiven'), family: text('relFamily') },
      sex: { sex: $('relSex').value },
      born: { date: text('relBorn') },
    } },
    kind: $('relKind').value,
    household: relation === 'child' ? Number($('relHousehold').value) || null : null,
    takeName: relation === 'partner' ? $('relTakeName').value : '',
    married: relation === 'partner' ? text('relMarried') : '',
  });
  return t('toast.added');
});

// ---- Versions, sources and the edit log ----

// "According to" is a person in the record when the text matches one exactly, otherwise just a name.
function according(text) {
  const name = text.trim();
  const person = g.nodes.find((n) => n.kind === 'person' && n.name === name);
  return person ? { accordingTo: '', accordingNode: person.id } : { accordingTo: name, accordingNode: null };
}

const accordingText = (version) => (version.accordingNode ? byId.get(version.accordingNode)?.name : version.accordingTo) ?? '';

function describeVersion(v) {
  if (v.target !== null) return linkSentence({ src: v.node, dst: v.target, type: v.field, props: v.value, accepted: true });
  if (v.field === 'name') {
    return [fullName(v.value) || t('record.noName'), v.value.from && t('record.from', { year: v.value.from }), v.value.reason && t('reason.' + v.value.reason)]
      .filter(Boolean).join(' · ');
  }
  return v.field === 'sex' ? t('sex.' + v.value.sex) : v.value.date ?? '';
}

// One version: what it says, accept / remove, who it is according to, and its sources.
function versionRow(v) {
  const head = el('div');
  head.append(el('span', { textContent: describeVersion(v) }));
  head.append(v.accepted
    ? el('em', { textContent: t('record.accepted') })
    : button(t('record.accept'), () => act(() => api('POST', `versions/${v.id}/accept`), t('toast.accepted'))));
  head.append(button('✕', () => act(async () => {
    if (!confirmRemove()) return false;
    await api('DELETE', 'versions/' + v.id);
  }, t('toast.removed')), 'danger'));

  const by = el('input', { value: accordingText(v), placeholder: t('links.by'), title: t('links.byHint') });
  by.setAttribute('list', 'people');
  by.onchange = () => act(() => api('PUT', 'versions/' + v.id, according(by.value)), t('toast.saved'));

  const sources = el('div');
  for (const id of v.sources) {
    const source = g.sources.find((s) => s.id === id);
    sources.append(button(`${source.title} ✕`, () =>
      act(() => api('PUT', 'versions/' + v.id, { sources: v.sources.filter((other) => other !== id) }), t('toast.saved')), 'ghost'));
  }
  const attach = el('select');
  attach.append(new Option(t('record.attach'), ''), ...g.sources.filter((s) => !v.sources.includes(s.id)).map((s) => new Option(`${s.title} (${t('source.' + s.kind)})`, s.id)));
  attach.onchange = () => act(() => api('PUT', 'versions/' + v.id, { sources: [...v.sources, Number(attach.value)] }), t('toast.saved'));

  const row = el('li', { className: 'version' + (v.accepted ? ' active' : '') });
  row.append(head, by, sources, attach);
  return row;
}

const FIELD_KEYS = { name: ['given', 'family', 'from', 'reason'], born: ['date'], died: ['date'], sex: ['sex'] };
const FIELD_HINT = { given: 'field.given', family: 'field.family', from: 'record.fromHint', date: 'field.dateHint' };
const FIELD_CHOICES = { sex: [SEXES, 'sex.'], reason: [NAME_REASONS, 'reason.'] };

// A small form that adds a version: the first one of a new fact, or another account of an existing fact.
function versionForm(field, target, defaults = {}) {
  const keys = FIELD_KEYS[field];
  const inputs = keys.map((key) => {
    const input = FIELD_CHOICES[key] ? el('select') : el('input', { placeholder: t(FIELD_HINT[key]) });
    input.setAttribute('aria-label', t(FIELD_HINT[key] ?? 'field.' + key));
    if (FIELD_CHOICES[key]) {
      const [values, prefix] = FIELD_CHOICES[key];
      input.append(...values.map((value) => new Option(t(prefix + value), value)));
    }
    input.value = defaults[key] ?? input.value;
    return input;
  });
  const by = el('input', { placeholder: t('links.byHint') });
  by.setAttribute('list', 'people');
  const form = el('div', { className: 'draft' });
  form.append(...inputs, by, button(target.fact ? t('record.addVersion') : t('record.add'), () => act(() => {
    const value = Object.fromEntries(keys.map((key, i) => [key, inputs[i].value.trim()]).filter(([, text]) => text));
    if (field === 'name' ? !value.given && !value.family : !Object.keys(value).length) throw new Error(t('record.fillFirst'));
    return api('POST', 'versions', { ...target, field, value, ...according(by.value) });
  }, t('toast.added'))));
  return form;
}

function factBlock(title, field, node, versions, defaults) {
  const box = el('fieldset');
  const list = el('ul', { className: 'rows' });
  list.append(...versions.map(versionRow));
  box.append(el('legend', { textContent: title }), list, versionForm(field, versions.length ? { node, fact: versions[0].fact } : { node }, defaults));
  return box;
}

function logText({ summary }) {
  if (summary.action === 'legacy') return summary.text;
  if (summary.action === 'undid') return t('log.undid', { what: logText({ summary: summary.of }) });
  const what = summary.action === 'addedRelative' ? t('rel.' + summary.relation)
    : summary.field ? t('field.' + summary.field)
    : t('kind.' + summary.kind);
  const name = summary.name || (summary.kind === 'household' ? '' : t('person.unnamed'));
  return t('log.' + summary.action, { what: what.toLowerCase(), name }).replace(/:\s*$/, '');
}

function renderRecord() {
  const node = selected?.group === 'nodes' ? byId.get(selected.id) : null;
  const person = node?.kind === 'person' ? node : null;
  const blocks = [];
  if (person) {
    const mine = g.versions.filter((v) => v.node === person.id && v.target === null);
    const names = nameRecord(mine.filter((v) => v.accepted));
    names.forEach((name, i) => {
      const title = `${label(person)}: ${t(i === names.length - 1 ? 'record.currentName' : 'record.earlierName')}`;
      blocks.push(factBlock(title, 'name', person.id, mine.filter((v) => v.fact === name.fact)));
    });
    blocks.push(factBlock(t('record.changedName'), 'name', person.id, [], { given: names.at(-1)?.value.given, reason: 'marriage' }));
    for (const field of ['born', 'died', 'sex']) {
      blocks.push(factBlock(t('field.' + field), field, person.id, mine.filter((v) => v.field === field)));
    }
  }
  $('recordFacts').replaceChildren(...blocks);

  $('sourceList').replaceChildren(...g.sources.map((source) => {
    const used = g.versions.filter((v) => v.sources.includes(source.id)).length;
    const text = `${source.title} · ${t('source.' + source.kind)} · ${t('record.supports', { count: used })}`;
    const row = el('li');
    row.append(el('span', { textContent: text, title: source.note }), button('✕', () => act(async () => {
      if (!confirmRemove()) return false;
      await api('DELETE', 'sources/' + source.id);
    }, t('toast.removed')), 'danger'));
    return row;
  }));

  $('logList').replaceChildren(...g.log.map((entry) => {
    const when = new Date(entry.at.replace(' ', 'T') + 'Z').toLocaleString(getLang());
    const row = el('li');
    row.append(el('span', { textContent: logText(entry) + (entry.undone ? ` (${t('record.undone')})` : ''), title: when }));
    if (entry.removable && !entry.undone) {
      row.append(button(t('record.undo'), () => act(() => api('POST', `log/${entry.id}/undo`), t('toast.restored')), 'ghost'));
    }
    return row;
  }));
}

// Choose a color, or pass none to go back to the automatic one. group is 'family', 'node', 'link' or 'kind'.
function saveColor(group, key, color) {
  const colors = structuredClone(g.colors);
  colors[group] = { ...colors[group], [key]: color };
  if (!color) delete colors[group][key];
  return act(() => api('PUT', 'colors', colors), t('toast.saved'));
}

// The Edit tab's color for whatever is selected. For someone with a family name it is the family's color.
function renderNodeColor(node) {
  $('colorBox').hidden = !node;
  if (!node) return;
  const [group, key] = colorKey(node);
  $('colorLabel').textContent = group === 'family' ? t('colors.ofFamily', { name: key }) : t('colors.ofThis');
  $('nodeColor').value = toHex(nodeColor(node));
  $('nodeColor').onchange = () => saveColor(group, key, $('nodeColor').value);
  $('nodeColorReset').hidden = !g.colors[group]?.[key];
  $('nodeColorReset').onclick = () => saveColor(group, key, null);
}

// The View tab's list of the colors shared by many things; ↺ returns one to its automatic color.
function renderColors() {
  const families = [...new Set(g.nodes.map((n) => n.birthFamilyName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const linkTypes = [...new Set(['PARTNER_IN', 'CHILD_OF', ...g.edges.map((e) => e.type)])];
  const groups = [
    ['colors.families', 'family', families.map((name) => [name, name])],
    ['colors.links', 'link', linkTypes.map((type) => [type, edgeText({ type, props: {} })])],
    ['colors.others', 'kind', ['place', 'event'].map((kind) => [kind, t('kind.' + kind)])],
  ];
  $('colorRows').replaceChildren(...groups.map(([title, group, rows]) => {
    const list = el('ul', { className: 'rows' });
    list.append(...rows.map(([key, text]) => {
      const picker = el('input', { type: 'color', value: toHex(colorOf(group, key)), title: text });
      picker.onchange = () => saveColor(group, key, picker.value);
      const row = el('li');
      row.append(picker, el('span', { textContent: text }));
      if (g.colors[group]?.[key]) {
        const reset = button('↺', () => saveColor(group, key, null), 'ghost');
        reset.title = t('colors.reset');
        row.append(reset);
      }
      return row;
    }));
    const box = el('fieldset');
    box.append(el('legend', { textContent: t(title) }), rows.length ? list : el('p', { className: 'hint', textContent: t('colors.noFamilies') }));
    return box;
  }));
}

function renderLinkList() {
  const nodeId = selected?.group === 'nodes' ? selected.id : null;
  const all = [...g.edges, ...g.rivals];
  const links = nodeId ? all.filter((e) => e.src === nodeId || e.dst === nodeId) : all;
  $('linkListLegend').textContent = nodeId ? t('links.of', { name: label(byId.get(nodeId)) }) : t('links.all');
  $('linkList').replaceChildren(...links.map((e) => {
    const row = el('li', { className: isSelected('edges', e.id) ? 'active' : '' });
    row.append(el('span', { textContent: linkSentence(e) }), button('✕', (evt) => {
      evt.stopPropagation();
      deleteLink(e.id);
    }, 'danger'));
    row.onclick = () => select({ group: 'edges', id: e.id });
    return row;
  }));
  if (!links.length) $('linkList').append(el('li', { textContent: t('links.none') }));

  const edge = selected?.group === 'edges' ? findLink(selected.id) : null;
  $('linkVersionsBox').hidden = !edge;
  $('linkVersions').replaceChildren(...(edge ? g.versions.filter((v) => v.fact === edge.fact).map(versionRow) : []));
}

// Point the panel at a node, a link, or nothing (which resets the forms to "new").
function select(next) {
  selected = next;
  const node = selected?.group === 'nodes' ? byId.get(selected.id) : null;
  const edge = selected?.group === 'edges' ? findLink(selected.id) : null;
  const person = node?.kind === 'person' ? node : null;
  const place = node?.kind === 'place' ? node : null;

  // The details form sits in the Add tab until something is selected, then in the Edit tab.
  $(node ? 'editSlot' : 'addSlot').append($('nodeBox'));
  $('editHint').hidden = !!node;
  if (node && !$('tab-add').hidden) showTab('edit');
  renderNodeColor(node);

  $('whereBox').hidden = !place;
  $('whereChoices').replaceChildren();
  if (place) $('whereStatus').textContent = t(isPlaced(place) ? 'map.placed' : 'map.notPlaced');

  $('card').hidden = !node;
  if (node) {
    $('cardName').textContent = label(node);
    $('cardDetail').textContent = detail(node);
    $('cardPhoto').hidden = !node.photo;
    if (node.photo) $('cardPhoto').src = '/api/photos/' + node.id;
  }
  $('relatives').hidden = !person;
  if (person) $('relativesLegend').textContent = t('rel.title', { name: label(person) });
  chooseRelation(null);

  $('nodeLegend').textContent = node ? t('people.edit', { name: label(node) }) : t('people.new');
  $('add').hidden = !!node;
  for (const id of ['save', 'newNode', 'del']) $(id).hidden = !node;
  // A household is made by adding relatives, so it is only offered here when you are looking at one.
  [...$('kind').options].find((option) => option.value === 'household').hidden = node?.kind !== 'household';
  if (node) $('kind').value = node.kind;
  else if ($('kind').value === 'household') $('kind').value = 'person';
  show('kind', !node);
  const name = person && currentName(person.id);
  $('name').value = node?.name ?? '';
  $('given').value = name?.given ?? '';
  $('family').value = name?.family ?? '';
  $('nickname').value = node?.props.nickname ?? '';
  $('sex').value = node?.sex ?? '';
  $('start').value = (person ? person.born : node?.props.start) ?? '';
  $('end').value = (person ? person.died : node?.props.end) ?? '';
  $('notes').value = node?.props.notes ?? '';
  $('photoFile').value = '';
  $('photo').hidden = true;
  syncKindFields();

  $('linkLegend').textContent = edge ? t('links.edit') : t('links.new');
  $('addLink').hidden = !!edge;
  for (const id of ['saveLink', 'rivalLink', 'newLink', 'delLink']) $(id).hidden = !edge;
  $('linkBy').value = edge ? accordingText(g.versions.find((v) => v.id === edge.id)) : '';
  if (edge) {
    finders.linkFrom.set(itemOf(byId.get(edge.src)));
    finders.linkTo.set(itemOf(byId.get(edge.dst)));
    const kind = edge.type === 'CHILD_OF' ? `CHILD_OF:${edge.props.kind ?? 'birth'}` : edge.type;
    $('linkKind').value = LINK_KINDS.includes(kind) ? kind : 'OTHER';
    $('linkType').value = $('linkKind').value === 'OTHER' ? edge.type.toLowerCase().replaceAll('_', ' ') : '';
  }
  syncLinkFields();
  renderLinkList();
  renderRecord();
  renderColors();
  Graph.refresh();
}

async function refresh() {
  const [data, log] = await Promise.all([api('GET', 'graph'), api('GET', 'log')]);
  const links = data.versions.filter((v) => v.target !== null)
    .map((v) => ({ id: v.id, fact: v.fact, src: v.node, dst: v.target, type: v.field, props: v.value, accepted: v.accepted }));
  // Every view is computed from the accepted links; the rivals are only listed, and drawn on request.
  g = { ...data, edges: links.filter((l) => l.accepted), rivals: links.filter((l) => !l.accepted), log };
  byId = new Map(g.nodes.map((n) => [n.id, n]));
  const stillThere = selected && (selected.group === 'nodes' ? byId.has(selected.id) : findLink(selected.id));
  // A tag for a place that has since been removed no longer means anything.
  filters = filters.filter((f) => f.kind !== 'place' || byId.has(f.value));
  syncTimeline();
  applyFilters();
  $('people').replaceChildren(...g.nodes.filter((n) => n.kind === 'person' && n.name).map((n) => new Option(n.name)));
  // Anything chosen in a finder may have been renamed or removed.
  for (const finder of Object.values(finders)) finder.set(byId.has(finder.value) ? itemOf(byId.get(finder.value)) : null);
  select(stillThere ? selected : null);
  if (lookUpNext !== null) {
    const place = byId.get(lookUpNext);
    lookUpNext = null;
    if (place) findPlace(place);
  }
}

function nodeForm() {
  const kind = $('kind').value;
  const text = (id) => $(id).value.trim();
  const props = text('notes') ? { notes: text('notes') } : {};
  if (kind === 'person') {
    if (!text('given') && !text('family') && !text('nickname')) throw new Error(t('error.nameOrNick'));
    if (text('nickname')) props.nickname = text('nickname');
    return { kind, props, facts: {
      name: { given: text('given'), family: text('family') },
      born: { date: text('start') },
      died: { date: text('end') },
      sex: { sex: $('sex').value },
    } };
  }
  if (kind !== 'household' && !text('name')) throw new Error(t('error.name'));
  for (const key of ['start', 'end']) if (text(key)) props[key] = text(key);
  // Where a place is on the map is not part of this form, so carry it over.
  const { lat, lng } = (selected?.group === 'nodes' && byId.get(selected.id)?.props) || {};
  if (lat !== undefined) Object.assign(props, { lat, lng });
  return { kind, name: kind === 'household' ? '' : text('name'), props };
}

// A link is a version too: { node, field, target, value }.
function linkForm() {
  const node = finders.linkFrom.value;
  const target = finders.linkTo.value;
  const [field, kind] = $('linkKind').value.split(':');
  const by = according($('linkBy').value);
  if (!node || !target) throw new Error(t('links.pickBoth'));
  if (field === 'OTHER') {
    const typed = $('linkType').value.trim().toUpperCase().replace(/\s+/g, '_');
    if (!typed) throw new Error(t('links.needType'));
    return { node, target, field: typed, value: {}, ...by };
  }
  const needsHousehold = field === 'PARTNER_IN' || field === 'CHILD_OF';
  if (needsHousehold && (byId.get(node).kind !== 'person' || byId.get(target).kind !== 'household')) throw new Error(t('links.needHousehold'));
  if (field.endsWith('_IN') && !needsHousehold && byId.get(target).kind !== 'place') throw new Error(t('links.needPlace'));
  return { node, target, field, value: kind ? { kind } : {}, ...by };
}

// Center-crop to a small square JPEG so photos stay light in the database and in the 3D scene.
async function squareJpeg(file, size = 256) {
  const image = await createImageBitmap(file).catch(() => {
    throw new Error(t('error.image'));
  });
  const side = Math.min(image.width, image.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d')
    .drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

async function uploadPhoto(nodeId, jpeg) {
  const res = await fetch('/api/photos/' + nodeId, { method: 'PUT', body: jpeg });
  if (!res.ok) throw new Error((await res.json()).error);
  textures.delete(nodeId);
}

function deleteLink(id) {
  return act(async () => {
    if (!confirmRemove()) return false;
    await api('DELETE', 'versions/' + id);
  }, t('toast.removed'));
}

on('add', async () => {
  const [file] = $('photoFile').files;
  // Read the photo first, so an unreadable file stops the add instead of leaving a half-made person.
  const jpeg = file && await squareJpeg(file);
  const node = await api('POST', 'nodes', nodeForm());
  if (jpeg) await uploadPhoto(node.id, jpeg);
  // A new place is opened and looked up on the map straight away.
  if (node.kind === 'place') {
    selected = { group: 'nodes', id: node.id };
    lookUpNext = node.id;
  }
  return t('toast.added');
});

on('save', async () => {
  await api('PUT', 'nodes/' + selected.id, nodeForm());
  return t('toast.saved');
});

on('del', async () => {
  if (!confirmRemove()) return false;
  await api('DELETE', 'nodes/' + selected.id);
  return t('toast.removed');
});

on('addLink', async () => {
  await api('POST', 'versions', linkForm());
  return t('toast.added');
});

on('saveLink', async () => {
  await api('PUT', 'versions/' + selected.id, linkForm());
  return t('toast.saved');
});

on('rivalLink', async () => {
  await api('POST', 'versions', { ...linkForm(), fact: findLink(selected.id).fact });
  return t('toast.added');
});

on('addSource', async () => {
  if (!$('sourceTitle').value.trim()) throw new Error(t('record.needTitle'));
  await api('POST', 'sources', { kind: $('sourceKind').value, title: $('sourceTitle').value.trim(), note: $('sourceNote').value.trim() });
  $('sourceTitle').value = $('sourceNote').value = '';
  return t('toast.added');
});

$('delLink').onclick = () => deleteLink(selected.id);
$('newNode').onclick = () => select(null);
$('newLink').onclick = () => select(null);
$('kind').onchange = syncKindFields;
$('linkKind').onchange = syncLinkFields;
$('relHousehold').onchange = suggestFamilyName;
$('timelineOn').onchange = $('timelineYear').oninput = () => {
  syncTimeline();
  applyFilters();
};
$('closeSteps').oninput = () => {
  maxSteps = Number($('closeSteps').value);
  $('closeLabel').textContent = t('close.upTo', { count: maxSteps });
  Graph.linkVisibility(linkVisible);
};
$('lookUpPlace').onclick = () => findPlace(byId.get(selected.id));
$('placeByHand').onclick = () => placeByHand(selected.id);
for (const b of document.querySelectorAll('[data-relation]')) {
  b.onclick = () => chooseRelation(relation === b.dataset.relation ? null : b.dataset.relation);
}

// Editing someone: the photo saves at once. Adding someone: it is held until you press Add.
$('photoFile').onchange = async () => {
  const [file] = $('photoFile').files;
  if (!file) return;
  if (selected?.group !== 'nodes') {
    $('photo').src = URL.createObjectURL(file);
    $('photo').hidden = false;
    return;
  }
  try {
    await uploadPhoto(selected.id, await squareJpeg(file));
    await refresh();
    notify(t('toast.photo'));
  } catch (err) {
    notify(err.message, true);
  }
};

$('relate').onclick = () => {
  const a = finders.relA.value;
  const b = finders.relB.value;
  if (!a || !b) return notify(t('related.pickBoth'), true);
  const rel = kinship(a, b, g.edges);
  // For relatives, trace the family line itself rather than a shortcut through, say, a godparent.
  const familyLine = g.edges.filter((e) => e.type === 'PARTNER_IN' || isDescent(e));
  const path = shortestPath(a, b, rel ? familyLine : g.edges);
  const nameA = label(byId.get(a));

  let text = rel?.kind === 'self' ? t('related.self')
    : rel ? t('related.sentence', {
      a: nameA,
      b: label(byId.get(b)),
      term: kinshipTerm(rel, getLang(), { A: byId.get(a), B: byId.get(b), via: byId.get(rel.via) }),
    })
    : t(path ? 'related.connected' : 'related.none');
  onPath = new Set();
  if (path?.length) {
    text += '\n\n' + nameA;
    onPath.add(a);
    for (const { edge, from, to } of path) {
      const forward = edge.src === from;
      text += `\n${forward ? '—' : '←'} ${edgeText(edge)} ${forward ? '→' : '—'} ${label(byId.get(to))}`;
      onPath.add('e' + edge.id);
      onPath.add(to);
    }
  }
  Graph.refresh();
  $('result').textContent = text;
};

// ---- The bar over the picture ----

// Clicking the open tab again folds the panel away, as the ☰ button does.
for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    if (b.classList.contains('active')) return togglePanel();
    // Going to Add means starting something new, so let go of what was selected.
    if (b.dataset.tab === 'add' && selected) select(null);
    showTab(b.dataset.tab);
  };
}
function togglePanel() {
  document.body.classList.toggle('collapsed');
  resize();
}
$('togglePanel').onclick = togglePanel;

for (const b of document.querySelectorAll('#views [data-view]')) b.onclick = () => setView(b.dataset.view);
$('fit').onclick = () => (view === 'map' ? mapView.fit() : frame());
$('rivals').onclick = () => {
  showRivals = !showRivals;
  $('rivals').classList.toggle('active', showRivals);
  draw();
};

$('themeSwitch').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  prefs.set('theme', next);
  applyTheme();
};
systemDark.onchange = applyTheme;

// Put every text into the chosen language, including the ones built from the record.
function relabel(lang) {
  setLang(lang);
  prefs.set('lang', lang);
  const other = Object.keys(LANGS).find((code) => code !== getLang());
  $('langSwitch').textContent = LANGS[other];
  $('langSwitch').onclick = () => relabel(other);
  for (const [id, finder] of Object.entries(finders)) finder.input.placeholder = t(id === 'relExisting' ? 'rel.existingHint' : 'bar.search');
  fillChoices();
  $('result').textContent = '';
  $('closeLabel').textContent = t('close.upTo', { count: maxSteps });
  showLegend();
  syncTimeline();
  applyFilters();
  select(selected);
}

function resize() {
  Graph.width($('stage').clientWidth).height($('stage').clientHeight);
  mapView?.resize();
}
window.addEventListener('resize', resize);
resize();

setMouse();
relabel(prefs.get('lang') ?? (navigator.language.startsWith('th') ? 'th' : 'en'));
refresh().catch((err) => notify(err.message, true));
