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
    title: "A/B Testing",
    description:
      "Compare models side-by-side with weighted traffic splitting. Measure latency, cost, and quality across real production traffic.",
    icon: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
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
            <div className="flex justify-center gap-8 flex-wrap">
              {providers.map((name) => (
                <span key={name} className="text-sm text-zinc-500 font-medium">
                  {name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold">More than a proxy</h2>
            <p className="mt-4 text-zinc-400 max-w-2xl mx-auto">
              Provara doesn't just forward requests. It learns which models perform best
              for each task type and adapts routing automatically.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
