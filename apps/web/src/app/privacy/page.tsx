import Link from "next/link";
import { PublicNav } from "../../components/public-nav";

export default function PrivacyPage() {
  return (
    <>
      <PublicNav />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: April 18, 2026</p>

        <div className="prose prose-invert prose-sm prose-zinc max-w-none space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-3">Overview</h2>
            <p className="text-zinc-400 leading-relaxed">
              Provara is an LLM gateway that routes requests to AI providers on your behalf. We take your privacy seriously. This policy explains what data we collect, how we use it, and your rights regarding that data.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              The Provara managed service is operated by <strong>CoreLumen, LLC</strong> ("CoreLumen," "we," "us," "our"), which is the data controller for information collected through provara.xyz.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              <strong className="text-zinc-300">Self-hosted users:</strong> If you deploy Provara on your own infrastructure, your data never touches our servers. This policy applies only to users of the managed service at provara.xyz.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Data We Collect</h2>

            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Account Information</h3>
            <p className="text-zinc-400 leading-relaxed">
              When you sign in with Google or GitHub, we receive and store your name, email address, and profile photo URL. We use this to identify your account and display your profile in the dashboard.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">API Keys</h3>
            <p className="text-zinc-400 leading-relaxed">
              Provider API keys you add through the dashboard are encrypted at rest using AES-256-GCM. We decrypt them only at runtime to forward requests to the providers you configured. We cannot view your plaintext keys.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Request Data</h3>
            <p className="text-zinc-400 leading-relaxed">
              When you send requests through the gateway, we log metadata including: provider, model, token counts, latency, cost, task classification, and routing decisions. We also store the prompt and response content to power features like request replay and the LLM-as-judge quality scoring.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Usage Data</h3>
            <p className="text-zinc-400 leading-relaxed">
              We track aggregate usage metrics (request counts, costs, latency) to power the analytics dashboard. This data is scoped to your tenant and not shared with other users.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">How We Use Your Data</h2>
            <ul className="list-disc list-inside text-zinc-400 space-y-2">
              <li>To authenticate you and provide access to the dashboard</li>
              <li>To route your LLM requests to the providers you configured</li>
              <li>To display analytics, logs, and quality metrics in your dashboard</li>
              <li>To power adaptive routing (learning which models perform best for your workloads)</li>
              <li>To enforce guardrails, rate limits, and spend limits you configured</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">What We Don't Do</h2>
            <ul className="list-disc list-inside text-zinc-400 space-y-2">
              <li>We do not sell your data to third parties</li>
              <li>We do not use your prompts or responses to train AI models</li>
              <li>We do not share your prompts, responses, or API keys with other Provara users</li>
              <li>We do not collect telemetry or analytics from self-hosted instances</li>
              <li>We do not access your provider API keys in plaintext</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Adaptive Routing Signal</h2>
            <p className="text-zinc-400 leading-relaxed">
              Provara&apos;s adaptive router learns from quality scores — user ratings you submit and optional LLM-judge scores — to pick the best model for each task type. How those scores flow depends on your subscription tier.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-5 mb-2">What is the shared routing pool?</h3>
            <p className="text-zinc-400 leading-relaxed">
              The &quot;pool&quot; is a set of aggregate numeric quality scores, one per (task type, complexity, model) cell, maintained as an exponentially-weighted moving average of ratings. Pooling benefits small tenants: they get quality-based routing from day one instead of waiting weeks to accumulate enough ratings on their own traffic.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              <strong className="text-zinc-300">What IS pooled:</strong> numeric quality scores per (task type, complexity, model) cell, and regression-detection signals derived from those scores. Nothing else.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              <strong className="text-zinc-300">What is NOT pooled:</strong> your prompts, responses, API keys, tenant identity, feedback comments, or any personally identifiable information. Scores are aggregated as numbers, never as content.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-5 mb-2">Per-tier defaults</h3>
            <ul className="list-disc list-inside text-zinc-400 space-y-2">
              <li>
                <strong className="text-zinc-300">Free, Pro:</strong> your tenant participates in the shared pool for both reads (your router consults pooled scores) and writes (your ratings update the pool). This is how the free and entry tiers get cold-start routing quality.
              </li>
              <li>
                <strong className="text-zinc-300">Team:</strong> your routing is isolated by default. Your router consults only your tenant&apos;s scores, and your ratings update only your tenant&apos;s matrix. Two opt-in toggles let you consume the pool, contribute to the pool, or both.
              </li>
              <li>
                <strong className="text-zinc-300">Enterprise:</strong> same isolation defaults as Team, backed by contractual commitments. See the{" "}
                <Link href="/enterprise-data-handling" className="text-blue-400 hover:text-blue-300">
                  Enterprise Data Handling Addendum
                </Link>
                .
              </li>
            </ul>

            <h3 className="text-sm font-semibold text-zinc-300 mt-5 mb-2">How the toggles behave</h3>
            <p className="text-zinc-400 leading-relaxed">
              <strong className="text-zinc-300">Use pooled routing signal (read):</strong> when on, the router consults the shared pool as a fallback for cells where your tenant&apos;s matrix is empty or sparse. Pool data is consulted at decision time only and is never copied into your tenant&apos;s matrix. Turning the toggle off is instant — future routing decisions use only your own data.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              <strong className="text-zinc-300">Contribute ratings to pooled signal (write):</strong> when on, your ratings update the shared pool in addition to your tenant&apos;s matrix.{" "}
              <strong className="text-amber-300">Contributions to the pool merge into a statistical model and cannot be retroactively removed.</strong> Turning the toggle off stops future contributions; past contributions remain in the pool. If you need clean data lineage, leave this toggle off from day one.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-5 mb-2">Audit log</h3>
            <p className="text-zinc-400 leading-relaxed">
              Every change to your routing isolation toggles is logged with a timestamp and the actor who made the change. Enterprise customers can request toggle-history reports; see the addendum linked above.
            </p>

            <h3 className="text-sm font-semibold text-zinc-300 mt-5 mb-2">Current rollout</h3>
            <p className="text-zinc-400 leading-relaxed">
              The tier-based isolation described here is being rolled out in stages. The schema and routing engine support tenant-scoped data as of April 18, 2026; the per-tenant toggles and full isolation enforcement ship shortly after. Until the full rollout is complete, the Provara product team will apply the defaults above on your behalf for Team and Enterprise tenants.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Third-Party Providers</h2>
            <p className="text-zinc-400 leading-relaxed">
              When you send a request through Provara, we forward it to the AI provider you configured (OpenAI, Anthropic, Google, etc.). Your prompts and responses are subject to each provider's own privacy policy and terms of service. Provara does not control how providers handle your data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Data Retention</h2>
            <p className="text-zinc-400 leading-relaxed">
              Request logs and analytics data are retained for as long as your account is active. You can request deletion of your account and all associated data by contacting us. API tokens can be revoked at any time through the dashboard.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Security</h2>
            <p className="text-zinc-400 leading-relaxed">
              API keys are encrypted with AES-256-GCM. Authentication uses OAuth 2.0 via Google and GitHub. Sessions are stored server-side with secure, HTTP-only cookies. All traffic is encrypted in transit via TLS.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Your Rights</h2>
            <p className="text-zinc-400 leading-relaxed">
              You can access, export, or delete your data at any time. To request data deletion or if you have questions about this policy, contact CoreLumen, LLC at{" "}
              <a href="mailto:privacy@provara.xyz" className="text-blue-400 hover:text-blue-300">privacy@provara.xyz</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Changes</h2>
            <p className="text-zinc-400 leading-relaxed">
              We may update this policy as the product evolves. Significant changes will be communicated through the dashboard or via email. Continued use of the service after changes constitutes acceptance of the updated policy.
            </p>
            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Changelog</h3>
            <ul className="list-disc list-inside text-zinc-400 space-y-1 text-sm">
              <li>
                <strong className="text-zinc-300">April 18, 2026:</strong> Rewrote the Adaptive Routing Signal section to describe per-tier defaults, the read/write toggle split, the irreversibility of pool contributions, and the audit log. Published the Enterprise Data Handling Addendum.
              </li>
              <li>
                <strong className="text-zinc-300">April 17, 2026:</strong> Initial publication.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
