import { Hono } from "hono";
import type { Db } from "@provara/db";
import { promptTemplates, promptVersions } from "@provara/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getTenantId } from "../auth/tenant.js";

export function createPromptRoutes(db: Db) {
  const app = new Hono();

  // List all prompt templates
  app.get("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const templates = await db
      .select()
      .from(promptTemplates)
      .where(tenantId ? eq(promptTemplates.tenantId, tenantId) : undefined)
      .orderBy(desc(promptTemplates.updatedAt))
      .all();

    // Get version counts
    const versionCounts = await db
      .select({
        templateId: promptVersions.templateId,
        count: sql<number>`count(*)`,
        latest: sql<number>`max(${promptVersions.version})`,
      })
      .from(promptVersions)
      .groupBy(promptVersions.templateId)
      .all();

    const countMap = new Map(versionCounts.map((v) => [v.templateId, v]));

    return c.json({
      templates: templates.map((t) => ({
        ...t,
        versionCount: countMap.get(t.id)?.count || 0,
        latestVersion: countMap.get(t.id)?.latest || 0,
      })),
    });
  });

  // Get a template with its versions
  app.get("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const where = tenantId ? and(eq(promptTemplates.id, id), eq(promptTemplates.tenantId, tenantId)) : eq(promptTemplates.id, id);
    const template = await db.select().from(promptTemplates).where(where).get();
    if (!template) {
      return c.json({ error: { message: "Template not found", type: "not_found" } }, 404);
    }

    const versions = await db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.templateId, id))
      .orderBy(desc(promptVersions.version))
      .all();

    return c.json({ template, versions });
  });

  // Create a template
  app.post("/", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      description?: string;
      messages: { role: string; content: string }[];
      note?: string;
    }>();

    if (!body.name || !body.messages?.length) {
      return c.json({ error: { message: "name and messages are required", type: "validation_error" } }, 400);
    }

    const templateId = nanoid();
    const versionId = nanoid();
    const variables = extractVariables(body.messages);

    await db.insert(promptTemplates).values({
      id: templateId,
      tenantId,
      name: body.name,
      description: body.description || null,
      publishedVersionId: versionId,
    }).run();

    await db.insert(promptVersions).values({
      id: versionId,
      templateId,
      version: 1,
      messages: JSON.stringify(body.messages),
      variables: JSON.stringify(variables),
      note: body.note || null,
    }).run();

    const template = await db.select().from(promptTemplates).where(eq(promptTemplates.id, templateId)).get();
    return c.json({ template, versionId }, 201);
  });

  // Add a new version to a template
  app.post("/:id/versions", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const where = tenantId ? and(eq(promptTemplates.id, id), eq(promptTemplates.tenantId, tenantId)) : eq(promptTemplates.id, id);
    const template = await db.select().from(promptTemplates).where(where).get();
    if (!template) {
      return c.json({ error: { message: "Template not found", type: "not_found" } }, 404);
    }

    const body = await c.req.json<{
      messages: { role: string; content: string }[];
      note?: string;
      publish?: boolean;
    }>();

    if (!body.messages?.length) {
      return c.json({ error: { message: "messages are required", type: "validation_error" } }, 400);
    }

    // Get next version number
    const latest = await db
      .select({ max: sql<number>`max(${promptVersions.version})` })
      .from(promptVersions)
      .where(eq(promptVersions.templateId, id))
      .get();

    const nextVersion = (latest?.max || 0) + 1;
    const versionId = nanoid();
    const variables = extractVariables(body.messages);

    await db.insert(promptVersions).values({
      id: versionId,
      templateId: id,
      version: nextVersion,
      messages: JSON.stringify(body.messages),
      variables: JSON.stringify(variables),
      note: body.note || null,
    }).run();

    // Auto-publish if requested
    if (body.publish !== false) {
      await db.update(promptTemplates)
        .set({ publishedVersionId: versionId, updatedAt: new Date() })
        .where(where)
        .run();
    }

    return c.json({ versionId, version: nextVersion }, 201);
  });

  // Publish a specific version
  app.post("/:id/publish/:versionId", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id, versionId } = c.req.param();
    const where = tenantId ? and(eq(promptTemplates.id, id), eq(promptTemplates.tenantId, tenantId)) : eq(promptTemplates.id, id);

    const version = await db.select().from(promptVersions)
      .where(and(eq(promptVersions.id, versionId), eq(promptVersions.templateId, id)))
      .get();
    if (!version) {
      return c.json({ error: { message: "Version not found", type: "not_found" } }, 404);
    }

    await db.update(promptTemplates)
      .set({ publishedVersionId: versionId, updatedAt: new Date() })
      .where(where)
      .run();

    return c.json({ published: true, version: version.version });
  });

  // Delete a template
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();
    const where = tenantId ? and(eq(promptTemplates.id, id), eq(promptTemplates.tenantId, tenantId)) : eq(promptTemplates.id, id);
    const template = await db.select().from(promptTemplates).where(where).get();
    if (!template) {
      return c.json({ error: { message: "Template not found", type: "not_found" } }, 404);
    }

    await db.delete(promptVersions).where(eq(promptVersions.templateId, id)).run();
    await db.delete(promptTemplates).where(where).run();
    return c.json({ deleted: true });
  });

  // Resolve a prompt template by name (for API consumers)
  app.get("/resolve/:name", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { name } = c.req.param();
    const conditions = [eq(promptTemplates.name, name)];
    if (tenantId) conditions.push(eq(promptTemplates.tenantId, tenantId));

    const template = await db.select().from(promptTemplates).where(and(...conditions)).get();
    if (!template || !template.publishedVersionId) {
      return c.json({ error: { message: "Prompt template not found or no published version", type: "not_found" } }, 404);
    }

    const version = await db.select().from(promptVersions)
      .where(eq(promptVersions.id, template.publishedVersionId))
      .get();
    if (!version) {
      return c.json({ error: { message: "Published version not found", type: "not_found" } }, 404);
    }

    const messages = JSON.parse(version.messages);
    const variables = JSON.parse(version.variables);

    // Apply variable substitution from query params
    const resolved = messages.map((msg: { role: string; content: string }) => ({
      role: msg.role,
      content: variables.reduce((content: string, varName: string) => {
        const value = c.req.query(varName) || `{{${varName}}}`;
        return content.replaceAll(`{{${varName}}}`, value);
      }, msg.content),
    }));

    return c.json({
      name: template.name,
      version: version.version,
      messages: resolved,
      variables,
    });
  });

  return app;
}

function extractVariables(messages: { role: string; content: string }[]): string[] {
  const vars = new Set<string>();
  for (const msg of messages) {
    const matches = msg.content.matchAll(/\{\{(\w+)\}\}/g);
    for (const match of matches) {
      vars.add(match[1]);
    }
  }
  return [...vars];
}
