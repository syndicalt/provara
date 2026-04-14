import { Hono } from "hono";
import type { ProviderRegistry, CompletionRequest } from "./providers/index.js";
import type { Db } from "@provara/db";
import { requests } from "@provara/db";
import { nanoid } from "nanoid";
import { logCost } from "./cost/index.js";

interface RouterContext {
  registry: ProviderRegistry;
  db: Db;
}

export function createRouter(ctx: RouterContext) {
  const app = new Hono();

  // OpenAI-compatible chat completions endpoint
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<CompletionRequest & { provider?: string }>();
    const { provider: providerName, ...request } = body;

    const provider = providerName
      ? ctx.registry.get(providerName)
      : ctx.registry.getForModel(request.model);

    if (!provider) {
      return c.json(
        { error: { message: `No provider found for model: ${request.model}`, type: "invalid_request_error" } },
        404
      );
    }

    const response = await provider.complete(request);

    const requestId = nanoid();
    ctx.db
      .insert(requests)
      .values({
        id: requestId,
        provider: response.provider,
        model: response.model,
        prompt: JSON.stringify(request.messages),
        response: response.content,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        latencyMs: response.latencyMs,
      })
      .run();

    await logCost(ctx.db, {
      requestId,
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });

    // Return OpenAI-compatible response format
    return c.json({
      id: `chatcmpl-${response.id}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: response.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: response.content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: response.usage.inputTokens,
        completion_tokens: response.usage.outputTokens,
        total_tokens: response.usage.inputTokens + response.usage.outputTokens,
      },
      _provara: {
        provider: response.provider,
        latencyMs: response.latencyMs,
      },
    });
  });

  // List available providers and models
  app.get("/v1/providers", (c) => {
    const providers = ctx.registry.list().map((p) => ({
      name: p.name,
      models: p.models,
    }));
    return c.json({ providers });
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  return app;
}
