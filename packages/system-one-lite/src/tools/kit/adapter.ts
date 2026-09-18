/**
 * Tool adapter contract matching jev-chat's pattern.
 */

import type { Pools, Candidate } from "../../core/pools.js";
import type { ArgTrace } from "../../core/trace.js";

/**
 * Raw tool result from an MCP call.
 */
export interface ToolResult {
  content: unknown;
  isError?: boolean;
}

/**
 * Card data for presentation.
 */
export interface ToolCard {
  title?: string;
  body?: string;
  fields?: Record<string, unknown>;
}

/**
 * Question definition for gathering arguments.
 */
export interface QuestionDefinition {
  key: string;
  question: string;
  type: "choice" | "candidate" | "noul";
  options?: Record<string, string>;
  poolKey?: string;
}

/**
 * Single-step tool adapter.
 */
export interface SingleStepAdapter {
  id: string;
  server: string;
  mcpName: string;
  label: string;
  description: string;
  examples: string[];
  questions: (pools: Pools) => Record<string, QuestionDefinition>;
  build: (
    answers: Record<string, any>,
    pools: Pools
  ) => { args: Record<string, any>; traces: ArgTrace[] } | { missing: string; question: string };
  present: (result: ToolResult) => { text: string; card: ToolCard };
}

/**
 * Multi-step tool adapter.
 */
export interface MultiStepAdapter extends SingleStepAdapter {
  run: (
    pools: Pools,
    askJev: (questions: QuestionDefinition[]) => Promise<Record<string, any>>
  ) => Promise<ToolResult>;
}

/**
 * Raw fallback for unknown tool results.
 */
export function rawFallback(result: ToolResult): { text: string; card: ToolCard } {
  return {
    text: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
    card: {
      title: result.isError ? "Error" : "Result",
      body: typeof result.content === "string" ? result.content : undefined,
      fields: typeof result.content === "object" ? (result.content as Record<string, unknown>) : undefined,
    },
  };
}
