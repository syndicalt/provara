"use client";

import { useEffect, useState } from "react";
import { formatCost, formatNumber, formatLatency } from "../../../lib/format";
import { gatewayFetchRaw } from "../../../lib/gateway-client";

interface Token {
  id: string;
  name: string;
  tenant: string;
  tokenPrefix: string;
  rateLimit: number | null;
  spendLimit: number | null;
  spendPeriod: string | null;
  routingProfile: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface TokenUsage {
  totalCost: number;
  totalRequests: number;
  avgLatency: number;
  currentPeriodCost: number;
  currentPeriod: string;
}

interface TenantUsage {
  tenant: string | null;
  totalCost: number;
  requestCount: number;
}

function CreateTokenForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tenant, setTenant] = useState("");
  const [rateLimit, setRateLimit] = useState("");
  const [spendLimit, setSpendLimit] = useState("");
  const [spendPeriod, setSpendPeriod] = useState("monthly");
  const [routingProfile, setRoutingProfile] = useState("balanced");
  const [submitting, setSubmitting] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await gatewayFetchRaw("/v1/admin/tokens", {
        method: "POST",
        body: JSON.stringify({
          name,
          tenant,
          rateLimit: rateLimit ? parseInt(rateLimit) : undefined,
          spendLimit: spendLimit ? parseFloat(spendLimit) : undefined,
          spendPeriod,
          routingProfile,
        }),
      });
      const data = await res.json();
      if (data.plainToken) {
        setCreatedToken(data.plainToken);
      }
      onCreated();
    } catch (err) {
      console.error("Failed to create token:", err);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCopy() {
    if (createdToken) {
      navigator.clipboard.writeText(createdToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleDone() {
    setCreatedToken(null);
    setName("");
    setTenant("");
    setRateLimit("");
    setSpendLimit("");
    setOpen(false);
  }

  // Show created token
  if (createdToken) {
    return (
      <div className="bg-zinc-900 border border-emerald-800 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <h3 className="text-lg font-semibold text-emerald-300">Token Created</h3>
        </div>
        <p className="text-sm text-amber-300">
          Copy this token now. You won't be able to see it again.
        </p>
        <div className="flex gap-2">
          <code className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono break-all">
            {createdToken}
          </code>
          <button
            onClick={handleCopy}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium shrink-0"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <button
          onClick={handleDone}
          className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm"
        >
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
      >
        Create Token
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Create API Token</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. Production App"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Tenant</label>
          <input
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            required
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. my-app"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Rate Limit (RPM)</label>
          <input
            type="number"
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="Unlimited"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Spend Limit (USD)</label>
          <input
            type="number"
            step="0.01"
            value={spendLimit}
            onChange={(e) => setSpendLimit(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="Unlimited"
          />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Billing Period</label>
          <select
            value={spendPeriod}
            onChange={(e) => setSpendPeriod(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Routing Profile</label>
          <select
            value={routingProfile}
            onChange={(e) => setRoutingProfile(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="cost">Cost (70% cost, 30% quality)</option>
            <option value="balanced">Balanced (50/50)</option>
            <option value="quality">Quality (80% quality, 20% cost)</option>
          </select>
        </div>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
      >
        {submitting ? "Creating..." : "Create Token"}
      </button>
    </form>
  );
}

function TokenCard({ token, onDelete }: { token: Token; onDelete: () => void }) {
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expanded) {
      gatewayFetchRaw(`/v1/admin/tokens/${token.id}`)
        .then((r) => r.json())
        .then((d) => setUsage(d.usage))
        .catch(() => {});
    }
  }, [expanded, token.id]);

  async function handleDelete() {
    if (!confirm(`Revoke token "${token.name}"? This cannot be undone.`)) return;
    await gatewayFetchRaw(`/v1/admin/tokens/${token.id}`, { method: "DELETE" });
    onDelete();
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-800/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <code className="text-xs text-zinc-500 font-mono">{token.tokenPrefix}••••</code>
          <span className="font-medium">{token.name}</span>
          <span className="text-xs text-zinc-500">({token.tenant})</span>
        </div>
        <div className="flex items-center gap-3">
          {token.routingProfile && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800/50 capitalize">{token.routingProfile}</span>
          )}
          {token.rateLimit && (
            <span className="text-xs text-zinc-500">{token.rateLimit} RPM</span>
          )}
          {token.spendLimit && (
            <span className="text-xs text-zinc-500">{formatCost(token.spendLimit)}/{token.spendPeriod}</span>
          )}
          <span className="text-zinc-500 text-sm">{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-4 space-y-4">
          {usage && (
            <div className="grid grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-zinc-500">Total Requests</p>
                <p className="text-lg font-semibold">{formatNumber(usage.totalRequests)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Total Cost</p>
                <p className="text-lg font-semibold">{formatCost(usage.totalCost)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Avg Latency</p>
                <p className="text-lg font-semibold">{formatLatency(usage.avgLatency)}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">Current Period</p>
                <p className="text-lg font-semibold">
                  {formatCost(usage.currentPeriodCost)}
                  {token.spendLimit && (
                    <span className="text-xs text-zinc-500"> / {formatCost(token.spendLimit)}</span>
                  )}
                </p>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              className="px-3 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded text-xs"
            >
              Revoke Token
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TokensPage() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [tenantUsage, setTenantUsage] = useState<TenantUsage[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    try {
      const [tokensRes, usageRes] = await Promise.all([
        gatewayFetchRaw("/v1/admin/tokens"),
        gatewayFetchRaw("/v1/admin/tokens/usage/by-tenant"),
      ]);
      const tokensData = await tokensRes.json();
      const usageData = await usageRes.json();
      setTokens(tokensData.tokens || []);
      setTenantUsage(usageData.tenants || []);
    } catch (err) {
      console.error("Failed to fetch tokens:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading tokens...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">API Tokens</h1>
        <CreateTokenForm onCreated={fetchData} />
      </div>

      {/* Auth Mode Indicator */}
      <div className={`rounded-lg p-3 text-sm ${tokens.length === 0 ? "bg-amber-900/30 border border-amber-800 text-amber-300" : "bg-emerald-900/30 border border-emerald-800 text-emerald-300"}`}>
        {tokens.length === 0
          ? "Open mode — no tokens created. All API requests are allowed without authentication."
          : `Auth enabled — ${tokens.length} token${tokens.length > 1 ? "s" : ""} active. API requests require a valid Bearer token.`}
      </div>

      {/* Per-Tenant Usage */}
      {tenantUsage.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Usage by Tenant</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                  <th className="px-4 py-3">Tenant</th>
                  <th className="px-4 py-3 text-right">Requests</th>
                  <th className="px-4 py-3 text-right">Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {tenantUsage.map((t) => (
                  <tr key={t.tenant || "none"} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-4 py-3">{t.tenant || "(no tenant)"}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(t.requestCount)}</td>
                    <td className="px-4 py-3 text-right">{formatCost(t.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Token List */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Tokens</h2>
        {tokens.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No API tokens yet. Create one to enable authentication.</p>
            <p className="text-sm text-zinc-500 mt-1">
              The gateway runs in open mode until the first token is created.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {tokens.map((token) => (
              <TokenCard key={token.id} token={token} onDelete={fetchData} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
