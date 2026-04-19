import type { Metadata } from "next";
import Link from "next/link";
import { PublicNav } from "../../components/public-nav";

export const metadata: Metadata = {
  title: "Enterprise Data Handling Addendum — Provara",
  description:
    "Contractual data-handling commitments for Provara Enterprise customers: routing signal isolation, pool contribution opt-in, audit logs, deletion on termination.",
};

export default function EnterpriseDataHandlingPage() {
  return (
    <>
      <PublicNav />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-400 mb-4">
          Contractual Addendum
        </p>
        <h1 className="text-3xl font-bold mb-2">Enterprise Data Handling Addendum</h1>
        <p className="text-sm text-zinc-500 mb-10">Effective April 18, 2026</p>

        <div className="prose prose-invert prose-sm prose-zinc max-w-none space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-3">Purpose</h2>
            <p className="text-zinc-400 leading-relaxed">
              This addendum is a contractual companion to the{" "}
              <Link href="/privacy" className="text-blue-400 hover:text-blue-300">
                Provara Privacy Policy
              </Link>
              . It codifies the data-handling commitments CoreLumen, LLC makes to Provara Enterprise customers regarding the adaptive routing signal. Where this addendum and the Privacy Policy overlap, this addendum governs for Enterprise customers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Scope</h2>
            <p className="text-zinc-400 leading-relaxed">
              This addendum governs the tenant-scoped storage, use, and isolation of quality signal derived from your traffic — specifically the <code className="text-zinc-300">model_scores</code>, <code className="text-zinc-300">regression_events</code>, and <code className="text-zinc-300">cost_migrations</code> tables, and any derived in-memory state used by the router. It does not modify the Privacy Policy&apos;s treatment of prompts, responses, API keys, or account data.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Isolation defaults</h2>
            <p className="text-zinc-400 leading-relaxed">
              For Enterprise tenants, the following are the default, contractually-bound settings. They remain in force unless explicitly opted out through the dashboard toggles or a written request from an authorized representative of the customer.
            </p>
            <ul className="list-disc list-inside text-zinc-400 space-y-2 mt-3">
              <li>
                <strong>Isolated reads.</strong> The router consults only your tenant&apos;s routing matrix when picking a model. It does not fall back to the shared pool.
              </li>
              <li>
                <strong>Isolated writes.</strong> Quality scores derived from your traffic update only your tenant&apos;s routing matrix. Your ratings do not contribute to the shared pool.
              </li>
              <li>
                <strong>Isolated regression and cost-migration cycles.</strong> Silent-regression detection and cost-migration cycles scoped to your tenant&apos;s history; their outputs do not leak across tenant boundaries.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Opt-in pool interactions</h2>
            <p className="text-zinc-400 leading-relaxed">
              Two per-tenant toggles are available in the dashboard Routing settings. Both default to off for Enterprise tenants.
            </p>
            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Use pooled routing signal (read)</h3>
            <p className="text-zinc-400 leading-relaxed">
              When on, the router consults the shared pool as a fallback for cells where your tenant&apos;s matrix is empty or sparse. Pool data is consulted at decision time only and is <strong>never copied into your tenant&apos;s matrix</strong>. Turning the toggle off is instant: subsequent routing decisions use only your tenant&apos;s data.
            </p>
            <h3 className="text-sm font-semibold text-zinc-300 mt-4 mb-2">Contribute ratings to pooled signal (write)</h3>
            <p className="text-zinc-400 leading-relaxed">
              When on, your ratings update the shared pool in addition to your tenant&apos;s matrix.
            </p>
            <p className="text-amber-300/90 leading-relaxed mt-3">
              <strong>Irreversibility.</strong> Contributions to the shared pool merge into an exponentially-weighted moving average and cannot be retroactively removed. Turning this toggle off stops future contributions; past contributions remain in the pool. For Enterprise customers with compliance or data-lineage requirements, we recommend leaving this toggle off from day one.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Audit log</h2>
            <p className="text-zinc-400 leading-relaxed">
              Every change to your routing isolation toggles is recorded in an append-only audit log with a timestamp, the actor who made the change, the previous value, and the new value. Upon written request to{" "}
              <a href="mailto:privacy@corelumen.io" className="text-blue-400 hover:text-blue-300">privacy@corelumen.io</a>
              , we will provide a report of toggle changes for your tenant within ten business days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Deletion on termination</h2>
            <p className="text-zinc-400 leading-relaxed">
              On termination of an Enterprise agreement, and upon written confirmation from an authorized representative, CoreLumen will delete your tenant&apos;s routing data — the tenant-scoped rows in <code className="text-zinc-300">model_scores</code>, <code className="text-zinc-300">regression_events</code>, and <code className="text-zinc-300">cost_migrations</code>, along with any in-memory derivatives — within thirty days.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              If your tenant was opted in to pool contributions at any time during the agreement, contributions made during that window cannot be individually extracted from the shared pool, as described above.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Data residency</h2>
            <p className="text-zinc-400 leading-relaxed">
              The Provara managed service and its adaptive-routing data are hosted in the United States. Additional region commitments are available under separate written arrangement.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Subprocessors</h2>
            <p className="text-zinc-400 leading-relaxed">
              Adaptive routing data is processed only by the Provara gateway and database infrastructure operated by CoreLumen. It is not disclosed to, or made available to, any third party for any purpose.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Contact</h2>
            <p className="text-zinc-400 leading-relaxed">
              For questions about this addendum or to exercise any right described above, contact{" "}
              <a href="mailto:legal@corelumen.io" className="text-blue-400 hover:text-blue-300">legal@corelumen.io</a>
              .
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">Changes</h2>
            <p className="text-zinc-400 leading-relaxed">
              Material changes to this addendum will be communicated to Enterprise customers at least thirty days before taking effect. Prior versions remain in force for contracts executed under them until the customer opts in to the new version.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
