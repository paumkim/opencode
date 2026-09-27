export function lazy<T>(fn: () => T) {
  // A box rather than a `loaded` flag: the box is filled only after the
  // initializer returns, so a thrown initializer leaves it empty and is retried.
  // Filling it first would cache the failure as a successful `undefined`, and
  // the caller that hit the failure would see the real error while every later
  // caller saw a TypeError from wherever it first dereferenced the missing
  // value, with the cause gone and no way to recover. The box identity is also
  // why an initializer that legitimately returns undefined still caches.
  let cache: { value: T } | undefined

  return (): T => {
    if (cache) return cache.value
    cache = { value: fn() }
    return cache.value
  }
}
