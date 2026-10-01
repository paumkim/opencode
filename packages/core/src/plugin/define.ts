import type { PluginContext } from "@opencode-ai/plugin/v2/effect"
import type { Effect, Scope } from "effect"

/**
 * The plugin shape, and the identity helper every provider module uses to declare one.
 *
 * This lives apart from `./internal` on purpose. `./internal` imports `ProviderPlugins` from
 * `./provider`, and every provider module needs `define` from here -- so a provider module reaching
 * back into `./internal` closes a cycle: entering one provider first makes `./internal` evaluate,
 * which evaluates `./provider`, which finds that first provider's binding still in its temporal dead
 * zone and throws `Cannot access '<Plugin>' before initialization`. Three provider tests hit exactly
 * that. Keeping this file import-free at runtime means a provider module never has to touch
 * `./internal` to declare itself.
 */
export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}
