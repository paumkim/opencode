export * as DoctorRender from "./render"

import { Doctor } from "./doctor"
import { UI } from "@/cli/ui"

const GLYPH: Record<Doctor.Severity, string> = {
  error: "✖",
  warn: "▲",
  info: "•",
  ok: "✔",
}

const COLOR: Record<Doctor.Severity, string> = {
  error: UI.Style.TEXT_DANGER_BOLD,
  warn: UI.Style.TEXT_WARNING_BOLD,
  info: UI.Style.TEXT_INFO_BOLD,
  ok: UI.Style.TEXT_SUCCESS,
}

export interface RenderOptions {
  /** Render without ANSI escapes, for pipes and snapshot tests. */
  readonly plain?: boolean
  /** Drop `info` and `ok` findings, leaving only what needs attention. */
  readonly brief?: boolean
}

const paint = (text: string, code: string, plain: boolean | undefined) =>
  plain ? text : code + text + UI.Style.TEXT_NORMAL

/** Indents every line of a multi-line detail so nested output stays under its finding. */
const block = (text: string, indent: string) =>
  text
    .split("\n")
    .map((line) => indent + line)
    .join("\n")

export function filter(findings: readonly Doctor.Finding[], options: RenderOptions = {}): Doctor.Finding[] {
  if (!options.brief) return [...findings]
  return findings.filter((item) => item.severity === "error" || item.severity === "warn")
}

export function renderText(findings: readonly Doctor.Finding[], options: RenderOptions = {}): string {
  const lines: string[] = []
  for (const item of filter(findings, options)) {
    lines.push(
      `${paint(GLYPH[item.severity], COLOR[item.severity], options.plain)} ${paint(
        `[${item.severity}]`,
        COLOR[item.severity],
        options.plain,
      )} ${item.title}`,
    )
    if (item.detail) lines.push(block(paint(item.detail, UI.Style.TEXT_DIM, options.plain), "    "))
    if (item.hint) lines.push(block(paint(`→ ${item.hint}`, UI.Style.TEXT_INFO, options.plain), "    "))
  }

  const counts = Doctor.summarize(filter(findings, options))
  const tally = (["error", "warn", "info", "ok"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}${counts[severity] === 1 ? "" : "s"}`)
    .join(", ")

  if (options.brief && counts.error === 0 && counts.warn === 0) {
    lines.push(paint("No problems found.", UI.Style.TEXT_SUCCESS, options.plain))
  } else if (tally) {
    lines.push("")
    lines.push(tally)
  }

  return lines.join("\n")
}

export function renderJSON(findings: readonly Doctor.Finding[], options: RenderOptions = {}): string {
  const kept = filter(findings, options)
  return JSON.stringify({ summary: Doctor.summarize(kept), findings: kept }, null, 2)
}
