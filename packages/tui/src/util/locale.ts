export function titlecase(str: string) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function time(input: number): string {
  const date = new Date(input)
  return date.toLocaleTimeString(undefined, { timeStyle: "short" })
}

export function datetime(input: number): string {
  const date = new Date(input)
  const localTime = time(input)
  const localDate = date.toLocaleDateString()
  return `${localTime} · ${localDate}`
}

export function todayTimeOrDateTime(input: number): string {
  const date = new Date(input)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  if (isToday) {
    return time(input)
  } else {
    return datetime(input)
  }
}

export function number(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}

export function duration(input: number) {
  if (input < 1000) {
    return `${input}ms`
  }
  if (input < 60000) {
    return `${(input / 1000).toFixed(1)}s`
  }
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  if (input < 86400000) {
    const hours = Math.floor(input / 3600000)
    const minutes = Math.floor((input % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }
  const days = Math.floor(input / 86400000)
  const hours = Math.floor((input % 86400000) / 3600000)
  return `${days}d ${hours}h`
}

const ELLIPSIS = "…"

// Callers derive these budgets from measured terminal geometry and clamp them
// with Math.max(1, ...), so 0, 1 and 2 are ordinary inputs rather than
// degenerate ones. Slicing by a negative offset is not usable here: slice(-0) is
// slice(0), so a zero-width tail silently returns the whole string. Every cut is
// therefore taken from an explicit index.

// A cut landing between the two halves of an astral character (emoji, CJK
// extension) leaves a lone surrogate that renders as a replacement glyph. A cut
// between two unrelated surrogates is harmless and is left alone.
function splitsSurrogatePair(str: string, index: number) {
  const high = str.charCodeAt(index - 1)
  const low = str.charCodeAt(index)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

function head(str: string, count: number) {
  if (count <= 0) return ""
  return str.slice(0, splitsSurrogatePair(str, count) ? count - 1 : count)
}

function tail(str: string, count: number) {
  if (count <= 0) return ""
  const start = str.length - count
  return str.slice(start > 0 && splitsSurrogatePair(str, start) ? start + 1 : start)
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str
  if (len <= 0) return ""
  return head(str, len - 1) + ELLIPSIS
}

export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  if (len <= 0) return ""
  return ELLIPSIS + tail(str, len - 1)
}

export function truncateMiddle(str: string, maxLength: number = 35): string {
  if (str.length <= maxLength) return str
  if (maxLength <= 0) return ""
  const available = maxLength - ELLIPSIS.length
  return head(str, Math.ceil(available / 2)) + ELLIPSIS + tail(str, Math.floor(available / 2))
}

export function pluralize(count: number, singular: string, plural: string): string {
  const template = count === 1 ? singular : plural
  return template.replace("{}", count.toString())
}

export * as Locale from "./locale"
