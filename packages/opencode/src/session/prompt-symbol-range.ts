/**
 * Symbol lookup for a `file://` part that carries a line selection.
 *
 * The selection arrives from the app as one-based line numbers and is handed to
 * the Read tool, whose `offset` is documented as one-based too. LSP positions
 * are zero-based, and an LSP `Range` end is exclusive, so every value crossing
 * that boundary has to be converted. Getting this wrong reads the wrong lines
 * into context, which is silent — the file still opens.
 */

export interface SymbolRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export interface SymbolLike {
  range?: SymbolRange
  location?: { range: SymbolRange }
}

function rangeOf(symbol: SymbolLike): SymbolRange | undefined {
  if (symbol.range) return symbol.range
  if (symbol.location) return symbol.location.range
  return undefined
}

/**
 * The one-based, inclusive line span a zero-based LSP range covers.
 *
 * `end` is exclusive, so a range ending at the very start of a line does not
 * include that line, while one ending mid-line does. `Math.max` keeps a
 * degenerate zero-length range from producing an end before its start.
 */
export function symbolLineRange(range: SymbolRange): { start: number; end: number } {
  const start = range.start.line + 1
  const end = range.end.line + (range.end.character > 0 ? 1 : 0)
  return { start, end: Math.max(end, start) }
}

/**
 * Widen a collapsed selection to the symbol that starts on it.
 *
 * Returns the one-based inclusive span when a symbol starts on `line`, and
 * undefined when none does — including when `symbols` is empty, so the caller
 * keeps the user's own line instead of silently reading something else.
 */
export function expandToSymbol(symbols: SymbolLike[], line: number): { start: number; end: number } | undefined {
  for (const symbol of symbols) {
    const range = rangeOf(symbol)
    if (!range) continue
    const span = symbolLineRange(range)
    if (span.start === line) return span
  }
  return undefined
}
