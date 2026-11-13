// Identify alias descriptors through guard/reactivity proxies without storing
// serializable metadata on models or keeping instances alive.
const sources = new WeakMap<() => unknown, string>()
const owns = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

/**
 * Apply server attributes while keeping unambiguous declared relation aliases
 * coherent. Canonical own keys win conflicts for both views, including null.
 * Missing relations retain their value. The first received wire keys remain
 * enumerable; aliases never add keys to the existing save() spread payload.
 */
export function applyModelAttributes(
  target: Record<string, unknown>,
  attributes: Record<string, unknown>,
  relations: string[],
): void {
  const ordinary = { ...attributes }
  // Matches Laravel's Str::snake for relation identifiers, including acronyms.
  const snake = (name: string) => name.replace(/(.)(?=[A-Z])/g, '$1_').toLowerCase()
  const aliases = relations.map(snake)
  for (const name of relations) {
    const serialized = snake(name)
    // Ambiguous declarations own their separate names; never conflate them.
    if (serialized === name || relations.includes(serialized) || aliases.filter(key => key === serialized).length !== 1 ||
        (!owns(attributes, name) && !owns(attributes, serialized))) continue

    const value = owns(attributes, name) ? attributes[name] : attributes[serialized]
    const getters = [name, serialized].map(key => Object.getOwnPropertyDescriptor(target, key)?.get)
    const existing = getters.map(get => get ? sources.get(get) : undefined).find(key => key !== undefined)
    if (existing !== undefined) {
      // Write through the target, not hidden state, so reactive proxies observe it.
      target[existing] = value
    } else {
      const source = owns(attributes, name) ? name : serialized
      const alias = source === name ? serialized : name
      // Normal assignment preserves notifications for newly returned canonical fields.
      target[source] = value
      const get = function (this: Record<string, unknown>) { return this[source] }
      const set = function (this: Record<string, unknown>, next: unknown) { this[source] = next }
      sources.set(get, source)
      Object.defineProperty(target, alias, {
        configurable: true,
        enumerable: owns(target, alias) ? Object.prototype.propertyIsEnumerable.call(target, alias) : owns(attributes, alias),
        get,
        set,
      })
    }
    delete ordinary[name]
    delete ordinary[serialized]
  }
  Object.assign(target, ordinary)
}
