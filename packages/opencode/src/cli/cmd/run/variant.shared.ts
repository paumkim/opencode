// Model variant resolution and persistence.
//
// Variants are provider-specific reasoning effort levels (e.g., "high", "max").
// Resolution priority: CLI --variant flag > saved preference > session history.
//
// The saved variant persists across sessions in ~/.local/state/opencode/model.json
// so your last-used variant sticks. Cycling (ctrl+t) updates both the active
// variant and the persisted file.
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Context, Effect, Layer, Schema } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Global } from "@opencode-ai/core/global"
import { isRecord } from "@/util/record"
import { describeReadFailure } from "@/util/filesystem"
import { createSession, sessionVariant, type RunSession, type SessionMessages } from "./session.shared"
import type { RunInput, RunProvider } from "./types"

const MODEL_FILE = path.join(Global.Path.state, "model.json")

type ModelState = Record<string, unknown> & {
  variant?: Record<string, string | undefined>
}
type VariantService = {
  readonly resolveSavedVariant: (model: RunInput["model"]) => Effect.Effect<string | undefined, ModelStateUnreadable>
  /**
   * The error channel is deliberate. This used to be `Effect<void>`, which the implementation only
   * satisfied by swallowing every failure with `orElseSucceed` - including the read failure that made
   * the write destructive. A save that could destroy the file has to be able to fail, so the type
   * says so.
   */
  readonly saveVariant: (
    model: RunInput["model"],
    variant: string | undefined,
  ) => Effect.Effect<void, ModelStateUnreadable | Error>
}
type VariantRuntime = {
  resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined>
  saveVariant(model: RunInput["model"], variant: string | undefined): Promise<void>
}

class Service extends Context.Service<Service, VariantService>()("@opencode/RunVariant") {}

/**
 * The model state file exists but could not be read, so writing would destroy its contents.
 *
 * The message says what refusing protects, because "EACCES" alone does not tell a reader why saving
 * a variant was refused.
 */
export class ModelStateUnreadable extends Schema.TaggedErrorClass<ModelStateUnreadable>()("RunVariantUnreadable", {
  file: Schema.String,
  message: Schema.String,
}) {}

/**
 * Builds the refusal, with the consequence spelled out rather than left for the reader to infer.
 */
export function modelStateUnreadable(file: string, cause: unknown) {
  return new ModelStateUnreadable({
    file,
    message: `Could not read ${file} to save the model variant, so nothing was written. Refusing to continue, because writing would replace the file with a partial one and permanently lose the recently-used models and favourites it holds. Cause: ${describeReadFailure(cause)}`,
  })
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function variantKey(model: NonNullable<RunInput["model"]>): string {
  return modelKey(model.providerID, model.modelID)
}

export function modelInfo(providers: RunProvider[] | undefined, model: NonNullable<RunInput["model"]>) {
  const provider = providers?.find((item) => item.id === model.providerID)
  return {
    provider: provider?.name ?? model.providerID,
    model: provider?.models[model.modelID]?.name ?? model.modelID,
  }
}

export function formatModelLabel(
  model: NonNullable<RunInput["model"]>,
  variant: string | undefined,
  providers?: RunProvider[],
): string {
  const names = modelInfo(providers, model)
  const label = variant ? ` · ${variant}` : ""
  return `${names.model} · ${names.provider}${label}`
}

export function cycleVariant(current: string | undefined, variants: string[]): string | undefined {
  if (variants.length === 0) {
    return undefined
  }

  if (!current) {
    return variants[0]
  }

  const idx = variants.indexOf(current)
  if (idx === -1 || idx === variants.length - 1) {
    return undefined
  }

  return variants[idx + 1]
}

export function pickVariant(model: RunInput["model"], input: RunSession | SessionMessages): string | undefined {
  return sessionVariant(Array.isArray(input) ? createSession(input) : input, model)
}

function fitVariant(value: string | undefined, variants: string[]): string | undefined {
  if (!value) {
    return undefined
  }

  if (variants.length === 0 || variants.includes(value)) {
    return value
  }

  return undefined
}

// Picks the active variant. CLI flag wins, then saved preference, then session
// history. fitVariant() checks saved and session values against the available
// variants list -- if the provider doesn't offer a variant, it drops.
export function resolveVariant(
  input: string | undefined,
  session: string | undefined,
  saved: string | undefined,
  variants: string[],
): string | undefined {
  if (input !== undefined) {
    return input
  }

  const fallback = fitVariant(saved, variants)
  const current = fitVariant(session, variants)
  if (current !== undefined) {
    return current
  }

  return fallback
}

function state(value: unknown): ModelState {
  if (!isRecord(value)) {
    return {}
  }

  const variant = isRecord(value.variant)
    ? Object.fromEntries(
        Object.entries(value.variant).flatMap(([key, item]) => {
          if (typeof item !== "string") {
            return []
          }

          return [[key, item] as const]
        }),
      )
    : undefined

  return {
    ...value,
    variant,
  }
}

function createLayer(fs = AppNodeBuilder.build(FSUtil.node)) {
  return Layer.fresh(
    Layer.effect(
      Service,
      Effect.gen(function* () {
        const file = yield* FSUtil.Service

        // A read that fails is NOT an empty store. `model.json` is shared with the TUI, which writes
        // three keys into it - `recent`, `favorite` and `variant` - and `saveVariant` below writes the
        // object it read straight back. So the old `catchCause(() => state(undefined))` turned any
        // transient read failure into a write of `{ variant: ... }`, silently discarding the user's
        // entire recently-used model list and every favourite. Those are not cosmetic: `recent` is the
        // last fallback in `subagent-failover`'s model chain and `defaultModel` reads it too.
        //
        // ENOENT is the genuine first run and stays forgiving; anything else refuses, because the next
        // write would destroy what it could not read.
        const read = Effect.fn("RunVariant.read")(function* () {
          return yield* file.readJson(MODEL_FILE).pipe(
            Effect.map(state),
            // `catchReason` rather than inspecting the error: `FSUtil` surfaces a `PlatformError`
            // whose "not found" is a reason, not a `code` property, and `fs-util.ts` uses this exact
            // call to tell NotFound from PermissionDenied. A hand-rolled `error.code === "ENOENT"`
            // check is never true on this path, which would have made a genuine first run refuse and
            // impossible it would be to ever save the first variant.
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(state(undefined))),
            // A file that parses to nothing usable is CORRUPT, not unreadable - and a corrupt file
            // holds no recoverable data, so writing over it destroys nothing that still exists. The
            // existing behaviour of repairing it on the next write is right and is kept: a
            // half-written file from a killed process would otherwise disable variant persistence
            // permanently. Only a read that failed while the file was intact refuses, because that
            // is the case where the contents are real and unread, and overwriting them loses them.
            //
            // `Schema.ParseError` and `SyntaxError` are the JSON failures; a `FileSystemError`
            // carrying a parse message is the same thing after the error passes through the service.
            Effect.catch((error) =>
              isUnparsable(error)
                ? Effect.succeed(state(undefined))
                : Effect.fail(modelStateUnreadable(MODEL_FILE, error)),
            ),
          )
        })

        const resolveSavedVariant = Effect.fn("RunVariant.resolveSavedVariant")(function* (model: RunInput["model"]) {
          if (!model) {
            return undefined
          }

          // Tolerant on purpose, and unlike `saveVariant`: nothing is written after this read, so a
          // failure costs a default and no data. The caller gets the agent's default variant, which
          // is what it would have used anyway.
          const current = yield* read().pipe(Effect.catchCause(() => Effect.succeed(state(undefined))))
          return current.variant?.[variantKey(model)]
        })

        const saveVariant = Effect.fn("RunVariant.saveVariant")(function* (
          model: RunInput["model"],
          variant: string | undefined,
        ) {
          if (!model) {
            return
          }

          const current = yield* read()
          const next = {
            ...current.variant,
          }
          const key = variantKey(model)
          if (variant) {
            next[key] = variant
          }

          if (!variant) {
            delete next[key]
          }

          yield* file.writeJson(MODEL_FILE, {
            ...current,
            variant: next,
          })
        })

        return Service.of({
          resolveSavedVariant,
          saveVariant,
        })
      }),
    ).pipe(Layer.provide(fs)),
  )
}

/** @internal Exported for testing. */
export function createVariantRuntime(fs = AppNodeBuilder.build(FSUtil.node)): VariantRuntime {
  const runtime = makeRuntime(Service, createLayer(fs))
  return {
    resolveSavedVariant: (model) => runtime.runPromise((svc) => svc.resolveSavedVariant(model)).catch(() => undefined),
    // Not swallowed. The old `.catch(() => {})` here undid the refusal one layer up: `runPromise`
    // rejects when the save refuses, and catching it meant the caller was told the variant was saved
    // while the file on disk still held the old value - or, before the refusal existed, had been
    // overwritten with a partial store. A caller that has a notice to show (see `runtime.ts`) now has
    // something to show.
    saveVariant: (model, variant) => runtime.runPromise((svc) => svc.saveVariant(model, variant)),
  }
}

const runtime = createVariantRuntime()

export async function resolveSavedVariant(model: RunInput["model"]): Promise<string | undefined> {
  return runtime.resolveSavedVariant(model)
}

/**
 * Saves the selected variant, returning why it could not be saved rather than discarding the reason.
 *
 * The caller's decision is its own: `runtime.ts` turns a refusal into a footer notice, because the
 * user's selection did take effect for this turn even if it will not be remembered next time, and
 * saying so is more useful than pretending either way.
 */
export function saveVariant(model: RunInput["model"], variant: string | undefined): Promise<void> {
  return runtime.saveVariant(model, variant)
}

/**
 * True when the failure was the file's CONTENT rather than the file itself.
 *
 * Distinguishing these two is the whole design here, and getting it backwards is destructive in both
 * directions: refuse on a parse error and a corrupt file disables the feature forever, since every
 * future write also fails to read it. Accept a permission error and real, intact data is overwritten.
 */
function isUnparsable(error: unknown) {
  // Probed rather than assumed: a `SyntaxError` reaches here wrapped in a `PlatformError`, so
  // `error instanceof SyntaxError` and `error.name` are both false. The original error is at
  // `cause` (and again at `reason.cause`), and the whole question is whether the FILE was unreadable
  // or its CONTENTS were bad - so the walk is the point, not the top-level type.
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    if (candidate instanceof SyntaxError) return true
    if (typeof candidate !== "object" || candidate === null) continue
    const name = (candidate as { name?: unknown }).name
    if (name === "SyntaxError" || name === "ParseError" || name === "SchemaParseError") return true
  }
  const message = (error as { message?: unknown }).message
  return typeof message === "string" && /JSON Parse error|Unexpected token|is not valid JSON/i.test(message)
}
