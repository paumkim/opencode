import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Skill } from "../../src/skill"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = LayerNode.compile(CrossSpawnSpawner.node)
const it = testEffect(Layer.mergeAll(LayerNode.compile(Skill.node), node, testInstanceStoreLayer))

// The skill table was a bare object literal, so a name that collides with an
// Object.prototype member resolved to the inherited value instead of "no such
// skill". `Skill.require` guarded with a truthiness check, so the inherited
// function SKIPPED the typed not-found error and the skill tool then died on
// `path.dirname(Object.location)`. Names come from SKILL.md frontmatter.
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "__defineGetter__"]

async function writeSkill(root: string, name: string) {
  const dir = path.join(root, ".opencode", "skill", name)
  await fs.mkdir(dir, { recursive: true })
  await Bun.write(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: A skill named after an Object.prototype member.
---

# ${name}

body
`,
  )
}

describe("skill names that collide with Object.prototype", () => {
  for (const name of PROTOTYPE_KEYS) {
    it.instance(
      `${name} is not found when no such skill exists`,
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          // The guard is what the skill tool depends on: it turns an unknown
          // name into a typed error it can report, instead of an inherited
          // value it crashes on.
          const error = yield* Effect.flip(skill.require(name))
          expect(error).toBeInstanceOf(Skill.NotFoundError)
          expect(error.name).toBe(name)
        }),
      { git: true },
    )
  }

  for (const name of PROTOTYPE_KEYS) {
    it.instance(
      `${name} loads as a real skill when it exists on disk`,
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const info = yield* skill.require(name)
          expect(info.name).toBe(name)
          expect(typeof info).toBe("object")
          // The skill tool reads this and calls path.dirname on it.
          expect(typeof info.location).toBe("string")
          expect(info.content).toContain(name)
          expect(path.dirname(info.location)).toContain(name)
        }),
      { git: true, init: (dir) => Effect.promise(() => writeSkill(dir, name)) },
    )
  }

  it.instance(
    "a prototype-named skill is discovered exactly once",
    () =>
      Effect.gen(function* () {
        const skill = yield* Skill.Service
        const found = (yield* skill.all()).filter((s) => s.name === "constructor")
        expect(found).toHaveLength(1)
        // The duplicate warning used to read the inherited Object.location,
        // which is undefined, so a first-time skill logged a bogus warning.
        expect(found[0].location).toContain("constructor")
      }),
    { git: true, init: (dir) => Effect.promise(() => writeSkill(dir, "constructor")) },
  )
})
