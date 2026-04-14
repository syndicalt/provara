import { serve } from "@hono/node-server";
import { createDb } from "@provara/db";
import { createProviderRegistry } from "./providers/index.js";
import { createRouter } from "./router.js";

const port = parseInt(process.env.PORT || "4000", 10);

const db = createDb();
const registry = createProviderRegistry();
const app = createRouter({ registry, db });

console.log(`Provara gateway running on http://localhost:${port}`);
console.log(`Providers: ${registry.list().map((p) => p.name).join(", ")}`);

serve({ fetch: app.fetch, port });
