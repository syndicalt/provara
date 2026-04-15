"use client";

import Link from "next/link";
import { PublicNav } from "../components/public-nav";

const codeSnippet = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://your-provara.example/v1",
  apiKey: "your-provara-token",
});

const response = await client.chat.completions.create({
  model: "gpt-4o", // or any model from any provider
  messages: [{ role: "user", content: "Hello!" }],
});`;

const features = [
  {
    title: "Intelligent Routing",
    description:
      "Automatically route requests to the best model based on task type, complexity, and quality scores. No manual rules needed.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    title: "Observability",
    description:
      "Real-time analytics with cost breakdown by provider, latency percentiles (p50/p95/p99), request volume charts, and model comparison tables.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
      </svg>
    ),
  },
  {
    title: "A/B Testing",
    description:
      "Compare models side-by-side with weighted traffic splitting. Measure latency, cost, and quality across real production traffic.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
      </svg>
    ),
  },
  {
    title: "Cost Optimization",
    description:
      "Route simple queries to cheaper models, complex ones to premium models. Adaptive scoring learns from real quality feedback.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    title: "Prompt Management",
    description:
      "Version, publish, and deploy prompt templates from the dashboard. Use variables for dynamic content. Resolve by name via API.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
  {
    title: "Self-Hosted",
    description:
      "Your data stays on your infrastructure. Deploy anywhere with Docker. No vendor lock-in, no data leaving your network.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
      </svg>
    ),
  },
];

const providerLogos: Record<string, React.ReactNode> = {
  OpenAI: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  ),
  Anthropic: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M17.304 3.541h-3.48l6.15 16.918h3.48zm-10.56 0L.594 20.459h3.55l1.272-3.63h6.478l1.272 3.63h3.55L10.567 3.54zm-.463 10.264 2.063-5.893 2.064 5.893z" />
    </svg>
  ),
  Google: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053z" />
    </svg>
  ),
  Mistral: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M3.2 0h4.267v4.267H3.2zM16.533 0H20.8v4.267h-4.267zM3.2 4.267h4.267v4.266H3.2zm4.267 0h4.266v4.266H7.467zM16.533 4.267H20.8v4.266h-4.267zm-4.266 0h4.266v4.266h-4.266zM3.2 8.533h4.267V12.8H3.2zm4.267 0h4.266V12.8H7.467zm4.266 0h4.267V12.8h-4.267zm4.8 0H20.8V12.8h-4.267zM3.2 12.8h4.267v4.267H3.2zm4.267 0h4.266v4.267H7.467zM16.533 12.8H20.8v4.267h-4.267zm-4.266 0h4.266v4.267h-4.266zM3.2 17.067h4.267v4.266H3.2zM16.533 17.067H20.8v4.266h-4.267z" />
    </svg>
  ),
  xAI: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="m1.477 20.543 8.42-12.157L1.81 3.457h2.83l6.42 8.015 6.42-8.015h2.83l-8.088 4.929 8.42 12.157h-2.83L11.06 12.1l-6.753 8.443z" />
    </svg>
  ),
  Ollama: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 1.5c4.687 0 8.5 3.813 8.5 8.5s-3.813 8.5-8.5 8.5S3.5 16.687 3.5 12 7.313 3.5 12 3.5zm-2.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-5.5 4.5s1 2 3 2 3-2 3-2" strokeWidth="1" stroke="currentColor" fill="none" />
    </svg>
  ),
  Groq: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 2.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zm0 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
    </svg>
  ),
  "Together AI": (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
      <path d="M7 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm10 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM7 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm10 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
    </svg>
  ),
};

const providers = ["OpenAI", "Anthropic", "Google", "Mistral", "xAI", "Ollama", "Groq", "Together AI"];

export default function Home() {
  return (
    <>
      <PublicNav />
      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-950/20 to-transparent" />
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-20 relative">
            <div className="text-center max-w-3xl mx-auto">
              <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-tight">
                The Intelligent Gateway
                <br />
                <span className="text-blue-400">for LLMs</span>
              </h1>
              <p className="mt-6 text-lg text-zinc-400 leading-relaxed">
                Route requests across providers, optimize costs with adaptive routing,
                and compare models with built-in A/B testing.
                OpenAI-compatible API — works with any existing SDK.
              </p>
              <div className="mt-10 flex gap-4 justify-center">
                <Link
                  href="/login"
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"
                >
                  Get Started
                </Link>
                <Link
                  href="/models"
                  className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg font-medium transition-colors"
                >
                  Explore Models
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Provider logos */}
        <section className="border-y border-zinc-800/50 bg-zinc-900/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <p className="text-center text-xs text-zinc-500 uppercase tracking-widest mb-6">
              Unified access to leading providers
            </p>
            <div className="flex justify-center gap-10 flex-wrap">
              {providers.map((name) => (
                <div key={name} className="flex items-center gap-2 text-zinc-500">
                  {providerLogos[name]}
                  <span className="text-sm font-medium">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold">More than a proxy</h2>
            <p className="mt-4 text-zinc-400 max-w-2xl mx-auto">
              Provara doesn't just forward requests. It learns which models perform best,
              tracks every request, and gives you the tools to optimize quality, cost, and latency.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 hover:border-zinc-700 transition-colors"
              >
                <div className="w-10 h-10 rounded-lg bg-blue-600/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-4">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="border-y border-zinc-800/50 bg-zinc-900/20">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
            <div className="text-center mb-16">
              <h2 className="text-3xl font-bold">Get started in minutes</h2>
              <p className="mt-4 text-zinc-400">Three steps to intelligent LLM routing.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-0 relative">
              {/* Connector lines (desktop only) */}
              <div className="hidden md:block absolute top-10 left-1/6 right-1/6 h-px bg-gradient-to-r from-blue-600/0 via-blue-600/40 to-blue-600/0" />

              {/* Step 1 */}
              <div className="text-center px-6 relative">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-700 text-white flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-600/20">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-2">Sign up or self-host</h3>
                <p className="text-sm text-zinc-400 mb-4">Create an account with Google or GitHub, or deploy with Docker.</p>
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-left inline-block">
                  <code className="text-xs text-zinc-400">
                    <span className="text-zinc-600">$</span> docker compose up -d
                  </code>
                </div>
              </div>

              {/* Step 2 */}
              <div className="text-center px-6 relative mt-8 md:mt-0">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-600 to-violet-700 text-white flex items-center justify-center mx-auto mb-6 shadow-lg shadow-violet-600/20">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-2">Add your API keys</h3>
                <p className="text-sm text-zinc-400 mb-4">Connect any provider through the dashboard. Keys are encrypted at rest.</p>
                <div className="flex justify-center gap-2 flex-wrap">
                  {["OpenAI", "Anthropic", "Google", "Mistral"].map((p) => (
                    <span key={p} className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400">{p}</span>
                  ))}
                  <span className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-500">+4 more</span>
                </div>
              </div>

              {/* Step 3 */}
              <div className="text-center px-6 relative mt-8 md:mt-0">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 text-white flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-600/20">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold mb-2">Route requests</h3>
                <p className="text-sm text-zinc-400 mb-4">Point your app at Provara. Drop-in OpenAI SDK compatible.</p>
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-left inline-block">
                  <code className="text-xs text-zinc-400">
                    baseURL: <span className="text-emerald-400">&quot;https://provara/v1&quot;</span>
                  </code>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Code snippet */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4">Drop-in compatible</h2>
              <p className="text-zinc-400 mb-6 leading-relaxed">
                Provara exposes an OpenAI-compatible API. Change two lines in your existing
                code — the base URL and the API key — and you're routing through Provara.
              </p>
              <p className="text-zinc-400 leading-relaxed">
                Works with the OpenAI SDK, LangChain, LlamaIndex, and any tool that speaks
                the OpenAI chat completions format.
              </p>
            </div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <span className="ml-2 text-xs text-zinc-500">app.ts</span>
              </div>
              <pre className="p-4 text-sm text-zinc-300 overflow-x-auto leading-relaxed">
                <code>{codeSnippet}</code>
              </pre>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-zinc-800/50">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24 text-center">
            <h2 className="text-3xl font-bold mb-4">Ready to optimize your LLM stack?</h2>
            <p className="text-zinc-400 mb-8 max-w-xl mx-auto">
              Start routing requests intelligently. Self-host for free or sign up for managed hosting.
            </p>
            <div className="flex gap-4 justify-center">
              <Link
                href="/login"
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium transition-colors"
              >
                Get Started
              </Link>
              <a
                href="https://github.com/syndicalt/provara"
                target="_blank"
                rel="noopener noreferrer"
                className="px-6 py-3 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg font-medium transition-colors"
              >
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-zinc-800/50 bg-zinc-900/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="flex justify-between items-center text-sm text-zinc-500">
              <span>Provara</span>
              <div className="flex gap-6">
                <a href="https://github.com/syndicalt/provara" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300 transition-colors">
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}
