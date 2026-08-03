import { estimateCostUsd } from "./pricing.js";
import {
  addUsage,
  type SessionEvent,
  type SessionMeta,
  type TokenUsage,
  zeroUsage,
} from "./types.js";

export interface ModelUsage {
  model: string;
  requests: number;
  usage: TokenUsage;
  /** Null when the model has no pricing entry. */
  costUsd: number | null;
}

export interface SessionSummary {
  id: string;
  agent: SessionMeta["agent"];
  title?: string;
  startedAt: string;
  endedAt?: string;
  /** Null while the session is still running. */
  durationMs: number | null;
  exitCode?: number | null;
  prompts: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
  filesChanged: string[];
  models: ModelUsage[];
  totalUsage: TokenUsage;
  /** Sum across models; null if any contributing model has unknown pricing. */
  totalCostUsd: number | null;
}

export function summarizeSession(meta: SessionMeta, events: SessionEvent[]): SessionSummary {
  let prompts = 0;
  let toolCalls = 0;
  const toolCounts: Record<string, number> = {};
  const filesChanged = new Set<string>();
  const perModel = new Map<string, { requests: number; usage: TokenUsage }>();
  let title = meta.title;

  for (const event of events) {
    switch (event.type) {
      case "prompt":
        prompts += 1;
        break;
      case "tool.start": {
        toolCalls += 1;
        toolCounts[event.data.name] = (toolCounts[event.data.name] ?? 0) + 1;
        break;
      }
      case "file.change":
        filesChanged.add(event.data.path);
        break;
      case "usage": {
        const entry = perModel.get(event.data.model) ?? { requests: 0, usage: zeroUsage() };
        entry.requests += 1;
        entry.usage = addUsage(entry.usage, event.data.usage);
        perModel.set(event.data.model, entry);
        break;
      }
      case "session.title":
        title = event.data.title;
        break;
      default:
        break;
    }
  }

  const models: ModelUsage[] = [...perModel.entries()].map(([model, entry]) => ({
    model,
    requests: entry.requests,
    usage: entry.usage,
    costUsd: estimateCostUsd(model, entry.usage),
  }));

  let totalUsage = zeroUsage();
  let totalCostUsd: number | null = models.length > 0 ? 0 : null;
  for (const m of models) {
    totalUsage = addUsage(totalUsage, m.usage);
    totalCostUsd = m.costUsd === null || totalCostUsd === null ? null : totalCostUsd + m.costUsd;
  }

  const durationMs =
    meta.endedAt !== undefined ? Date.parse(meta.endedAt) - Date.parse(meta.startedAt) : null;

  return {
    id: meta.id,
    agent: meta.agent,
    ...(title !== undefined ? { title } : {}),
    startedAt: meta.startedAt,
    ...(meta.endedAt !== undefined ? { endedAt: meta.endedAt } : {}),
    durationMs,
    ...(meta.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
    prompts,
    toolCalls,
    toolCounts,
    filesChanged: [...filesChanged].sort(),
    models,
    totalUsage,
    totalCostUsd,
  };
}
