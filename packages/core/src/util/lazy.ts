export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  // `loaded` flips only after the initializer returns. Flipping it first would
  // cache a thrown initializer as a successful `undefined`: the caller that hit
  // the failure would see the real error, and every later caller would see a
  // TypeError from wherever it first dereferenced the missing value, with the
  // cause gone and no way to retry.
  return (): T => {
    if (loaded) return value as T
    value = fn()
    loaded = true
    return value
  }
}
