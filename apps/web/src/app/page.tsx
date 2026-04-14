export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-5xl font-bold tracking-tight">Provara</h1>
        <p className="text-xl text-zinc-400">
          Multi-provider LLM gateway for cost optimization and A/B testing.
        </p>
        <div className="flex gap-4 justify-center pt-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex-1">
            <h2 className="text-lg font-semibold mb-2">Gateway</h2>
            <p className="text-sm text-zinc-400">
              OpenAI-compatible proxy running on port 4000
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex-1">
            <h2 className="text-lg font-semibold mb-2">Providers</h2>
            <p className="text-sm text-zinc-400">
              OpenAI, Anthropic, Google, Mistral, xAI, Ollama
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex-1">
            <h2 className="text-lg font-semibold mb-2">A/B Testing</h2>
            <p className="text-sm text-zinc-400">
              Compare models side-by-side with weighted routing
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
