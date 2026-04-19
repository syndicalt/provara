import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col justify-center items-center text-center px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight sm:text-5xl max-w-3xl">
        The self-hostable LLM operations platform
      </h1>
      <p className="mt-5 text-lg text-fd-muted-foreground max-w-2xl">
        Adaptive routing from real judge scores. Silent-regression detection.
        Auto cost migration with rollback. Per-user spend intelligence. One
        OpenAI-compatible endpoint, deployed however you want.
      </p>
      <div className="mt-8 flex gap-3 flex-wrap justify-center">
        <Link
          href="/docs"
          className="inline-flex items-center rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Open the docs →
        </Link>
        <Link
          href="/docs/getting-started/quick-start"
          className="inline-flex items-center rounded-md border border-fd-border px-5 py-2.5 text-sm font-medium hover:bg-fd-muted"
        >
          Quick start
        </Link>
        <a
          href="https://github.com/syndicalt/provara"
          className="inline-flex items-center rounded-md border border-fd-border px-5 py-2.5 text-sm font-medium hover:bg-fd-muted"
        >
          GitHub
        </a>
      </div>
    </main>
  );
}
