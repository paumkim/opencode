import path from "path"
import { appendFile, mkdir, rename, rm } from "fs/promises"

export function readText(filePath: string) {
  return Bun.file(filePath).text()
}

export function readJson<T>(filePath: string) {
  return Bun.file(filePath).json() as Promise<T>
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, content)
}

/**
 * Writes text by way of a temporary file and a rename, so the destination is either the old
 * contents or the new ones and never a truncated mixture.
 *
 * `writeText` cannot make that promise: `Bun.write` truncates the target first, so a failure part
 * way through - disk full, a revoked directory - leaves whatever was already there destroyed. For
 * an append-only user store like the prompt stash, whose previous entries are the only copy of the
 * user's own work, replacing all of them with a partial write is the worst available outcome.
 *
 * Failures propagate, as `writeJsonAtomic` already does, and the temporary file is removed on both
 * paths so a failed write leaves nothing behind in the state directory.
 */
export async function writeTextAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, content).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await rename(temporary, filePath).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, JSON.stringify(value)).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await rename(temporary, filePath).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}
