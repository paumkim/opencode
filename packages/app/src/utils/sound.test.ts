import { describe, expect, test } from "bun:test"
import { soundLoader } from "./sound"

// The load table was built with `Object.fromEntries` and guarded with `in`,
// which walks the prototype chain. A sound id is a persisted settings string
// with no validation, so a hand-edited or migrated value named after an
// Object.prototype member passed the guard and then the code called the
// inherited function, throwing synchronously and taking down the caller
// instead of playing no sound.
//
// The table is passed in rather than built here: the real one comes from
// `import.meta.glob`, which is a Vite transform and undefined under Bun. The
// guard is the behaviour under test.
const table = {
  "alert-01": () => Promise.resolve("/audio/alert-01.aac"),
  "yup-01": () => Promise.resolve("/audio/yup-01.aac"),
}

const PROTOTYPE_KEYS = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "__defineGetter__",
  "__lookupGetter__",
]

describe("soundLoader", () => {
  for (const key of PROTOTYPE_KEYS) {
    test(`returns undefined for ${key} instead of an inherited member`, () => {
      expect(soundLoader(key, table)).toBeUndefined()
    })
  }

  test("returns the loader for a known id", () => {
    const load = soundLoader("alert-01", table)
    expect(typeof load).toBe("function")
    expect(load?.()).toBeInstanceOf(Promise)
  })

  test("returns undefined for an unknown id", () => {
    expect(soundLoader("definitely-not-a-sound", table)).toBeUndefined()
  })

  test("returns undefined for an empty or missing id", () => {
    expect(soundLoader("", table)).toBeUndefined()
    expect(soundLoader(undefined, table)).toBeUndefined()
  })

  test("an empty table resolves nothing, including for a known-looking id", () => {
    expect(soundLoader("alert-01", {})).toBeUndefined()
    expect(soundLoader("constructor", {})).toBeUndefined()
  })
})
