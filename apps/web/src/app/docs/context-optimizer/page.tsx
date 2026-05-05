import type { Metadata } from "next";
import Link from "next/link";
import { PublicNav } from "../../../components/public-nav";

export const metadata: Metadata = {
  title: "Context Optimizer Docs - Provara",
  description:
    "Human-readable guide to Provara Context Optimizer: runtime optimization, managed collections, connectors, governance, and dashboard workflows.",
};

const runtimeOptions = [
  "Exact and semantic duplicate removal",
  "Lexical or embedding relevance scoring with reranking",
  "Freshness, conflict, risk, and compression controls",
  "Raw-vs-optimized quality evaluation and retrieval analytics",
];

const connectorRows = [
  {
    name: "File upload",
    config: "Text, Markdown, JSON, CSV, and other text files up to 500,000 UTF-8 bytes.",
    sync: "Creates a file_upload source and syncs it into stored documents and blocks.",
  },
  {
    name: "GitHub",
    config: "Owner, repository, branch, path, extensions, file count, file size, and optional token credential.",
    sync: "Fetches selected tree/blob content and skips files whose blob SHA already synced.",
  },
  {
    name: "S3",
    config: "Bucket, region, prefix, extensions, file count, file size, and encrypted AWS credential.",
    sync: "Uses SigV4 ListObjectsV2/GetObject and skips objects whose ETag already synced.",
  },
  {
    name: "Confluence",
    config: "Base URL, space key, labels, title filter, page count, page size, and encrypted API token.",
    sync: "Uses Confluence Cloud content search and skips pages whose version already synced.",
  },
];

const apiGroups = [
  {
    title: "Runtime and visibility",
    endpoints: [
      "POST /v1/context/optimize",
      "GET /v1/context/summary",
      "GET /v1/context/events",
      "POST /v1/context/evaluate",
      "GET /v1/context/quality/summary",
      "GET /v1/context/retrieval/summary",
    ],
  },
  {
    title: "Collections and connectors",
    endpoints: [
      "GET /v1/context/collections",
      "POST /v1/context/collections",
      "POST /v1/context/collections/{id}/documents",
      "GET /v1/context/collections/{id}/sources",
      "POST /v1/context/collections/{id}/sources",
      "POST /v1/context/sources/{id}/sync",
    ],
  },
  {
    title: "Governance",
    endpoints: [
      "POST /v1/context/collections/{id}/distill",
      "GET /v1/context/collections/{id}/canonical-blocks",
      "POST /v1/context/canonical-blocks/{id}/policy-check",
      "PATCH /v1/context/canonical-blocks/{id}/review",
      "GET /v1/context/collections/{id}/export",
    ],
  },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-zinc-800 pt-10">
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">{title}</h2>
      <div className="mt-5 space-y-5 text-sm leading-7 text-zinc-400">{children}</div>
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-xs leading-6 text-zinc-300">
      <code>{children}</code>
    </pre>
  );
}

export default function ContextOptimizerDocsPage() {
  return (
    <>
      <PublicNav />
      <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_240px]">
          <article className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">Documentation</p>
            <h1 className="mt-4 text-4xl font-bold tracking-tight text-zinc-100 sm:text-5xl">
              Context Optimizer
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-8 text-zinc-400">
              Context Optimizer is Provara's optimization and governance layer for retrieved
              context in RAG and agentic systems. It reduces duplicate, stale, risky, and
              low-value context before model routing, then records the savings and quality
              signals for operators.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/docs/api#tag/Context-Optimizer"
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
              >
                Open API Reference
              </Link>
              <Link
                href="/dashboard/context"
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-900"
              >
                Open Dashboard
              </Link>
            </div>

            <div className="mt-12 space-y-12">
              <Section id="scope" title="What Is Shipped">
                <p>
                  The current implementation covers runtime context optimization, managed
                  collections, connector ingestion, canonical block governance, quality
                  evaluation, retrieval analytics, and dashboard visibility.
                </p>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {runtimeOptions.map((item) => (
                    <li key={item} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-zinc-300">
                      {item}
                    </li>
                  ))}
                </ul>
              </Section>

              <Section id="quickstart" title="Runtime Quickstart">
                <p>
                  Send already-retrieved chunks to <code className="text-zinc-200">POST /v1/context/optimize</code>.
                  The response returns retained chunks, dropped chunks, risk buckets, conflict details, and metrics.
                </p>
                <CodeBlock>{`{
  "dedupeMode": "semantic",
  "semanticThreshold": 0.72,
  "rankMode": "embedding",
  "query": "What is the refund window?",
  "freshnessMode": "metadata",
  "conflictMode": "scored",
  "compressionMode": "extractive",
  "scanRisk": true,
  "chunks": [
    {
      "id": "refunds.md#4",
      "content": "Refunds are available within 30 days.",
      "source": "help-center",
      "metadata": { "updatedAt": "2026-04-01T00:00:00.000Z" }
    }
  ]
}`}</CodeBlock>
              </Section>

              <Section id="collections" title="Managed Collections">
                <p>
                  Collections are tenant-scoped containers for reusable context. The dashboard can
                  create the first collection, then file upload and external connector sources bind
                  to that collection. Document ingestion stores deterministic blocks with content
                  hashes, token estimates, source metadata, and collection counters.
                </p>
                <p>
                  Raw document object storage is optional. When the gateway runs with
                  <code className="ml-1 text-zinc-200">DOCUMENT_STORAGE_DRIVER=r2</code>, Provara writes
                  raw document text to Cloudflare R2 before committing searchable rows.
                </p>
              </Section>

              <Section id="connectors" title="Connectors">
                <p>
                  Connector sources start as tenant-scoped records and sync into the same document
                  and block pipeline as manual ingestion. Failed syncs persist status and last error
                  so operators can diagnose credential, storage, rate-limit, or source issues.
                </p>
                <div className="overflow-hidden rounded-lg border border-zinc-800">
                  <table className="min-w-full divide-y divide-zinc-800 text-sm">
                    <thead className="bg-zinc-950 text-left text-xs uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">Connector</th>
                        <th className="px-4 py-3 font-medium">Configuration</th>
                        <th className="px-4 py-3 font-medium">Sync Behavior</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 bg-zinc-900/70">
                      {connectorRows.map((row) => (
                        <tr key={row.name}>
                          <td className="whitespace-nowrap px-4 py-3 font-medium text-zinc-200">{row.name}</td>
                          <td className="px-4 py-3 text-zinc-400">{row.config}</td>
                          <td className="px-4 py-3 text-zinc-400">{row.sync}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section id="credentials" title="Credential Requirements">
                <p>
                  Connector credentials are encrypted tenant-scoped secrets. Credential creation
                  requires <code className="text-zinc-200">PROVARA_MASTER_KEY</code> on the gateway.
                  API and dashboard responses return credential metadata and <code className="text-zinc-200">hasSecret</code>,
                  never raw secret values.
                </p>
                <ul className="list-disc space-y-2 pl-5">
                  <li>GitHub sources can use an optional encrypted GitHub token credential.</li>
                  <li>S3 sources require an encrypted AWS access-key credential.</li>
                  <li>Confluence sources require an encrypted email/API-token credential.</li>
                </ul>
              </Section>

              <Section id="governance" title="Canonical Governance">
                <p>
                  Stored blocks can be distilled into canonical context blocks. Canonical blocks
                  start as drafts, preserve source block and document IDs, and export only after
                  review approval.
                </p>
                <p>
                  Policy checks run active Guardrails rules against canonical content before
                  approval. Blocking or quarantine decisions persist evidence and prevent approval
                  until the block is fixed or rejected.
                </p>
              </Section>

              <Section id="dashboard" title="Dashboard Workflow">
                <p>
                  The dashboard at <code className="text-zinc-200">/dashboard/context</code> shows
                  optimizer metrics, quality and retrieval analytics, managed collections, connector
                  credentials, connector source creation, source sync status, canonical review, and
                  policy-check actions.
                </p>
                <p>
                  For a fresh tenant, create a managed collection first. File upload and GitHub
                  source buttons stay disabled until a collection exists and the required source
                  fields are filled.
                </p>
              </Section>

              <Section id="api" title="API Surface">
                <p>
                  The generated API reference is the source of truth for request and response
                  schemas. The human guide groups the most important endpoints below.
                </p>
                <div className="grid gap-4 md:grid-cols-3">
                  {apiGroups.map((group) => (
                    <div key={group.title} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                      <h3 className="font-medium text-zinc-200">{group.title}</h3>
                      <ul className="mt-3 space-y-2 text-xs text-zinc-400">
                        {group.endpoints.map((endpoint) => (
                          <li key={endpoint}>
                            <code>{endpoint}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Section>

              <Section id="roadmap" title="What Comes Later">
                <p>
                  The shipped scope does not yet include Google Drive, SharePoint, Notion, Zendesk,
                  Intercom, permission-aware connectors, managed vector export, retrieval A/B tests,
                  or a full context policy engine. Those remain roadmap layers.
                </p>
              </Section>
            </div>
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-2 text-sm">
              {[
                ["scope", "What is shipped"],
                ["quickstart", "Quickstart"],
                ["collections", "Collections"],
                ["connectors", "Connectors"],
                ["credentials", "Credentials"],
                ["governance", "Governance"],
                ["dashboard", "Dashboard"],
                ["api", "API surface"],
                ["roadmap", "Roadmap"],
              ].map(([id, label]) => (
                <a key={id} href={`#${id}`} className="block rounded px-3 py-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
                  {label}
                </a>
              ))}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
