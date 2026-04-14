import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <div className="max-w-3xl text-center space-y-6">
        <h1 className="text-5xl font-bold tracking-tight">Provara</h1>
        <p className="text-xl text-zinc-400">
          Multi-provider LLM gateway for cost optimization and A/B testing.
        </p>
        <div className="grid grid-cols-3 gap-4 pt-4">
          <Link
            href="/dashboard"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-zinc-600 transition-colors"
          >
            <h2 className="text-lg font-semibold mb-2">Dashboard</h2>
            <p className="text-sm text-zinc-400">
              Request logs, cost analytics, and routing stats
            </p>
          </Link>
          <Link
            href="/dashboard/routing"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-zinc-600 transition-colors"
          >
            <h2 className="text-lg font-semibold mb-2">Routing</h2>
            <p className="text-sm text-zinc-400">
              Intelligent model routing by task type and complexity
            </p>
          </Link>
          <Link
            href="/dashboard/ab-tests"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-zinc-600 transition-colors"
          >
            <h2 className="text-lg font-semibold mb-2">A/B Tests</h2>
            <p className="text-sm text-zinc-400">
              Compare models side-by-side with weighted routing
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}
