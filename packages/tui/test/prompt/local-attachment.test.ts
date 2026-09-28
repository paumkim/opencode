import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readLocalAttachmentWith, LocalAttachmentUnreadableError } from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: async () => input.mime,
    readText: async () => input.text ?? "",
    readBytes: async () => input.bytes ?? new Uint8Array(),
  }
}

describe("prompt local attachments", () => {
  test("reads SVG attachments as text", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test("ignores a file that is not an attachment type", async () => {
    // Normal and expected: pasting `notes.txt` should insert the path as text, not warn about anything.
    expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
  })

  test("throws when an image cannot be read, rather than reporting it as unsupported", async () => {
    // The defect. This used to return `undefined`, which is the same value as "unsupported type", so the
    // caller pasted the path as text and the agent answered as though no image had been attached.
    const error = await readLocalAttachmentWith(
      {
        ...files({ mime: "image/png" }),
        readBytes: async () => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
      },
      "/tmp/secret.png",
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(LocalAttachmentUnreadableError)
    expect((error as Error).message).toContain("/tmp/secret.png")
    // The reason decides what the user does next, and it is not inferable from the failure itself.
    // This asserts the human-readable reason rather than the errno: unlike the server-side messages
    // that go into logs, this one is shown in a toast, and "permission denied" is what a user can act
    // on where "EACCES" is not.
    expect((error as Error).message).toContain("permission denied")
  })

  test("throws when an SVG cannot be read", async () => {
    // The text branch took the same catch and the same decision as the byte branch; both have to report.
    const error = await readLocalAttachmentWith(
      {
        ...files({ mime: "image/svg+xml" }),
        readText: async () => Promise.reject(new Error("EISDIR: illegal operation on a directory")),
      },
      "/tmp/image.svg",
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(LocalAttachmentUnreadableError)
    expect((error as Error).message).toContain("EISDIR")
  })

  test("distinguishes a missing file from a permission failure", async () => {
    // ENOENT is the common case - a stale drag-and-drop, or a path that was never a file - and the
    // message says so in words rather than leaving the user to decode a Node errno.
    const error = await readLocalAttachmentWith(
      {
        ...files({ mime: "image/png" }),
        readBytes: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
      },
      "/tmp/gone.png",
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect((error as Error).message).toContain("no such file")
    expect((error as Error).message).not.toContain("ENOENT")
  })

  test("the prompt reports an unreadable attachment instead of silently pasting the path", () => {
    // `readLocalAttachmentWith` is a pure decision and proving it does not prove the caller reacts to
    // it. `pasteInputText` is buried in a 1800-line component, so this reads the source instead - the
    // same trade unit 33 made for the local.tsx stores, and for the same reason.
    //
    // The window asserted is from the read to the fall-through, which is what makes this a wiring check
    // rather than a count of a symbol name: a bare `readLocalAttachment(filepath)` with no handler in
    // between would still contain every name checked here.
    const source = readFileSync(join(import.meta.dir, "../../src/component/prompt/index.tsx"), "utf8")
    const start = source.indexOf("readLocalAttachment(filepath)")
    expect(start).toBeGreaterThan(-1)
    const window = source.slice(start, source.indexOf("const lineCount", start))
    // Reports to the user.
    expect(window).toContain("LocalAttachmentUnreadableError")
    expect(window).toContain("toast.show")
    // And keeps the text, so a failed read costs the attachment rather than the whole paste.
    expect(window).toContain("return undefined")
  })

  test("an empty read is still treated as no attachment, not as a failure", async () => {
    // A zero-byte SVG legitimately has no content to inline. That is not an error and must not warn.
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "" }), "/tmp/empty.svg")).toBeUndefined()
  })
})
