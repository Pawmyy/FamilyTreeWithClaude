# Family Graph

A family record stored as a graph instead of a tree. It keeps competing versions of each fact side by side, and shows the family in 3D, 2D or as generations in rows.

## Run

Needs Node 24+ (uses the built-in `node:sqlite`). No `npm install`.

```
npm run seed    # optional: load a made-up Thai family into an empty family.db
npm start       # http://localhost:3000, restarts itself when server.js changes
npm test
npm run examples   # three film families in their own record, on http://localhost:3001
```

Data lives in `family.db` (set `DB=path` to use another file), photos included. Back it up by copying the file.
A database from the first version is converted the first time it is opened; the original is kept beside it as `family.db.v1.bak`.
The page loads its libraries (3d-force-graph, three.js, Leaflet) from esm.sh and unpkg, and the map loads its tiles from OpenStreetMap, so the views need an internet connection.

Terms are defined in `GLOSSARY.md`; the reasons behind the main design choices are in `docs/adr/`.

## Data model

| Table | Holds |
|---|---|
| `nodes(id, kind, name, props)` | People, households, places, events. `props` is JSON for single-valued details: notes, nickname, a household's or place's dates. |
| `versions(id, fact_id, node_id, field, target_id, value, accepted, according_to, according_node)` | Every fact, as one or more competing accounts. |
| `sources(id, kind, title, note)` and `version_sources` | Evidence, attachable to any number of versions. |
| `settings(key, value)` | Choices about how the record is shown, such as colors. Not facts, so not versioned. |
| `photos(node_id, data)` | One photo per node, cropped to a 256px square JPEG by the page before upload. |
| `log(id, at, summary, removed, undone)` | Every change. A removal keeps the removed rows, so it can be undone. |

A version is one of two things:

| `target_id` | Meaning | `field` | `value` |
|---|---|---|---|
| empty | Something about the person | `name` | `{ given, family, from, reason }`, one entry of the name record |
| | | `born`, `died` | `{ date }`, free text so "c. 1890" or a Buddhist Era year is fine |
| | | `sex` | `{ sex }` |
| a node | A link from `node_id` to `target_id` | `PARTNER_IN` | person → household |
| | | `CHILD_OF` | person → household, `{ kind }` is `birth`, `adopted`, `step` or `foster` |
| | | anything else | free-form, e.g. `GODPARENT_OF`, `LIVED_IN` |

Versions that share a `fact_id` are rival accounts of the same fact, and exactly one of them is accepted.
Every view, and "how are they related", uses only accepted versions. Adding a version to an existing fact
never changes what is accepted; you accept it yourself. If the accepted version is removed, the oldest rival takes its place.

A person's displayed name is the latest entry in their name record. The family name they were born with is kept
even after it changes. Every field is optional; a person with nothing but a nickname is fine.

Remarriage is a second household for the same person; half-siblings fall out of that without being stored.
A household can start with no parents recorded: add the children, and attach parents whenever they become known.

## Views

Switched at the top right.

- **3D** and **2D**: everything in the record, finding its own place. Link length shows the kind of tie: partners sit closest, then birth children, adopted, step and foster, with free-form links longest. On top of that, every two people on the same family tree pull gently toward each other by their closeness, the number of steps between them (parent to child is one step, partners one step), so near relatives settle together and distant ones apart. Closeness lines can be switched on in the View tab: one is drawn between people up to a number of steps apart that you choose, thinner the further apart. **Disputed** also draws the versions of links that are not accepted.
- **Tree**: the traditional family tree, built as its own structure (`public/tree.js`). The whole family is drawn as descendant trees side by side, one per founder, generations in rows, with square-cornered lines down to children. A household's children are drawn under the partner whose family name they carry. A person is drawn in full once, under their own parents; beside a partner in another tree they appear as a faint copy marked ↗, and clicking it goes to the full one. Step and foster ties, places and events are left out of this view.
- **Map**: places on a real map (OpenStreetMap), held to Thailand and China for now. A new place is looked up by its name; one match is used, several are offered for you to pick, and if nothing is found you click the spot. Only the place's name is sent to the lookup service. A place lists the people linked to it by born in, lived in or died in.

Shapes show the kind of thing: sphere for a person, diamond for a household, cube for a place, pyramid for an event. A photo replaces the shape.

Dragging turns the 3D view and moves the flat ones; in 3D, hold Shift or use the right button to move. Zoom is limited to between a single node and the whole family, and the family cannot be dragged off the screen. **Fit** re-frames everything.

### Finding and filtering

The search box finds anyone by any name they have carried, or by nickname, and brings them to the middle of the picture without changing which way you are looking. It also offers **tags**, marked `#`: a family name, a place, or a year of birth (typed in either calendar). Picking a tag fades everyone it does not fit. Several tags of one kind widen the match; tags of different kinds narrow it. A family-name tag fits anyone who has ever carried that name.

The **timeline** in the View tab picks a span of years with a handle at each end (put them together for a single year): people not alive at any time in it fade, and people with no birth date are hidden. Someone with no death date counts as alive for 100 years.

### Colors

A person wears the color of the family name they were born with and keeps it for life, so everyone born with one name shares one color. It is worked out from the name itself until you choose another. Select anything and its color can be changed in the Edit tab: for a person with a family name that changes the whole family; anything else (a household, a place, an event, a person with no family name) gets a color of its own. Colors for each kind of link are in the View tab. All choices are kept in the database.

## Side panel

The panel folds away with the ☰ button, or by clicking the open tab again.

- **Add**: a new person, place or event.
- **Edit**: opens whenever you select something. A person's details, adding a relative (a parent, partner, child or sibling; the household in between is made for you, a child is offered the parents' family name, and a partner can take the other's family name and record the date they married), their color, and their name record with the versions of each fact. For a place, where it is on the map.
- **Links**: add, change or remove a link, or save a rival version of one.
- **Related**: how two people are related.
- **View**: the timeline, whether closeness lines are drawn and for how many steps apart, the colors shared by many things, the list of sources, and the edit log, where removals can be undone.

## Languages and themes

The interface is in English and Thai, following the browser's language until you switch. All text lives in `public/i18n.js`;
adding a language is adding one more block there. Light and dark themes follow the device's setting until you switch.
Both choices are remembered in the browser.

## Files

| File | What it is |
|---|---|
| `server.js` | Storage and the HTTP API. |
| `public/index.html`, `app.css`, `app.js` | The page: markup, themes, and behavior. |
| `public/i18n.js` | Every interface text, per language. |
| `public/finder.js` | The fuzzy finder. |
| `public/kinship.js`, `terms.js` | Working out how two people are related, how close everyone is, and the word for a relationship in each language. |
| `examples.js` | Builds the example record: the Skywalkers, the Corleones, and the Weasleys and Potters. |
| `public/tree.js` | The traditional tree: which tree each person belongs in, and where everything is drawn. |
| `public/map.js` | The map view and looking a place up by name. |
| `public/record.js` | Name-record ordering, shared by server and page. |

## Relationship rules

"How are they related?" names the relationship (`second cousin once removed`) by finding the closest
common ancestor through `birth` and `adopted` links. Step and foster links do not count as descent.
Children of a household with no recorded parents still count as siblings.
When no kinship exists it shows the shortest chain of links of any type instead (in-laws, godparents,
a shared place).

The word used depends on what is recorded. With a person's sex, English says `uncle` instead of `aunt/uncle`.
Thai also needs the side of the family and who is older: a mother's younger sibling is น้า, a father's is อา,
an older sibling of either parent is ลุง or ป้า; a father's parents are ปู่ and ย่า, a mother's ตา and ยาย.
Ages come from the first year found in each birth date, with Buddhist Era years converted. When something is
missing the wording falls back to a neutral phrase.
