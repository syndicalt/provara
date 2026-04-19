import { PublicNav } from "../../components/public-nav";

export default function TermsPage() {
  return (
    <>
      <PublicNav />
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: April 17, 2026</p>

        <div className="prose prose-invert prose-sm prose-zinc max-w-none space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-3">1. What Provara Is</h2>
            <p className="text-zinc-400 leading-relaxed">
              Provara is an LLM gateway service that routes requests to third-party AI providers. We provide the routing, analytics, and management layer. We do not provide the underlying AI models — you bring your own API keys (BYOK) and are responsible for your relationship with each provider.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              The Provara managed service is operated by <strong>CoreLumen, LLC</strong> ("CoreLumen," "we," "us," "our"). References to "Provara" in these terms mean the managed service at provara.xyz operated by CoreLumen, LLC. Self-hosted deployments of the open-source code are covered separately — see Section 9.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">2. Account Eligibility</h2>
            <p className="text-zinc-400 leading-relaxed">
              You must be at least 18 years old to use Provara. By creating an account, you represent that the information you provide is accurate and that you have the authority to accept these terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">3. Your API Keys and Provider Costs</h2>
            <p className="text-zinc-400 leading-relaxed">
              You are solely responsible for any costs incurred with third-party AI providers (OpenAI, Anthropic, Google, etc.) through your API keys. Provara routes requests on your behalf but does not control or assume liability for provider charges, rate limits, or terms of service violations with those providers.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              You are responsible for safeguarding your API keys. While we encrypt keys at rest, you should rotate keys if you believe they have been compromised.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">4. Acceptable Use</h2>
            <p className="text-zinc-400 leading-relaxed">You agree not to:</p>
            <ul className="list-disc list-inside text-zinc-400 space-y-2 mt-2">
              <li>Use the service to violate any law or regulation</li>
              <li>Attempt to gain unauthorized access to other users' data or accounts</li>
              <li>Use the service to generate content that is illegal, harmful, or violates third-party rights</li>
              <li>Circumvent rate limits, spend limits, or other safeguards</li>
              <li>Reverse-engineer, decompile, or attempt to extract the source code of the managed service (the open-source version is freely available under its license)</li>
              <li>Resell access to the service without written permission</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">5. Service Availability</h2>
            <p className="text-zinc-400 leading-relaxed">
              Provara is provided on an "as-is" and "as-available" basis. We do not guarantee any specific uptime, latency, or availability. The service may be interrupted for maintenance, updates, or circumstances beyond our control. For guaranteed availability, consider self-hosting.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">6. Data and Content</h2>
            <p className="text-zinc-400 leading-relaxed">
              You retain ownership of all content you send through Provara, including prompts, responses, and any data generated through your use of the service. We do not claim ownership of your content.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              We store request data (prompts, responses, metadata) to provide service features such as request logs, analytics, quality scoring, and adaptive routing. See our Privacy Policy for details.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">7. Account Termination</h2>
            <p className="text-zinc-400 leading-relaxed">
              You may delete your account at any time. We reserve the right to suspend or terminate accounts that violate these terms or engage in abusive behavior. Upon termination, your data will be deleted in accordance with our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">8. Limitation of Liability</h2>
            <p className="text-zinc-400 leading-relaxed">
              To the maximum extent permitted by law, CoreLumen, LLC and its affiliates, officers, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of profits, data, or business opportunities, arising from your use of the service.
            </p>
            <p className="text-zinc-400 leading-relaxed mt-3">
              Our total liability for any claim arising from or related to the service shall not exceed the amount you paid to CoreLumen, LLC in the 12 months preceding the claim, or $100, whichever is greater.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">9. Open Source</h2>
            <p className="text-zinc-400 leading-relaxed">
              Provara's source code is available under the MIT License at{" "}
              <a href="https://github.com/syndicalt/provara" className="text-blue-400 hover:text-blue-300" target="_blank" rel="noopener noreferrer">
                github.com/syndicalt/provara
              </a>. Self-hosted deployments are governed by the MIT License, not these Terms of Service. These terms apply only to the managed service at provara.xyz.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">10. Changes to Terms</h2>
            <p className="text-zinc-400 leading-relaxed">
              We may update these terms as the service evolves. Significant changes will be communicated through the dashboard or via email. Continued use of the service after changes constitutes acceptance of the updated terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">11. Contact</h2>
            <p className="text-zinc-400 leading-relaxed">
              Questions about these terms? Contact CoreLumen, LLC at{" "}
              <a href="mailto:legal@corelumen.io" className="text-blue-400 hover:text-blue-300">legal@corelumen.io</a>.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
