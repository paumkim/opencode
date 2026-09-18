/**
 * Pre-processing steps: spell correction and follow-up resolution.
 */

import nlp from "compromise";
import type { Pools } from "./pools.js";

// Dynamic import helper for ESM-only cspell-lib
async function importCspellLib() {
  return await import("cspell-lib") as any;
}

/**
 * A pending question from a previous turn.
 */
export interface PendingQuestion {
  key: string;
  type: "date" | "number" | "place" | "choice" | "candidate" | "noul";
  currentValue: string;
}

/**
 * Result of a pre-processing step.
 */
export interface PreprocessResult {
  text: string;
  fixes: Array<{ from: string; to: string }>;
  suggestions: Array<{ word: string; suggestions: string[] }>;
}

/**
 * Correct spelling in a message using cspell-lib.
 */
export async function correctSpelling(message: string, pools: Pools): Promise<PreprocessResult> {
  const cspell = await importCspellLib();
  const result = await cspell.checkText(message, {});
  const fixes: PreprocessResult["fixes"] = [];
  const suggestions: PreprocessResult["suggestions"] = [];
  const skipSet = new Set<string>();

  // Build skip set
  const words = message.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z'-]/g, "");
    if (clean.length <= 3) skipSet.add(clean.toLowerCase());
  }

  const doc = nlp(message);
  const nameTags = doc.json().flatMap((t: any) => (t.tags || []));
  for (const tag of nameTags) {
    if (["Name", "Acronym", "Link", "Hashtag"].includes(tag)) {
      skipSet.add(tag);
    }
  }

  for (const p of pools.places) {
    skipSet.add(p.value.toLowerCase());
  }
  for (const r of pools.recentResults) {
    skipSet.add(r.toLowerCase());
  }

  let checkedMessage = message;
  for (const item of result.items) {
    if (!item.isError) continue;
    const word = item.text;
    const clean = word.replace(/[^a-zA-Z'-]/g, "");
    if (!clean || skipSet.has(clean.toLowerCase())) continue;

    const wordSuggestions = await cspell.suggestionsForWord(clean, {});
    const exactFixes = wordSuggestions.filter((s: any) => s.isPreferred);
    if (exactFixes.length === 1) {
      const fix = exactFixes[0].word;
      if (fix !== clean) {
        checkedMessage = checkedMessage.replace(new RegExp(`\\b${clean}\\b`, "g"), fix);
        fixes.push({ from: clean, to: fix });
      }
      continue;
    }

    const oneEdit = wordSuggestions.filter((s: any) => s.distance === 1);
    if (oneEdit.length === 1 && clean === clean.toLowerCase()) {
      const fix = oneEdit[0].word;
      checkedMessage = checkedMessage.replace(new RegExp(`\\b${clean}\\b`, "g"), fix);
      fixes.push({ from: clean, to: fix });
      continue;
    }

    if (suggestions.length < 6) {
      suggestions.push({
        word: clean,
        suggestions: wordSuggestions.slice(0, 5).map((s: any) => s.word),
      });
    }
  }

  return { text: checkedMessage, fixes, suggestions };
}

/**
 * Resolve a follow-up message against a pending question.
 */
export function resolveFollowUp(
  message: string,
  pools: Pools,
  pendingQuestion?: PendingQuestion
): PreprocessResult {
  if (!pendingQuestion || message.length > 50) {
    return { text: message, fixes: [], suggestions: [] };
  }

  const hasDate = pools.dates.length > 0;
  const hasNumber = pools.numbers.length > 0;
  const hasPlace = pools.places.length > 0;

  switch (pendingQuestion.type) {
    case "date":
      if (hasDate) {
        return { text: pools.dates[0].value, fixes: [], suggestions: [] };
      }
      break;
    case "number":
      if (hasNumber) {
        return { text: pools.numbers[0].value, fixes: [], suggestions: [] };
      }
      break;
    case "place":
      if (hasPlace) {
        return { text: pools.places[0].value, fixes: [], suggestions: [] };
      }
      break;
  }

  // Generate rewrite candidates by replacing 1-2 word spans or appending
  const candidates: string[] = [];
  const prev = pendingQuestion.currentValue;
  for (const span of pools.spans.slice(0, 2)) {
    candidates.push(prev.replace(/\b\w+\b/g, span));
  }
  candidates.push(`${prev} ${message}`);

  return {
    text: candidates[0] ?? message,
    fixes: [],
    suggestions: candidates.map((c) => ({ word: c, suggestions: [] })),
  };
}
