import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

import { serve } from "@hono/node-server";
import { createDb, runMigrations } from "@provara/db";
import { createProviderRegistry } from "./providers/index.js";
import { createRouter } from "./router.js";
import { getDecryptedKeys } from "./routes/api-keys.js";
import { loadCustomProviders } from "./providers/custom-loader.js";

const port = parseInt(process.env.PORT || "4000", 10);

const db = createDb();
await runMigrations(db, resolve(process.cwd(), "packages/db/drizzle"));

const registry = await createProviderRegistry({
  getKeys: () => getDecryptedKeys(db),
  getCustomProviders: () => loadCustomProviders(db),
});
const app = await createRouter({ registry, db });

console.log(`Provara gateway running on http://localhost:${port}`);
console.log(`Providers: ${registry.list().map((p) => p.name).join(", ")}`);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
