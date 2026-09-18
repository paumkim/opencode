/**
 * Tool adapter registry.
 */

import type { SingleStepAdapter, MultiStepAdapter, QuestionDefinition, ToolResult, ToolCard, rawFallback } from "./kit/adapter.js";

export class ToolRegistry {
  private adapters: Map<string, SingleStepAdapter | MultiStepAdapter> = new Map();

  register(adapter: SingleStepAdapter | MultiStepAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): SingleStepAdapter | MultiStepAdapter | undefined {
    return this.adapters.get(id);
  }

  getByServer(serverId: string): (SingleStepAdapter | MultiStepAdapter)[] {
    return Array.from(this.adapters.values()).filter((a) => a.server === serverId);
  }

  getAll(): (SingleStepAdapter | MultiStepAdapter)[] {
    return Array.from(this.adapters.values());
  }
}

export const toolRegistry = new ToolRegistry();

// Re-export adapter types
export { SingleStepAdapter, MultiStepAdapter, QuestionDefinition, ToolResult, ToolCard, rawFallback };
