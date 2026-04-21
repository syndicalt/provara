import { Hono } from "hono";
import type { Db } from "@provara/db";
import { customProviders, modelRegistry } from "@provara/db";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { discoverModels, validateCompatibility } from "../providers/openai-compatible.js";
import { getDecryptedKeys } from "./api-keys.js";
import { getTenantId, tenantFilter } from "../auth/tenant.js";

export function createProviderCrudRoutes(db: Db) {
  const app = new Hono();

  // List custom providers
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const providers = await db.select().from(customProviders).where(tenantFilter(customProviders.tenantId, tenantId)).all();
    return c.json({
      providers: providers.map((p) => ({
        ...p,
        models: JSON.parse(p.models),
      })),
    });
  });

  // Get a custom provider
  app.get("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const provider = await db.select().from(customProviders).where((() => { const tc = tenantFilter(customProviders.tenantId, tenantId); return tc ? and(eq(customProviders.id, id), tc) : eq(customProviders.id, id); })()).get();
    if (!provider) {
      return c.json({ error: { message: "Provider not found", type: "not_found" } }, 404);
    }
    return c.json({ provider: { ...provider, models: JSON.parse(provider.models) } });
  });

  // Create a custom provider
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      baseURL: string;
      apiKeyRef?: string;
      models?: string[];
      discover?: boolean;
    }>();

    if (!body.name || !body.baseURL) {
      return c.json(
        { error: { message: "name and baseURL are required", type: "validation_error" } },
        400
      );
    }

    // Check for duplicate name (scoped to tenant)
    const existing = await db.select().from(customProviders).where((() => {
      const tc = tenantFilter(customProviders.tenantId, tenantId);
      return tc ? and(eq(customProviders.name, body.name), tc) : eq(customProviders.name, body.name);
    })()).get();
    if (existing) {
      return c.json(
        { error: { message: `Provider "${body.name}" already exists`, type: "validation_error" } },
        409
      );
    }

    // Resolve API key for validation. apiKeyRef must be a name that exists in
    // the api_keys table — reject raw secrets pasted into the field.
    let apiKey = "";
    if (body.apiKeyRef) {
      const keys = await getDecryptedKeys(db);
      if (!(body.apiKeyRef in keys)) {
        return c.json(
          {
            error: {
              message: `No API key named "${body.apiKeyRef}" found. Add it on the API Keys page first, then reference it here by name (do not paste the raw secret).`,
              type: "validation_error",
            },
          },
          400
        );
      }
      apiKey = keys[body.apiKeyRef];
    }

    // Validate OpenAI compatibility before saving
    if (apiKey) {
      const validation = await validateCompatibility(body.baseURL, apiKey);
      if (!validation.compatible) {
        return c.json(
          { error: { message: validation.error || "Provider is not OpenAI-compatible", type: "compatibility_error" } },
          422
        );
      }
    }

    let models = body.models || [];

    // Auto-discover models if requested
    if (body.discover && apiKey) {
      const discovered = await discoverModels(body.baseURL, apiKey);
      if (discovered.length > 0) {
        models = [...new Set([...models, ...discovered])];
      }
    }

    const id = nanoid();
    await db.insert(customProviders)
      .values({
        id,
        name: body.name,
        baseURL: body.baseURL,
        apiKeyRef: body.apiKeyRef || null,
        models: JSON.stringify(models),
        tenantId,
      })
      .run();

    // Add models to registry
    for (const model of models) {
      const existingModel = await db
        .select()
        .from(modelRegistry)
        .where(eq(modelRegistry.model, model))
        .get();
      if (!existingModel) {
        await db.insert(modelRegistry)
          .values({
            id: nanoid(),
            provider: body.name,
            model,
            source: body.discover ? "discovered" : "custom",
          })
          .run();
      }
    }

    return c.json(
      { provider: { id, name: body.name, baseURL: body.baseURL, models, apiKeyRef: body.apiKeyRef } },
      201
    );
  });

  // Update a custom provider
  app.patch("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const body = await c.req.json<{
      name?: string;
      baseURL?: string;
      apiKeyRef?: string | null;
      models?: string[];
      enabled?: boolean;
    }>();

    const whereClause = (() => { const tc = tenantFilter(customProviders.tenantId, tenantId); return tc ? and(eq(customProviders.id, id), tc) : eq(customProviders.id, id); })();
    const provider = await db.select().from(customProviders).where(whereClause).get();
    if (!provider) {
      return c.json({ error: { message: "Provider not found", type: "not_found" } }, 404);
    }

    if (body.apiKeyRef !== undefined && body.apiKeyRef !== null && body.apiKeyRef !== "") {
      const keys = await getDecryptedKeys(db);
      if (!(body.apiKeyRef in keys)) {
        return c.json(
          {
            error: {
              message: `No API key named "${body.apiKeyRef}" found. Add it on the API Keys page first, then reference it here by name (do not paste the raw secret).`,
              type: "validation_error",
            },
          },
          400
        );
      }
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.baseURL !== undefined) updates.baseURL = body.baseURL;
    if (body.apiKeyRef !== undefined) updates.apiKeyRef = body.apiKeyRef;
    if (body.models !== undefined) updates.models = JSON.stringify(body.models);
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    if (Object.keys(updates).length > 0) {
      await db.update(customProviders).set(updates).where(whereClause).run();
    }

    const updated = await db.select().from(customProviders).where(whereClause).get();
    return c.json({ provider: { ...updated!, models: JSON.parse(updated!.models) } });
  });

  // Delete a custom provider
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const whereClause = (() => { const tc = tenantFilter(customProviders.tenantId, tenantId); return tc ? and(eq(customProviders.id, id), tc) : eq(customProviders.id, id); })();
    const provider = await db.select().from(customProviders).where(whereClause).get();
    if (!provider) {
      return c.json({ error: { message: "Provider not found", type: "not_found" } }, 404);
    }

    await db.delete(customProviders).where(whereClause).run();
    return c.json({ deleted: true });
  });

  // Discover models for a provider
  app.post("/:id/discover", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const provider = await db.select().from(customProviders).where((() => { const tc = tenantFilter(customProviders.tenantId, tenantId); return tc ? and(eq(customProviders.id, id), tc) : eq(customProviders.id, id); })()).get();
    if (!provider) {
      return c.json({ error: { message: "Provider not found", type: "not_found" } }, 404);
    }

    let apiKey = "";
    if (provider.apiKeyRef) {
      const keys = await getDecryptedKeys(db);
      apiKey = keys[provider.apiKeyRef] || "";
    }

    if (!apiKey) {
      return c.json({ error: { message: "No API key configured for this provider", type: "configuration_error" } }, 400);
    }

    const discovered = await discoverModels(provider.baseURL, apiKey);
    const existingModels: string[] = JSON.parse(provider.models);
    const merged = [...new Set([...existingModels, ...discovered])];

    await db.update(customProviders)
      .set({ models: JSON.stringify(merged) })
      .where(eq(customProviders.id, id))
      .run();

    // Add new models to registry
    for (const model of discovered) {
      const existingModel = await db.select().from(modelRegistry).where(eq(modelRegistry.model, model)).get();
      if (!existingModel) {
        await db.insert(modelRegistry)
          .values({
            id: nanoid(),
            provider: provider.name,
            model,
            source: "discovered",
          })
          .run();
      }
    }

    return c.json({
      discovered: discovered.length,
      total: merged.length,
      models: merged,
    });
  });

  // Validate a provider's OpenAI compatibility without saving
  app.post("/validate", async (c) => {
    const body = await c.req.json<{
      baseURL: string;
      apiKey?: string;
      apiKeyRef?: string;
    }>();

    if (!body.baseURL) {
      return c.json({ error: { message: "baseURL is required", type: "validation_error" } }, 400);
    }

    let apiKey = body.apiKey || "";
    if (!apiKey && body.apiKeyRef) {
      const keys = await getDecryptedKeys(db);
      apiKey = keys[body.apiKeyRef] || "";
    }

    if (!apiKey) {
      return c.json({ error: { message: "An API key is required for validation", type: "validation_error" } }, 400);
    }

    const result = await validateCompatibility(body.baseURL, apiKey);
    return c.json(result);
  });

  return app;
}
