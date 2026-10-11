// The fuzzy finder: type a few letters, pick from the best matches.
// Items are { id, label, detail, keys }, where keys are every string the item can be found by.

const normalize = (text) => text.normalize('NFC').toLowerCase();

// Higher is better; -1 means no match. Text containing the query beats letters merely appearing in order.
export function fuzzyScore(query, text) {
  const q = normalize(query);
  const s = normalize(text);
  if (!q) return 0;
  const at = s.indexOf(q);
  if (at >= 0) return 1000 - at - (s.length - q.length) * 0.01;
  let position = 0;
  let gaps = 0;
  for (const letter of q) {
    const next = s.indexOf(letter, position);
    if (next < 0) return -1;
    gaps += next - position;
    position = next + 1;
  }
  return 500 - gaps;
}

export function rank(query, items, limit = 8) {
  return items
    .map((item) => ({ item, score: Math.max(...item.keys.map((key) => fuzzyScore(query, key))) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map(({ item }) => item);
}

// Turns an empty element into a search box with a list of matches under it.
// `search(query)` may be async, so the matches can later come from the server instead of the page.
// `onPick(item)` is called with the chosen item, or null when the box is cleared.
export function createFinder(root, { search, onPick }) {
  const input = Object.assign(document.createElement('input'), { type: 'text', autocomplete: 'off' });
  input.setAttribute('role', 'combobox');
  const list = Object.assign(document.createElement('ul'), { className: 'finder-list', hidden: true });
  list.setAttribute('role', 'listbox');
  root.append(input, list);

  let picked = null;
  let options = [];
  let active = 0;

  function render() {
    list.replaceChildren(...options.map((item, i) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.className = i === active ? 'active' : '';
      row.append(item.label, Object.assign(document.createElement('small'), { textContent: item.detail ?? '' }));
      // mousedown, not click: it fires before the input loses focus.
      row.onmousedown = (evt) => {
        evt.preventDefault();
        choose(item);
      };
      return row;
    }));
    list.hidden = !options.length;
  }

  async function update() {
    options = await search(input.value);
    active = 0;
    render();
  }

  function choose(item) {
    picked = item;
    input.value = item?.label ?? '';
    list.hidden = true;
    onPick?.(item);
  }

  input.oninput = () => {
    if (picked) {
      picked = null;
      onPick?.(null);
    }
    update();
  };
  input.onfocus = update;
  input.onblur = () => {
    list.hidden = true;
    // Text that was never picked from the list means nothing, so do not leave it looking chosen.
    if (!picked) input.value = '';
  };
  input.onkeydown = (evt) => {
    if (list.hidden) return;
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      active = (active + (evt.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
      render();
    } else if (evt.key === 'Enter') {
      choose(options[active]);
    } else if (evt.key === 'Escape') {
      list.hidden = true;
    } else {
      return;
    }
    evt.preventDefault();
  };

  return {
    input,
    get value() { return picked?.id ?? null; },
    // Show an item as chosen (or nothing) without announcing it through onPick.
    set(item) {
      picked = item;
      input.value = item?.label ?? '';
    },
  };
}
