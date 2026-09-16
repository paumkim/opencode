// Session Self-Watcher
// TF-IDF + Logistic Regression classifier for session stall detection.
// Pure TypeScript — zero runtime deps. Embedded in the session processor.

import modelData from "./model.json" with { type: "json" }

interface ModelData {
  vocab: Record<string, number>
  idf: number[]
  coef: number[][]
  intercept: number[]
  classes: string[]
}

const model = modelData as unknown as ModelData

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 0)
}

function getNgrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "))
  }
  return ngrams
}

function transformTFIDF(text: string): number[] {
  const tokens = tokenize(text)
  const features: string[] = []
  for (const n of [1, 2]) features.push(...getNgrams(tokens, n))

  const tf: Record<string, number> = {}
  for (const f of features) tf[f] = (tf[f] || 0) + 1

  const vec: number[] = new Array(model.idf.length).fill(0)
  for (const [term, count] of Object.entries(tf)) {
    const idx = model.vocab[term]
    if (idx !== undefined) vec[idx] = 1 + Math.log(count)
  }

  for (let i = 0; i < vec.length; i++) {
    if (vec[i] > 0) vec[i] *= model.idf[i]
  }

  return vec
}

function softmax(scores: number[]): number[] {
  const maxScore = Math.max(...scores)
  const exps = scores.map((s) => Math.exp(s - maxScore))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

/**
 * Classify a process summary as RUNNING, STALLED, or UNKNOWN.
 */
export function check(summary: string): "RUNNING" | "STALLED" | "UNKNOWN" {
  const { coef, intercept, classes } = model
  const vec = transformTFIDF(summary)
  const scores: number[] = []

  for (let c = 0; c < coef.length; c++) {
    let score = intercept[c] || 0
    for (let i = 0; i < vec.length; i++) score += vec[i] * (coef[c][i] || 0)
    scores.push(score)
  }

  const probs = softmax(scores)
  return classes[probs.indexOf(Math.max(...probs))] as "RUNNING" | "STALLED" | "UNKNOWN"
}