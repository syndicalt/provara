import type { Db } from "@provara/db";
import { costLogs } from "@provara/db";
import { nanoid } from "nanoid";
import { calculateCost } from "./pricing.js";

export { calculateCost, getPricing } from "./pricing.js";

export interface CostEntry {
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  tenantId?: string | null;
}

export async function logCost(db: Db, entry: CostEntry): Promise<number> {
  const cost = calculateCost(entry.model, entry.inputTokens, entry.outputTokens);

  await db.insert(costLogs)
    .values({
      id: nanoid(),
      requestId: entry.requestId,
      tenantId: entry.tenantId || null,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cost,
    })
    .run();

  return cost;
}
