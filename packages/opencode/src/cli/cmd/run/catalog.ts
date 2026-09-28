/**
 * Catalog reads: agents, resources and commands for the `opencode run` TUI.
 *
 * Both helpers exist because a read that failed and a read that returned
 * nothing are different facts, and collapsing them is a lie the UI then repeats.
 * These are kept in their own module so `runtime.ts` and `footer.ts` can both
 * use them without importing each other.
 */

/**
 * Maps a catalog read to a list, or to `undefined` when the read failed.
 *
 * The generated SDK client resolves typed HTTP failures into `.error` rather
 * than rejecting, so `error` is the branch a 404, 500 or timeout actually
 * takes — a `.catch` alone would not have seen any of them.
 */
export function readCatalogList<T>(result: { data?: T; error?: unknown } | undefined, fallback: T): T | undefined {
  if (!result || result.error) return undefined
  return result.data ?? fallback
}

/**
 * Keeps the footer showing what it already has when a catalog read failed.
 *
 * A list is only replaced when the read actually produced one, so a transient
 * error cannot empty the agent picker, the `@` resources or the `/` commands
 * — including the user's installed skills — while a genuinely empty catalog
 * still clears them.
 */
export function mergeCatalogList<T>(previous: T, next: T | undefined): T {
  return next ?? previous
}
