// The map view: places on a real map, and looking a place up by its name.
// For now the map is held to Thailand.
import L from 'https://esm.sh/leaflet@1.9.4';

const THAILAND = L.latLngBounds([5.6, 97.3], [20.5, 105.7]);

// `onClick({ lat, lng })` is called for a click on the map itself.
export function createMap(container, { onClick }) {
  const map = L.map(container, { maxBounds: THAILAND.pad(0.3), maxBoundsViscosity: 1, minZoom: 5, zoomControl: false }).fitBounds(THAILAND);
  // The page's own bar sits along the top, so the zoom buttons go at the bottom.
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markers = L.layerGroup().addTo(map);
  map.on('click', (evt) => onClick({ lat: evt.latlng.lat, lng: evt.latlng.lng }));

  return {
    // places: [{ id, name, lat, lng, color, people: [{ id, text }] }]. A marker opens a list of its people;
    // `onOpen(id)` is called when the place or one of the people is chosen from it.
    show(places, onOpen) {
      markers.clearLayers();
      for (const place of places) {
        const list = document.createElement('div');
        list.className = 'map-popup';
        const row = (text, id, tag) => {
          const button = Object.assign(document.createElement('button'), { textContent: text, className: tag });
          button.onclick = () => onOpen(id);
          list.append(button);
        };
        row(place.name, place.id, 'place');
        for (const person of place.people) row(person.text, person.id, 'ghost');
        L.circleMarker([place.lat, place.lng], { radius: 8 + Math.min(place.people.length, 8), color: place.color, fillOpacity: 0.6 })
          .bindTooltip(`${place.name} (${place.people.length})`, { permanent: true, direction: 'top', offset: [0, -8] })
          .bindPopup(list)
          .addTo(markers);
      }
    },
    lookAt: ({ lat, lng }) => map.setView([lat, lng], Math.max(map.getZoom(), 9)),
    fit: () => map.fitBounds(THAILAND),
    // Leaflet has to be told when its box changes size or becomes visible.
    resize: () => map.invalidateSize(),
  };
}

// Places in Thailand matching a name, best first, from OpenStreetMap's public search.
// Only the name is sent. Resolves to [{ label, lat, lng }], possibly empty.
export async function lookUp(name, lang) {
  const query = new URLSearchParams({ format: 'jsonv2', countrycodes: 'th', limit: 5, 'accept-language': lang, q: name });
  const res = await fetch('https://nominatim.openstreetmap.org/search?' + query);
  if (!res.ok) throw new Error('Place lookup failed.');
  return (await res.json()).map((found) => ({ label: found.display_name, lat: Number(found.lat), lng: Number(found.lon) }));
}
