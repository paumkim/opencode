/**
 * Argument builder that tracks sources for tool calls.
 */

import type { Pools, Candidate } from "../../core/pools.js";
import type { ArgTrace, ArgSource } from "../../core/trace.js";

/**
 * Missing argument response.
 */
export interface MissingArg {
  missing: string;
  question: string;
}

export class Args {
  private answers: Record<string, any>;
  private pools: Pools;
  private args: Record<string, any> = {};
  private traces: ArgTrace[] = [];

  constructor(answers: Record<string, any>, pools: Pools) {
    this.answers = answers;
    this.pools = pools;
  }

  /**
   * Pick a value from a pool candidate.
   */
  pick(key: string, poolKey: string): void {
    const candidates = this.pools[poolKey as keyof Pools] as Candidate[] | undefined;
    const value = candidates?.[0]?.value ?? this.answers[poolKey];
    this.args[key] = value;
    this.traces.push({ key, value, source: "jev", fromPool: poolKey });
  }

  /**
   * Use a choice answer or default value.
   */
  option(key: string, defaultValue: string): void {
    const value = this.answers[key] ?? defaultValue;
    this.args[key] = value;
    this.traces.push({ key, value, source: this.answers[key] ? "jev" : "default" });
  }

  /**
   * Set an explicit value, source "code".
   */
  set(key: string, value: any): void {
    this.args[key] = value;
    this.traces.push({ key, value, source: "code" });
  }

  /**
   * Send-only value, source "code".
   */
  fixed(key: string, value: any): void {
    this.args[key] = value;
    this.traces.push({ key, value, source: "code" });
  }

  /**
   * Show-only value, source "code".
   * Not sent to MCP, only appears in inspector trace.
   */
  note(key: string, value: any): void {
    this.traces.push({ key, value, source: "code" });
  }

  /**
   * Require an answer; return missing prompt if absent.
   */
  require(key: string, question: string): MissingArg | null {
    if (this.answers[key] !== undefined && this.answers[key] !== null && this.answers[key] !== "") {
      return null;
    }
    return { missing: key, question };
  }

  /**
   * Build final args and traces.
   */
  build(): { args: Record<string, any>; traces: ArgTrace[] } {
    return { args: this.args, traces: this.traces };
  }
}
