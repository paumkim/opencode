/**
 * Inspector trace data structures.
 * Pure data types for tracing decisions, tool calls, and arguments.
 */

import type { Pools } from "./pools.js";

/**
 * Source of an argument value.
 */
export type ArgSource = "jev" | "code" | "user" | "default";

/**
 * Trace of a single argument.
 */
export interface ArgTrace {
  key: string;
  value: unknown;
  source: ArgSource;
  fromPool?: string;
}

/**
 * Trace of a question asked to the user/model.
 */
export interface QuestionTrace {
  key: string;
  question: string;
  options: Record<string, string>;
  answer: unknown;
  probabilities?: Record<string, number>;
}

/**
 * Trace of a tool call.
 */
export interface ToolCallTrace {
  serverId: string;
  toolName: string;
  args: ArgTrace[];
  result: unknown;
}

/**
 * Complete turn trace.
 */
export interface TurnTrace {
  id: string;
  originalMessage: string;
  preprocessedMessage: string;
  pools: Pools;
  jevCalls: QuestionTrace[][];
  chosenTool?: string;
  arguments?: ArgTrace[];
  toolCall?: ToolCallTrace;
  reply?: string;
  error?: string;
  latencyMs: number;
  confidence?: number;
}

/**
 * Generate a random 8-character hex trace ID.
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
