/**
 * Workflow Evaluation Harness - TypeSafe-style evaluation
 * Measures how well structured decisions work inside code workflows
 */

import { z } from "zod";
import type {
  Workflow,
  WorkflowStep,
  WorkflowResult,
  EvalMetrics,
} from "../core/types.js";
import { LlamaCppGenerator } from "../core/generator.js";

/**
 * Run a single workflow with context
 */
export class WorkflowRunner {
  constructor(
    private generator: LlamaCppGenerator,
    private referenceGenerator?: LlamaCppGenerator
  ) {}

  /**
   * Execute a workflow
   */
  async run(workflow: Workflow, context: Record<string, unknown>): Promise<WorkflowResult> {
    return this.generator.runWorkflow(workflow, context);
  }

/**
  * Run workflow on multiple contexts with bounded concurrency
  */
 async runBatch(
    workflow: Workflow,
    contexts: Record<string, unknown>[],
    concurrency = 2
  ): Promise<WorkflowResult[]> {
    return this.generator.runBatch(workflow, contexts, concurrency);
  }

  /**
   * Run with reference generator for comparison
   */
  async runWithReference(
    workflow: Workflow,
    contexts: Record<string, unknown>[]
  ): Promise<{ results: WorkflowResult[]; referenceResults: WorkflowResult[] }> {
    if (!this.referenceGenerator) {
      throw new Error("No reference generator configured");
    }

    const referenceRunner = new WorkflowRunner(this.referenceGenerator);
    const [results, referenceResults] = await Promise.all([
      this.runBatch(workflow, contexts),
      referenceRunner.runBatch(workflow, contexts),
    ]);

    return { results, referenceResults };
  }
}

/**
 * Compute agreement rate between two result sets
 */
export function computeAgreement(
  results: WorkflowResult[],
  referenceResults: WorkflowResult[]
): number {
  if (results.length !== referenceResults.length) {
    throw new Error("Mismatched result counts");
  }

  let agreements = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const ref = referenceResults[i];

    if (r.success && ref.success) {
      const match = Object.keys(r.stepResults).every(
        k => JSON.stringify(r.stepResults[k]) === JSON.stringify(ref.stepResults[k])
      );
      if (match) agreements++;
    }
  }

  return agreements / results.length;
}

/**
 * Compute evaluation metrics
 */
export function computeMetrics(
  workflowName: string,
  results: WorkflowResult[],
  referenceResults?: WorkflowResult[]
): EvalMetrics {
  const successful = results.filter(r => r.success);
  const successRate = successful.length / results.length;
  const avgLatencyMs = results.reduce((s, r) => s + r.totalLatencyMs, 0) / results.length;
  const avgTokens = results.reduce((s, r) => s + r.totalTokens, 0) / results.length;

  let agreementRate: number | undefined;
  if (referenceResults) {
    agreementRate = computeAgreement(results, referenceResults);
  }

  return {
    workflowName,
    nSamples: results.length,
    successRate,
    avgLatencyMs,
    avgTokens,
    agreementRate,
  };
}

/**
 * Pre-defined workflows
 */

// Issue Triage Workflow
export const ISSUE_TRIAGE_WORKFLOW: Workflow = {
  name: "issue_triage",
  description: "Triage GitHub issue → category, priority, area, estimate",
  steps: [
    {
      name: "classify",
      promptTemplate: `Context: {context}

Issue: {issue_title}
{issue_body}

Classify this issue. Output JSON with: category, priority, area, estimated_hours, needs_design_review`,
      schema: z.object({
        category: z.enum(["bug", "feature", "question", "docs", "refactor"]),
        priority: z.enum(["P0", "P1", "P2", "P3"]),
        area: z.enum(["frontend", "backend", "cli", "docs", "infra", "unknown"]),
        estimated_hours: z.number().int().min(0).max(100),
        needs_design_review: z.boolean(),
      }).describe("issue_triage_classify"),
    },
  ],
};

// Code Review Workflow (multi-step) - Fixed: unconstrained strings replaced with enums
export const CODE_REVIEW_WORKFLOW: Workflow = {
  name: "code_review",
  description: "Decide: approve, request changes, or block",
  steps: [
    {
      name: "security_check",
      promptTemplate: `Code diff: {diff}

Are there security vulnerabilities? Output JSON with: has_vuln, severity, finding_type`,
      schema: z.object({
        has_vuln: z.boolean(),
        severity: z.enum(["none", "low", "medium", "high", "critical"]),
        finding_type: z.enum(["none", "injection", "auth_bypass", "data_exposure", "crypto_weak", "path_traversal", "xss", "other"]),
      }).describe("security_check"),
    },
    {
      name: "correctness_check",
      promptTemplate: `Code diff: {diff}

Are there correctness bugs? Output JSON with: has_bug, severity, finding_type`,
      schema: z.object({
        has_bug: z.boolean(),
        severity: z.enum(["none", "low", "medium", "high"]),
        finding_type: z.enum(["none", "null_deref", "type_mismatch", "logic_error", "race_condition", "resource_leak", "off_by_one", "other"]),
      }).describe("correctness_check"),
    },
    {
      name: "final_decision",
      promptTemplate: `Security: {security_check}
Correctness: {correctness_check}

Final decision: approve | request_changes | block
Output JSON with: decision, reason_category`,
      schema: z.object({
        decision: z.enum(["approve", "request_changes", "block"]),
        reason_category: z.enum(["clean", "minor_issues", "security_concern", "correctness_bug", "breaking_change", "needs_tests", "needs_docs", "other"]),
      }).describe("final_decision"),
      extract: (output: any) => output,
    },
  ],
};

// Release Readiness Workflow
export const RELEASE_READINESS_WORKFLOW: Workflow = {
  name: "release_readiness",
  description: "Evaluate if release candidate is ready to ship",
  steps: [
    {
      name: "readiness",
      promptTemplate: `Release candidate: {version}
Changes: {changelog}
Test results: {test_results}

Evaluate release readiness. Output JSON with: tests_pass (true/false), breaking_changes (true/false), migration_needed (true/false), confidence (0.0-1.0 decimal).
Do NOT output numbers for booleans. Do NOT use percentages for confidence.`,
      schema: z.object({
        tests_pass: z.boolean(),
        breaking_changes: z.boolean(),
        migration_needed: z.boolean(),
        confidence: z.number().min(0).max(1),
      }).describe("release_readiness"),
    },
  ],
};

/**
 * Load contexts from JSONL file
 */
export async function loadContexts(filePath: string): Promise<Record<string, unknown>[]> {
  const { readFile } = await import("fs/promises");
  const content = await readFile(filePath, "utf-8");
  return content.trim().split("\n").map(line => JSON.parse(line));
}

/**
 * Save results to JSONL
 */
export async function saveResults(
  results: WorkflowResult[],
  filePath: string
): Promise<void> {
  const { writeFile } = await import("fs/promises");
  const lines = results.map(r => JSON.stringify(r)).join("\n");
  await writeFile(filePath, lines + "\n");
}