import type { Db } from "@provara/db";
import { customProviders } from "@provara/db";
import { eq } from "drizzle-orm";
import type { OpenAICompatibleConfig } from "./openai-compatible.js";
import { decrypt, hasMasterKey } from "../crypto/index.js";
import { apiKeys } from "@provara/db";

export function loadCustomProviders(db: Db): OpenAICompatibleConfig[] {
  const rows = db
    .select()
    .from(customProviders)
    .where(eq(customProviders.enabled, true))
    .all();

  const configs: OpenAICompatibleConfig[] = [];

  for (const row of rows) {
    let apiKey = "";

    // Resolve API key from api_keys table if reference is set
    if (row.apiKeyRef && hasMasterKey()) {
      const keyRow = db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.name, row.apiKeyRef))
        .get();

      if (keyRow) {
        try {
          apiKey = decrypt({
            encrypted: keyRow.encryptedValue,
            iv: keyRow.iv,
            authTag: keyRow.authTag,
          });
        } catch {
          // Skip if decryption fails
        }
      }
    }

    let models: string[] = [];
    try {
      models = JSON.parse(row.models);
    } catch {
      models = [];
    }

    configs.push({
      name: row.name,
      baseURL: row.baseURL,
      apiKey,
      models,
    });
  }

  return configs;
}
