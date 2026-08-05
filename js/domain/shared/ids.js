let nextId = 1;

export function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;
}
