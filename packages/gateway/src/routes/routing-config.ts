import { Hono } from "hono";
import type { Db } from "@provara/db";
import { getRoutingConfig, setRoutingConfig } from "../routing/config.js";

export function createRoutingConfigRoutes(db: Db) {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json(getRoutingConfig());
  });

  app.put("/", async (c) => {
    const body = await c.req.json<{ abTestPreempts?: boolean }>();
    await setRoutingConfig(db, body);
    return c.json(getRoutingConfig());
  });

  return app;
}
