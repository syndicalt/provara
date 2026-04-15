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
  enabled: boolean;
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
  const [customWeights, setCustomWeights] = useState({ quality: 40, cost: 40, latency: 20 });
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
          ...(routingProfile === "custom" ? {
            routingWeights: {
              quality: customWeights.quality / 100,
              cost: customWeights.cost / 100,
              latency: customWeights.latency / 100,
            },
          } : {}),
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
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 space-y-2">
          <p className="text-xs text-zinc-400">Point your app at Provara:</p>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-zinc-500">Base URL</span>
              <code className="block mt-1 text-zinc-300 font-mono">https://gateway.provara.xyz/v1</code>
            </div>
            <div>
              <span className="text-zinc-500">API Key</span>
              <code className="block mt-1 text-zinc-300 font-mono">{createdToken.slice(0, 14)}...</code>
            </div>
          </div>
          <pre className="mt-2 text-[11px] text-zinc-500 font-mono leading-relaxed">{`const client = new OpenAI({
  baseURL: "https://gateway.provara.xyz/v1",
  apiKey: "${createdToken.slice(0, 14)}...",
});`}</pre>
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
            <option value="cost">Cost-optimized</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality-first</option>
            <option value="custom">Custom weights</option>
          </select>
        </div>
      </div>

      {routingProfile === "custom" && (
        <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 space-y-3">
          <p className="text-xs text-zinc-400">Adjust how the adaptive router scores models. Weights must sum to 100%.</p>
          {(["quality", "cost", "latency"] as const).map((key) => (
            <div key={key} className="flex items-center gap-3">
              <label className="text-sm text-zinc-400 w-16 capitalize">{key}</label>
              <input
                type="range"
                min={0}
                max={100}
                value={customWeights[key]}
                onChange={(e) => {
                  const newVal = parseInt(e.target.value);
                  const others = (["quality", "cost", "latency"] as const).filter((k) => k !== key);
                  const remaining = 100 - newVal;
                  const otherTotal = others.reduce((s, k) => s + customWeights[k], 0) || 1;
                  setCustomWeights({
                    ...customWeights,
                    [key]: newVal,
                    [others[0]]: Math.round((customWeights[others[0]] / otherTotal) * remaining),
                    [others[1]]: remaining - Math.round((customWeights[others[0]] / otherTotal) * remaining),
                  });
                }}
                className="flex-1 accent-blue-500"
              />
              <span className="text-sm text-zinc-300 w-10 text-right">{customWeights[key]}%</span>
            </div>
          ))}
        </div>
      )}

      {routingProfile !== "custom" && (
        <div className="text-xs text-zinc-500">
          {routingProfile === "cost" && "Prioritizes cheaper models (70% cost, 20% quality, 10% latency)"}
          {routingProfile === "balanced" && "Equal weight to quality and cost (40% each, 20% latency)"}
          {routingProfile === "quality" && "Prioritizes highest-rated models (70% quality, 15% cost, 15% latency)"}
        </div>
      )}

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

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function TokenCard({ token, onRefresh }: { token: Token; onRefresh: () => void }) {
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    if (expanded) {
      gatewayFetchRaw(`/v1/admin/tokens/${token.id}`)
        .then((r) => r.json())
        .then((d) => setUsage(d.usage))
        .catch(() => {});
    }
  }, [expanded, token.id]);

  async function handleToggleEnabled(e: React.MouseEvent) {
    e.stopPropagation();
    setToggling(true);
    try {
      await gatewayFetchRaw(`/v1/admin/tokens/${token.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !token.enabled }),
      });
      onRefresh();
    } catch (err) {
      console.error("Failed to toggle token:", err);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Revoke token "${token.name}"? This cannot be undone.`)) return;
    await gatewayFetchRaw(`/v1/admin/tokens/${token.id}`, { method: "DELETE" });
    onRefresh();
  }

  const isExpired = token.expiresAt && new Date(token.expiresAt) < new Date();

  return (
    <div className={`bg-zinc-900 border rounded-lg overflow-hidden ${token.enabled ? "border-zinc-800" : "border-zinc-800/60 opacity-70"}`}>
      <div
        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-800/30"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3 min-w-0">
          {/* Status dot */}
          <div className={`w-2 h-2 rounded-full shrink-0 ${token.enabled ? (isExpired ? "bg-amber-500" : "bg-emerald-500") : "bg-zinc-600"}`} />
          <code className="text-xs text-zinc-500 font-mono shrink-0">{token.tokenPrefix}••••</code>
          <span className={`font-medium truncate ${!token.enabled ? "text-zinc-500" : ""}`}>{token.name}</span>
          <span className="text-xs text-zinc-500 shrink-0">({token.tenant})</span>
          {!token.enabled && (
            <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 border border-zinc-700 shrink-0">Disabled</span>
          )}
          {isExpired && token.enabled && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800/50 shrink-0">Expired</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {token.routingProfile && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800/50 capitalize">{token.routingProfile}</span>
          )}
          {token.rateLimit && (
            <span className="text-xs text-zinc-500">{token.rateLimit} RPM</span>
          )}
          {token.spendLimit && (
            <span className="text-xs text-zinc-500">{formatCost(token.spendLimit)}/{token.spendPeriod}</span>
          )}
          <span className="text-xs text-zinc-600">{formatDate(token.createdAt)}</span>
          <span className="text-zinc-500 text-sm">{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-4 space-y-4">
          {/* Metadata grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-xs text-zinc-500">Tenant</span>
              <p className="text-zinc-300">{token.tenant}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Routing</span>
              <p className="text-zinc-300 capitalize">{token.routingProfile || "balanced"}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Rate Limit</span>
              <p className="text-zinc-300">{token.rateLimit ? `${token.rateLimit} RPM` : "Unlimited"}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Spend Limit</span>
              <p className="text-zinc-300">{token.spendLimit ? `${formatCost(token.spendLimit)}/${token.spendPeriod}` : "Unlimited"}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Created</span>
              <p className="text-zinc-300">{formatDate(token.createdAt)}</p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Expires</span>
              <p className={`${isExpired ? "text-amber-300" : "text-zinc-300"}`}>
                {token.expiresAt ? formatDate(token.expiresAt) : "Never"}
              </p>
            </div>
            <div>
              <span className="text-xs text-zinc-500">Status</span>
              <p className={token.enabled ? "text-emerald-300" : "text-zinc-500"}>
                {token.enabled ? (isExpired ? "Expired" : "Active") : "Disabled"}
              </p>
            </div>
          </div>

          {/* Usage stats */}
          {usage && (
            <div className="grid grid-cols-4 gap-4 pt-2 border-t border-zinc-800/50">
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

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleToggleEnabled}
              disabled={toggling}
              className={`px-3 py-1 rounded text-xs disabled:opacity-50 ${
                token.enabled
                  ? "bg-amber-900/50 hover:bg-amber-800/50 text-amber-300"
                  : "bg-emerald-900/50 hover:bg-emerald-800/50 text-emerald-300"
              }`}
            >
              {toggling ? "..." : token.enabled ? "Disable" : "Enable"}
            </button>
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
      {(() => {
        const enabledCount = tokens.filter((t) => t.enabled).length;
        const isOpen = enabledCount === 0;
        return (
          <div className={`rounded-lg p-3 text-sm ${isOpen ? "bg-amber-900/30 border border-amber-800 text-amber-300" : "bg-emerald-900/30 border border-emerald-800 text-emerald-300"}`}>
            {isOpen
              ? tokens.length === 0
                ? "Open mode — no tokens created. All API requests are allowed without authentication."
                : "Open mode — all tokens are disabled. All API requests are allowed without authentication."
              : `Auth enabled — ${enabledCount} token${enabledCount > 1 ? "s" : ""} active${tokens.length !== enabledCount ? `, ${tokens.length - enabledCount} disabled` : ""}. API requests require a valid Bearer token.`}
          </div>
        );
      })()}

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
              <TokenCard key={token.id} token={token} onRefresh={fetchData} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
