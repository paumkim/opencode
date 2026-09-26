export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ""
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  if (!trimmed) return "/"
  const parts = trimmed.split(/[/\\]/)
  // A bare relative name has no directory component. Returning "/" here would
  // render a filesystem root next to a file that sits in the current directory.
  if (parts.length === 1) return ""
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

export function getFileExtension(path: string | undefined) {
  if (!path) return ""
  // Measured on the basename so a dot in a parent directory cannot be mistaken
  // for the extension, and a leading dot is part of the name rather than one.
  const filename = getFilename(path)
  const dot = filename.lastIndexOf(".")
  if (dot <= 0) return ""
  return filename.slice(dot + 1)
}

export function getFilenameTruncated(path: string | undefined, maxLength: number = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  if (maxLength <= 0) return ""
  const lastDot = filename.lastIndexOf(".")
  const ext = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - ext.length - 1 // -1 for ellipsis
  if (available <= 0) return filename.slice(0, maxLength - 1) + "…"
  return filename.slice(0, available) + "…" + ext
}
