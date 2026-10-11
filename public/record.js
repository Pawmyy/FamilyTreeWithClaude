// Name-record logic, shared by the server and the browser.
// A version is { id, fact, node, field, target, value, accepted, ... }; see README.

const year = (version) => Number(/\d{3,4}/.exec(version.value.from ?? '')?.[0] ?? NaN);

// One person's name versions in the order the names were carried: the birth name first,
// then by the year each began where one is given, otherwise in the order they were entered.
export function nameRecord(versions) {
  return versions
    .filter((v) => v.field === 'name')
    .sort((a, b) =>
      (b.value.reason === 'birth') - (a.value.reason === 'birth') || year(a) - year(b) || a.id - b.id);
}

export const fullName = (value) => [value?.given, value?.family].filter(Boolean).join(' ');
