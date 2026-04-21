import { Hono } from "hono";
import type { Db } from "@provara/db";
import { apiKeys } from "@provara/db";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt, maskKey, hasMasterKey } from "../crypto/index.js";
import { getTenantId, tenantFilter } from "../auth/tenant.js";

export function createApiKeyRoutes(db: Db) {
  const app = new Hono();

  // Check if master key is configured
  app.get("/status", (c) => {
    return c.json({ configured: hasMasterKey() });
  });

  // List all API keys (masked values only)
  app.get("/", async (c) => {
    if (!hasMasterKey()) {
      return c.json({ error: { message: "PROVARA_MASTER_KEY not set", type: "configuration_error" } }, 503);
    }

    const tenantId = getTenantId(c.req.raw);
    const keys = await db.select().from(apiKeys).where(tenantFilter(apiKeys.tenantId, tenantId)).all();
    return c.json({
      keys: keys.map((k) => {
        let maskedValue: string;
        try {
          const decrypted = decrypt({
            encrypted: k.encryptedValue,
            iv: k.iv,
            authTag: k.authTag,
          });
          maskedValue = maskKey(decrypted);
        } catch {
          maskedValue = "••••(decrypt error)";
        }
        return {
          id: k.id,
          name: k.name,
          provider: k.provider,
          maskedValue,
          createdAt: k.createdAt,
          updatedAt: k.updatedAt,
        };
      }),
    });
  });

  // Create or update an API key
  app.post("/", async (c) => {
    if (!hasMasterKey()) {
      return c.json({ error: { message: "PROVARA_MASTER_KEY not set", type: "configuration_error" } }, 503);
    }

    const tenantId = getTenantId(c.req.raw);
    const body = await c.req.json<{
      name: string;
      provider: string;
      value: string;
    }>();

    if (!body.name || !body.provider || !body.value) {
      return c.json(
        { error: { message: "name, provider, and value are required", type: "validation_error" } },
        400
      );
    }

    // Trim whitespace/newlines before storing. A trailing \n from a pasted
    // value makes the stored key invalid as an HTTP header value (node-fetch
    // rejects it with "... is not a legal HTTP header value"), which
    // surfaces deep in the SDK as an opaque Connection error.
    const trimmedValue = body.value.trim();
    if (!trimmedValue) {
      return c.json(
        { error: { message: "value cannot be empty or whitespace-only", type: "validation_error" } },
        400
      );
    }

    const { encrypted, iv, authTag } = encrypt(trimmedValue);

    // Upsert: if a key with this name exists, update it
    const existing = await db
      .select()
      .from(apiKeys)
      .where((() => {
        const tc = tenantFilter(apiKeys.tenantId, tenantId);
        return tc ? and(eq(apiKeys.name, body.name), tc) : eq(apiKeys.name, body.name);
      })())
      .get();

    if (existing) {
      await db.update(apiKeys)
        .set({
          provider: body.provider,
          encryptedValue: encrypted,
          iv,
          authTag,
          updatedAt: new Date(),
        })
        .where(eq(apiKeys.id, existing.id))
        .run();

      return c.json({
        key: {
          id: existing.id,
          name: body.name,
          provider: body.provider,
          maskedValue: maskKey(trimmedValue),
        },
        updated: true,
      });
    }

    const id = nanoid();
    await db.insert(apiKeys)
      .values({
        id,
        name: body.name,
        provider: body.provider,
        encryptedValue: encrypted,
        iv,
        authTag,
        tenantId,
      })
      .run();

    return c.json(
      {
        key: {
          id,
          name: body.name,
          provider: body.provider,
          maskedValue: maskKey(trimmedValue),
        },
        updated: false,
      },
      201
    );
  });

  // Delete an API key
  app.delete("/:id", async (c) => {
    const tenantId = getTenantId(c.req.raw);
    const { id } = c.req.param();

    const tenantClause = tenantFilter(apiKeys.tenantId, tenantId);
    const whereClause = tenantClause ? and(eq(apiKeys.id, id), tenantClause) : eq(apiKeys.id, id);
    const key = await db.select().from(apiKeys).where(whereClause).get();
    if (!key) {
      return c.json({ error: { message: "API key not found", type: "not_found" } }, 404);
    }

    await db.delete(apiKeys).where(whereClause).run();
    return c.json({ deleted: true });
  });

  return app;
}

// Helper: get all decrypted API keys as a map (name → value)
// Used by the provider registry to load keys from DB
export async function getDecryptedKeys(db: Db): Promise<Record<string, string>> {
  if (!hasMasterKey()) return {};

  const keys = await db.select().from(apiKeys).all();
  const result: Record<string, string> = {};

  for (const k of keys) {
    try {
      // Defensive trim: existing rows saved before the POST-handler trim may
      // carry a trailing newline from a paste, which node-fetch rejects as an
      // illegal HTTP header value.
      result[k.name] = decrypt({
        encrypted: k.encryptedValue,
        iv: k.iv,
        authTag: k.authTag,
      }).trim();
    } catch {
      // Skip keys that can't be decrypted
    }
  }

  return result;
}
