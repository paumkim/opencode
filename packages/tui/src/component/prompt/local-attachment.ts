import { readFile } from "node:fs/promises"
import path from "node:path"

export type LocalFiles = Readonly<{
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

/**
 * The file is an attachment type, but reading it failed.
 *
 * This is deliberately NOT an `undefined` return. `undefined` means "this file is not something we can
 * attach", which is a normal outcome - pasting `notes.txt` should insert the path as text. A file that
 * IS an image or PDF but could not be read is a different event: the user asked to attach a specific
 * file, and collapsing the two into the same value is what let a failed read fall through to inserting
 * the path as literal text, so the agent answered as though no image had ever been attached.
 */
export class LocalAttachmentUnreadableError extends Error {
  override readonly name = "LocalAttachmentUnreadableError"
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    // The reason is included because "EACCES" and "ENOENT" call for different user action, and neither
    // is inferable from the fact that the attachment failed.
    super(`Could not read ${file}: ${reason(cause)}`, { cause })
  }
}

function reason(cause: unknown) {
  const code = (cause as { code?: unknown } | undefined)?.code
  if (typeof code === "string" && code === "ENOENT") return "no such file"
  if (cause instanceof Error && cause.message) return cause.message
  return String(cause)
}

export function readLocalAttachment(file: string) {
  return readLocalAttachmentWith(
    {
      readText: (value) => readFile(value, "utf8"),
      readBytes: (value) => readFile(value),
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

/**
 * Reads a pasted or dropped file as an attachment.
 *
 * Returns `undefined` for a file that is not an attachment type. Throws
 * `LocalAttachmentUnreadableError` for one that is, because the caller has to be able to tell "you
 * pasted something I cannot attach" from "I tried and failed".
 */
export async function readLocalAttachmentWith(files: LocalFiles, path: string): Promise<LocalAttachment | undefined> {
  // The mime lookup is a table read, not I/O, so a failure here is not a filesystem problem worth
  // confusing the user with. The two reads below are the ones that can fail on a real file.
  const mime = await files.mime(path).catch(() => undefined)
  if (!mime) return
  if (mime === "image/svg+xml") {
    const content = await files.readText(path).catch((error) => {
      throw new LocalAttachmentUnreadableError(path, error)
    })
    if (!content) return
    return { type: "text", mime, content }
  }
  if (!mime.startsWith("image/") && mime !== "application/pdf") return
  const content = await files.readBytes(path).catch((error) => {
    throw new LocalAttachmentUnreadableError(path, error)
  })
  if (!content) return
  return { type: "binary", mime, content }
}
