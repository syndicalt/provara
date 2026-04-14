import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  prompt: text("prompt").notNull(),
  response: text("response"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms"),
  cost: real("cost"),
  taskType: text("task_type"),
  complexity: text("complexity"),
  routedBy: text("routed_by"),
  abTestId: text("ab_test_id").references(() => abTests.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const abTests = sqliteTable("ab_tests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status", { enum: ["active", "paused", "completed"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const abTestVariants = sqliteTable("ab_test_variants", {
  id: text("id").primaryKey(),
  abTestId: text("ab_test_id")
    .notNull()
    .references(() => abTests.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  weight: real("weight").notNull().default(1),
  taskType: text("task_type"),
  complexity: text("complexity"),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // e.g. "OPENAI_API_KEY"
  provider: text("provider").notNull(), // e.g. "openai"
  encryptedValue: text("encrypted_value").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const costLogs = sqliteTable("cost_logs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").references(() => requests.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cost: real("cost").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
