// Test normalizeOutput directly
function normalizeOutput(value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (value > 1 && value <= 100) return value;
    if (value > 100) return 100;
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeOutput);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const normalized = normalizeOutput(v);
      if (normalized === 1 || normalized === "1" || normalized === "yes" || normalized === "true") {
        result[k] = true;
      } else if (normalized === 0 || normalized === "0" || normalized === "no" || normalized === "false") {
        result[k] = false;
      } else {
        result[k] = normalized;
      }
    }
    return result;
  }
  return value;
}

const raw = { tests_pass: 245, breaking_changes: 1, migration_needed: 0, confidence: 0.95 };
const normalized = normalizeOutput(raw);
console.log("Raw:", raw);
console.log("Normalized:", normalized);
console.log("tests_pass type:", typeof normalized.tests_pass);
console.log("breaking_changes type:", typeof normalized.breaking_changes);