// The map view: places on a real map, and looking a place up by its name, both from Google Maps.
// For now the map is held to Thailand and China.
import { GOOGLE_MAPS_KEY } from './key.js';

// Builds that cannot reach a map service swap this file for one that says false.
export const hasMap = true;

const REGION = { south: 5.6, west: 73.5, north: 53.6, east: 135.1 };
// A little beyond the region, which is as far as the map can be moved.
const REACH = { south: 0.8, west: 67.3, north: 58.4, east: 141.3 };
const COUNTRIES = ['TH', 'CN'];

// Google's map code is fetched the first time it is needed, in the language the page is in then.
// Rejects with the name of a text saying why there is no map: 'map.noKey' or 'map.offline'.
let loading = null;
function load(lang) {
  loading ??= new Promise((resolve, reject) => {
    if (!GOOGLE_MAPS_KEY) return reject(new Error('map.noKey'));
    window.googleMapsReady = () => resolve(window.google.maps);
    const query = new URLSearchParams({ key: GOOGLE_MAPS_KEY, v: 'weekly', loading: 'async', language: lang, callback: 'googleMapsReady' });
    const script = Object.assign(document.createElement('script'), { src: 'https://maps.googleapis.com/maps/api/js?' + query, async: true });
    script.onerror = () => {
      // Not reached this time; the next look-up may try again.
      script.remove();
      loading = null;
      reject(new Error('map.offline'));
    };
    document.head.append(script);
  });
  return loading;
}

// `onClick({ lat, lng })` is called for a click on the map itself. When there can be no map, the box
// says why instead, in the words `problem(name)` gives for 'map.noKey' or 'map.offline'.
export function createMap(container, { onClick, lang, problem }) {
  let map = null;
  let popup = null;
  let markers = [];
  const ready = load(lang).then((maps) => {
    map = new maps.Map(container, {
      restriction: { latLngBounds: REACH }, minZoom: 3, gestureHandling: 'greedy', clickableIcons: false,
      // The page's own bar sits along the top, so only the zoom buttons are kept, at the bottom.
      disableDefaultUI: true, zoomControl: true, zoomControlOptions: { position: maps.ControlPosition.RIGHT_BOTTOM },
    });
    map.fitBounds(REGION);
    map.addListener('click', (evt) => onClick({ lat: evt.latLng.lat(), lng: evt.latLng.lng() }));
    popup = new maps.InfoWindow();
    return maps;
  });
  ready.catch((err) => container.replaceChildren(Object.assign(document.createElement('p'), { className: 'map-problem', textContent: problem(err.message) })));
  const whenReady = (work) => ready.then(work, () => {});

  return {
    // places: [{ id, name, lat, lng, color, people: [{ id, text }] }]. A marker opens a list of its people;
    // `onOpen(id)` is called when the place or one of the people is chosen from it.
    show: (places, onOpen) => whenReady((maps) => {
      for (const marker of markers) marker.setMap(null);
      popup.close();
      markers = places.map((place) => {
        const list = document.createElement('div');
        list.className = 'map-popup';
        const row = (text, id, tag) => {
          const button = Object.assign(document.createElement('button'), { textContent: text, className: tag });
          button.onclick = () => onOpen(id);
          list.append(button);
        };
        row(place.name, place.id, 'place');
        for (const person of place.people) row(person.text, person.id, 'ghost');
        const marker = new maps.Marker({
          map, position: { lat: place.lat, lng: place.lng },
          // A circle that grows with the number of people, with the place's name just above it.
          icon: {
            path: maps.SymbolPath.CIRCLE, scale: 8 + Math.min(place.people.length, 8),
            fillColor: place.color, fillOpacity: 0.6, strokeColor: place.color, strokeWeight: 2, labelOrigin: new maps.Point(0, -1.9),
          },
          label: { text: `${place.name} (${place.people.length})`, className: 'map-label', fontSize: '14px', fontWeight: '600' },
        });
        marker.addListener('click', () => {
          popup.setContent(list);
          popup.open({ map, anchor: marker });
        });
        return marker;
      });
    }),
    lookAt: ({ lat, lng }) => whenReady(() => {
      map.panTo({ lat, lng });
      map.setZoom(Math.max(map.getZoom(), 9));
    }),
    fit: () => whenReady(() => map.fitBounds(REGION)),
    // Google's map follows the size of its box by itself.
    resize() {},
  };
}

// Places in Thailand or China matching a name, best first, from Google's look-up.
// Only the name is sent. Resolves to [{ label, lat, lng }], possibly empty.
export async function lookUp(name, lang) {
  const maps = await load(lang);
  let results;
  try {
    ({ results } = await new maps.Geocoder().geocode({ address: name, bounds: REGION, language: lang }));
  } catch (err) {
    if (err.code === 'ZERO_RESULTS') return [];
    throw new Error('Place lookup failed.');
  }
  // The look-up leans toward the region but may still answer from outside it.
  const inRegion = (found) => found.address_components.some((part) => part.types.includes('country') && COUNTRIES.includes(part.short_name));
  return results.filter(inRegion).slice(0, 5)
    .map((found) => ({ label: found.formatted_address, lat: found.geometry.location.lat(), lng: found.geometry.location.lng() }));
}
