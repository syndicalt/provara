"use client";

const sections = [
  {
    title: "Getting Started",
    content: [
      {
        heading: "What is Provara?",
        text: "Provara is an intelligent multi-provider LLM gateway. It sits between your application and AI providers (OpenAI, Anthropic, Google, etc.), routing requests to the best model based on task type, complexity, quality scores, and cost. It exposes an OpenAI-compatible API, so you can point any existing SDK at it without code changes.",
      },
      {
        heading: "Quick Setup",
        text: "1. Add your provider API keys on the API Keys page.\n2. Create an API token on the Tokens page.\n3. Point your app at Provara using the token as your API key.\n4. Provara handles routing, fallbacks, and logging automatically.",
      },
      {
        heading: "OpenAI SDK Example",
        code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your-provara-instance/v1",
  apiKey: "pvra_your_token_here",
});

const response = await client.chat.completions.create({
  model: "", // Leave empty for auto-routing
  messages: [{ role: "user", content: "Hello!" }],
});`,
      },
    ],
  },
  {
    title: "Dashboard Pages",
    content: [
      {
        heading: "Overview",
        text: "The main dashboard shows aggregate stats: total requests, total cost, average latency, and active provider count. Below that, cost breakdown by model and a paginated request log with routing details.",
      },
      {
        heading: "Playground",
        text: "Interactive chat interface for testing models. Select a specific model or use auto-routing. Supports streaming responses, system prompts, and adjustable temperature/max tokens. Uses your configured API keys.",
      },
      {
        heading: "Providers",
        text: "Shows all active providers (built-in and custom). Built-in providers activate when you add their API key. Custom providers can be any OpenAI-compatible endpoint (Together AI, Groq, Fireworks, etc.). Use 'Discover Models' to auto-detect available models from a custom provider.",
      },
      {
        heading: "Routing",
        text: "Visual pipeline showing how requests flow through the system: Classifier, A/B Test, Adaptive Router, Cost Fallback, and Provider. Below the pipeline, see traffic distribution by task type and complexity, the routing matrix showing top models per cell, and detailed routing stats.",
      },
      {
        heading: "Quality",
        text: "Quality analytics powered by feedback scores. The adaptive routing matrix shows the best model per task/complexity cell based on EMA (exponential moving average) quality scores. View quality by model, recent feedback entries, and how the adaptive router is learning.",
      },
      {
        heading: "A/B Tests",
        text: "Create split tests between models. Traffic is randomly assigned to variants based on weight. Tests can be scoped to specific task types and complexities. View per-variant stats (requests, latency, cost, quality) and a winner recommendation. Expand individual requests to see prompts/responses and rate them inline.",
      },
      {
        heading: "Guardrails",
        text: "Input/output filtering for content safety. Built-in rules detect PII (SSN, credit cards, emails, phone numbers) and secrets (API keys). Add custom regex rules. Three actions: Block (reject the request), Redact (replace matches with [REDACTED]), or Flag (log but allow through). View recent violations in the log.",
      },
      {
        heading: "Tokens",
        text: "API tokens authenticate requests to /v1/chat/completions. Each token has a tenant, optional rate limit (requests per minute), spend limit (USD per period), and routing profile (cost/balanced/quality/custom). Tokens are shown once on creation and cannot be retrieved later.",
      },
      {
        heading: "API Keys",
        text: "Encrypted storage for provider API keys. Keys are encrypted with AES-256-GCM using your PROVARA_MASTER_KEY. Stored keys take precedence over environment variables. Adding a key automatically enables that provider.",
      },
    ],
  },
  {
    title: "Routing System",
    content: [
      {
        heading: "How Routing Works",
        text: "When a request arrives without a specific model:\n\n1. The classifier analyzes the prompt to determine task type (coding, creative, summarization, Q&A, general) and complexity (simple, medium, complex).\n\n2. If there's an active A/B test matching that cell, traffic is split between variants by weight.\n\n3. If adaptive routing has enough quality data (5+ feedback scores), it picks the highest-scoring model using a composite of quality, cost, and latency.\n\n4. Otherwise, the fallback chain routes to the cheapest available model.\n\nEach request logs which method was used: 'classification', 'ab-test', 'adaptive', 'routing-hint', or 'explicit'.",
      },
      {
        heading: "Routing Profiles",
        text: "Each API token can have a routing profile that changes how the adaptive router scores models:\n\n- Cost (70% cost, 20% quality, 10% latency) \u2014 cheapest model that meets minimum quality\n- Balanced (40% cost, 40% quality, 20% latency) \u2014 equal weight\n- Quality (70% quality, 15% cost, 15% latency) \u2014 best quality regardless of cost\n- Custom \u2014 set your own quality/cost/latency percentages",
      },
      {
        heading: "Routing Hints",
        text: "You can bypass the classifier by providing a routing hint in the request body:\n\n{\"routing_hint\": {\"task_type\": \"coding\"}}\n\nThis skips classification and uses your hint for routing cell selection.",
      },
      {
        heading: "Fallbacks",
        text: "If a provider fails (timeout, error, rate limit), Provara automatically tries the next provider in the fallback chain. The chain is sorted by cost (cheapest first). Failed providers are skipped for the rest of the request.",
      },
    ],
  },
  {
    title: "A/B Testing",
    content: [
      {
        heading: "Creating a Test",
        text: "A/B tests split traffic between 2+ model variants. Each variant has a provider, model, and weight. Equal weights = equal split. Set taskType and complexity to scope the test to specific routing cells, or leave them empty to test across all traffic.",
      },
      {
        heading: "Evaluating Results",
        text: "Expand a test to see per-variant stats: request count, avg latency, total cost, and quality score. Click 'Show requests for evaluation' to see individual prompts and responses. Rate each response 1-5 to build quality data. The winner recommendation uses a composite score from quality, cost, and latency.",
      },
      {
        heading: "How It Feeds Adaptive Routing",
        text: "Feedback scores from A/B tests feed directly into the adaptive routing engine. After completing a test, the router will naturally start favoring the higher-scored model for that task/complexity cell \u2014 no manual configuration needed.",
      },
    ],
  },
  {
    title: "API Reference",
    content: [
      {
        heading: "Chat Completions",
        code: `POST /v1/chat/completions
Authorization: Bearer pvra_your_token

{
  "model": "",           // empty for auto-routing, or specify a model
  "messages": [...],
  "stream": false,       // true for SSE streaming
  "temperature": 0.7,
  "max_tokens": 1024,
  "provider": "openai",  // optional: force a provider
  "routing_hint": {      // optional: bypass classifier
    "task_type": "coding"
  }
}`,
      },
      {
        heading: "Response Metadata",
        text: "Every response includes a _provara object with routing details:\n\n- provider: which provider handled the request\n- latencyMs: end-to-end latency\n- cached: whether the response came from cache\n- routing.taskType: classified task type\n- routing.complexity: classified complexity\n- routing.routedBy: which routing method was used\n- routing.usedFallback: whether the primary provider failed",
      },
      {
        heading: "Streaming",
        text: "Set stream: true for SSE streaming. The response uses the same format as OpenAI's streaming API (data: {json}\\n\\n lines, ending with data: [DONE]). Compatible with all OpenAI SDK streaming methods.",
      },
      {
        heading: "Caching",
        text: "Deterministic requests (temperature=0 or unset) are cached in memory for 5 minutes. Identical messages to the same routing cell return the cached response instantly. Disable with the x-provara-no-cache: true header or cache: false in the body.",
      },
    ],
  },
  {
    title: "Self-Hosted Deployment",
    content: [
      {
        heading: "Docker",
        code: `git clone https://github.com/syndicalt/provara.git
cd provara
cp .env.example .env
# Edit .env with your API keys
docker compose up -d`,
      },
      {
        heading: "Environment Variables",
        text: "Required:\n- PROVARA_MASTER_KEY: 64-char hex key for API key encryption\n- DATABASE_URL: libSQL/Turso connection URL\n\nOptional:\n- PROVARA_MODE: self_hosted (default) or multi_tenant\n- PROVARA_ADMIN_SECRET: protects dashboard routes\n- Provider API keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.",
      },
      {
        heading: "Generate a Master Key",
        code: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      },
    ],
  },
];

export default function HelpPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold mb-2">Help</h1>
      <p className="text-zinc-400 mb-8">Comprehensive guide to all Provara features.</p>

      <nav className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <p className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Contents</p>
        <div className="grid grid-cols-2 gap-1">
          {sections.map((section) => (
            <a
              key={section.title}
              href={`#${section.title.toLowerCase().replace(/\s+/g, "-")}`}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              {section.title}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-12">
        {sections.map((section) => (
          <section key={section.title} id={section.title.toLowerCase().replace(/\s+/g, "-")}>
            <h2 className="text-xl font-semibold mb-6 pb-2 border-b border-zinc-800">{section.title}</h2>
            <div className="space-y-6">
              {section.content.map((item) => (
                <div key={item.heading}>
                  <h3 className="text-sm font-semibold text-zinc-300 mb-2">{item.heading}</h3>
                  {"text" in item && item.text && (
                    <p className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line">{item.text}</p>
                  )}
                  {"code" in item && item.code && (
                    <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-300 overflow-x-auto mt-2">
                      <code>{item.code}</code>
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
