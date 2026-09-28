import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ClipboardReadError, readTextClipboardWith } from "../src/clipboard"

test("reports a rejected last-resort read instead of returning nothing", async () => {
  // The defect, in the real function rather than a reimplementation of it: this used to
  // `.catch(() => undefined)`, which the paste command cannot tell from an empty clipboard, so it
  // finished having done nothing at all.
  const error = await readTextClipboardWith(() => Promise.reject(new Error("target document not focused"))).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ClipboardReadError)
})

test("returns content when the clipboard has text", async () => {
  expect(await readTextClipboardWith(() => Promise.resolve("copied text"))).toEqual({
    data: "copied text",
    mime: "text/plain",
  })
})

test("stays silent for a genuinely empty clipboard", async () => {
  // Every probe above this point already came back empty, so an empty clipboard is a normal answer and
  // must not warn. Throwing here would have replaced one bug with a more annoying one.
  expect(await readTextClipboardWith(() => Promise.resolve(""))).toBeUndefined()
})

test("names the clipboard as the thing that could not be read", () => {
  // A message that says "something went wrong" leaves the user unable to tell whether the paste
  // failed, the app failed, or the shortcut did not register. Naming the clipboard is the whole point.
  const error = new ClipboardReadError(new Error("Error: target document not focused"))
  expect(error.message).toContain("clipboard")
  expect(error.message).toContain("target document not focused")
  expect(error.name).toBe("ClipboardReadError")
})

test("does not claim the clipboard is broken", () => {
  // The usual causes are an image on the clipboard with no image probe installed, or another process
  // holding the clipboard. Telling the user their clipboard is broken sends them to debug the wrong
  // thing, so the message says what we could not do rather than what is wrong with their machine.
  const error = new ClipboardReadError(new Error("clipboardy read failed"))
  expect(error.message).not.toContain("broken")
  expect(error.message).toContain("Nothing could be read")
})

test("survives a cause that is not an Error", () => {
  // `read()` rethrows whatever the clipboard library gave it, and a thrown string must not become
  // "undefined" in the middle of a user-facing message.
  const error = new ClipboardReadError("ENOENT")
  expect(error.message).toContain("ENOENT")
  expect(error.message).not.toContain("undefined")
})

test("keeps the original failure reachable as cause", () => {
  // The toast shows the message; the console log gets the object. Dropping `cause` would lose the only
  // place the underlying errno survives.
  const original = new Error("underlying")
  expect(new ClipboardReadError(original).cause).toBe(original)
})

test("the paste command reports a failed read instead of finishing silently", () => {
  // The other half of the defect is in the caller, which used to do nothing at all when `content` came
  // back undefined. `prompt.paste` lives inside a large component, so this reads the source - the same
  // trade units 33 and 35 made.
  //
  // The window is from the read to the first content branch, so a bare `clipboard.read?.()` with no
  // handler between it and the branches still fails this.
  const source = readFileSync(join(import.meta.dir, "../src/component/prompt/index.tsx"), "utf8")
  const start = source.indexOf("clipboard.read?.()")
  expect(start).toBeGreaterThan(-1)
  const window = source.slice(start, source.indexOf('if (content?.mime === "text/plain")', start))
  expect(window).toContain("toast.show")
  expect(window).toContain("return undefined")
})
