import { Hono } from "hono";
import type { Db } from "@provara/db";
import { abTests, abTestVariants, requests } from "@provara/db";
import { eq, and, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export function createAbTestRoutes(db: Db) {
  const app = new Hono();

  // List all A/B tests
  app.get("/", (c) => {
    const tests = db.select().from(abTests).all();
    return c.json({ tests });
  });

  // Get a single A/B test with variants and results
  app.get("/:id", (c) => {
    const { id } = c.req.param();

    const test = db.select().from(abTests).where(eq(abTests.id, id)).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    const variants = db
      .select()
      .from(abTestVariants)
      .where(eq(abTestVariants.abTestId, id))
      .all();

    // Get aggregate results per variant model
    const results = db
      .select({
        model: requests.model,
        provider: requests.provider,
        count: sql<number>`count(*)`,
        avgLatency: sql<number>`avg(${requests.latencyMs})`,
        avgInputTokens: sql<number>`avg(${requests.inputTokens})`,
        avgOutputTokens: sql<number>`avg(${requests.outputTokens})`,
        totalCost: sql<number>`sum(${requests.cost})`,
      })
      .from(requests)
      .where(eq(requests.abTestId, id))
      .groupBy(requests.model, requests.provider)
      .all();

    return c.json({ test, variants, results });
  });

  // Create a new A/B test
  app.post("/", async (c) => {
    const body = await c.req.json<{
      name: string;
      description?: string;
      taskType?: string;
      complexity?: string;
      variants: { provider: string; model: string; weight?: number }[];
    }>();

    if (!body.name || !body.variants || body.variants.length < 2) {
      return c.json(
        { error: { message: "Name and at least 2 variants required", type: "validation_error" } },
        400
      );
    }

    const testId = nanoid();
    db.insert(abTests)
      .values({
        id: testId,
        name: body.name,
        description: body.description || null,
      })
      .run();

    for (const variant of body.variants) {
      db.insert(abTestVariants)
        .values({
          id: nanoid(),
          abTestId: testId,
          provider: variant.provider,
          model: variant.model,
          weight: variant.weight ?? 1,
          taskType: body.taskType || null,
          complexity: body.complexity || null,
        })
        .run();
    }

    const test = db.select().from(abTests).where(eq(abTests.id, testId)).get();
    const variants = db
      .select()
      .from(abTestVariants)
      .where(eq(abTestVariants.abTestId, testId))
      .all();

    return c.json({ test, variants }, 201);
  });

  // Update A/B test status
  app.patch("/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json<{
      status?: "active" | "paused" | "completed";
      name?: string;
      description?: string;
    }>();

    const test = db.select().from(abTests).where(eq(abTests.id, id)).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    const updates: Record<string, unknown> = {};
    if (body.status) updates.status = body.status;
    if (body.name) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;

    if (Object.keys(updates).length > 0) {
      db.update(abTests).set(updates).where(eq(abTests.id, id)).run();
    }

    const updated = db.select().from(abTests).where(eq(abTests.id, id)).get();
    return c.json({ test: updated });
  });

  // Delete an A/B test
  app.delete("/:id", (c) => {
    const { id } = c.req.param();

    const test = db.select().from(abTests).where(eq(abTests.id, id)).get();
    if (!test) {
      return c.json({ error: { message: "A/B test not found", type: "not_found" } }, 404);
    }

    db.delete(abTestVariants).where(eq(abTestVariants.abTestId, id)).run();
    db.delete(abTests).where(eq(abTests.id, id)).run();

    return c.json({ deleted: true });
  });

  return app;
}
