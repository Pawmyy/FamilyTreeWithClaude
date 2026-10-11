// Name-record logic, shared by the server and the browser.
// A version is { id, fact, node, field, target, value, accepted, ... }; see README.

// The first year in a free-text date, as a Common Era year, or NaN when there is none.
// Buddhist Era years are brought onto the same scale, so 2533 and 1990 are the same year.
export function yearOf(text) {
  const year = Number(/\d{3,4}/.exec(text ?? '')?.[0]);
  return year > 2300 ? year - 543 : year;
}

const year = (version) => yearOf(version.value.from);

// One person's name versions in the order the names were carried: the birth name first,
// then by the year each began where one is given, otherwise in the order they were entered.
export function nameRecord(versions) {
  return versions
    .filter((v) => v.field === 'name')
    .sort((a, b) =>
      (b.value.reason === 'birth') - (a.value.reason === 'birth') || year(a) - year(b) || a.id - b.id);
}

export const fullName = (value) => [value?.given, value?.family].filter(Boolean).join(' ');
