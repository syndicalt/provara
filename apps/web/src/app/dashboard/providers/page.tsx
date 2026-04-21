"use client";

import { useEffect, useState } from "react";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";

interface BuiltinProvider {
  name: string;
  models: string[];
}

interface CustomProvider {
  id: string;
  name: string;
  baseURL: string;
  apiKeyRef: string | null;
  models: string[];
  enabled: boolean;
  createdAt: string;
}

// An apiKeyRef is meant to be a short symbolic name (e.g. "OLLAMA_API_KEY").
// If a user pastes a raw secret into the field instead, we mask it — the
// plaintext shouldn't be visible on a shared dashboard.
function looksLikeRawKey(ref: string): boolean {
  return ref.length > 40 || /^sk-|^xai-|^AIza/.test(ref);
}

function maskApiKeyRef(ref: string): string {
  if (!looksLikeRawKey(ref)) return ref;
  if (ref.length <= 8) return "••••";
  return `${ref.slice(0, 4)}••••${ref.slice(-4)}`;
}

const WELL_KNOWN_PROVIDERS = [
  { name: "together", baseURL: "https://api.together.xyz/v1", keyName: "TOGETHER_API_KEY" },
  { name: "groq", baseURL: "https://api.groq.com/openai/v1", keyName: "GROQ_API_KEY" },
  { name: "fireworks", baseURL: "https://api.fireworks.ai/inference/v1", keyName: "FIREWORKS_API_KEY" },
  { name: "perplexity", baseURL: "https://api.perplexity.ai", keyName: "PERPLEXITY_API_KEY" },
  { name: "deepseek", baseURL: "https://api.deepseek.com/v1", keyName: "DEEPSEEK_API_KEY" },
  { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", keyName: "OPENROUTER_API_KEY" },
];

function AddProviderForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [usePreset, setUsePreset] = useState(true);
  const [preset, setPreset] = useState(WELL_KNOWN_PROVIDERS[0].name);
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKeyRef, setApiKeyRef] = useState("");
  const [discover, setDiscover] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function handlePresetChange(presetName: string) {
    const p = WELL_KNOWN_PROVIDERS.find((w) => w.name === presetName);
    if (p) {
      setPreset(p.name);
      setName(p.name);
      setBaseURL(p.baseURL);
      setApiKeyRef(p.keyName);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const finalName = usePreset ? WELL_KNOWN_PROVIDERS.find((w) => w.name === preset)?.name || name : name;
    const finalBaseURL = usePreset ? WELL_KNOWN_PROVIDERS.find((w) => w.name === preset)?.baseURL || baseURL : baseURL;
    const finalKeyRef = usePreset ? WELL_KNOWN_PROVIDERS.find((w) => w.name === preset)?.keyName || apiKeyRef : apiKeyRef;

    try {
      const res = await gatewayFetchRaw(`/v1/admin/providers`, {
        method: "POST",
        body: JSON.stringify({
          name: finalName,
          baseURL: finalBaseURL,
          apiKeyRef: finalKeyRef || undefined,
          discover,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error?.message || "Failed to create provider");
        return;
      }

      // Reload providers
      await gatewayFetchRaw(`/v1/providers/reload`, { method: "POST" });

      setOpen(false);
      setName("");
      setBaseURL("");
      setApiKeyRef("");
      onCreated();
    } catch (err) {
      setError("Failed to connect to gateway");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors"
      >
        Add Provider
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Add Custom Provider</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-300">{error}</div>
      )}

      <div className="flex gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={usePreset} onChange={() => setUsePreset(true)} />
          Well-known provider
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={!usePreset} onChange={() => setUsePreset(false)} />
          Custom
        </label>
      </div>

      {usePreset ? (
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Provider</label>
          <select
            value={preset}
            onChange={(e) => handlePresetChange(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
          >
            {WELL_KNOWN_PROVIDERS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} — {p.baseURL}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-500 mt-1">
            API key name: <code className="bg-zinc-800 px-1 rounded">{WELL_KNOWN_PROVIDERS.find((w) => w.name === preset)?.keyName}</code>
            — add this key in the API Keys page first.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="e.g. my-provider"
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Base URL</label>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              required
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-sm text-zinc-400 mb-1">API Key Reference</label>
            <input
              value={apiKeyRef}
              onChange={(e) => setApiKeyRef(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="Key name from API Keys page (e.g. MY_PROVIDER_KEY)"
            />
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} />
        Auto-discover models via GET /models
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
      >
        {submitting ? "Adding..." : "Add Provider"}
      </button>
    </form>
  );
}

function CustomProviderCard({ provider, onUpdate }: { provider: CustomProvider; onUpdate: () => void }) {
  const [discovering, setDiscovering] = useState(false);

  async function handleDiscover() {
    setDiscovering(true);
    try {
      const res = await gatewayFetchRaw(`/v1/admin/providers/${provider.id}/discover`, { method: "POST" });
      if (res.ok) {
        await gatewayFetchRaw(`/v1/providers/reload`, { method: "POST" });
        onUpdate();
      }
    } catch {
    } finally {
      setDiscovering(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Remove provider "${provider.name}"?`)) return;
    await gatewayFetchRaw(`/v1/admin/providers/${provider.id}`, { method: "DELETE" });
    await gatewayFetchRaw(`/v1/providers/reload`, { method: "POST" });
    onUpdate();
  }

  async function handleToggle() {
    await gatewayFetchRaw(`/v1/admin/providers/${provider.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !provider.enabled }),
    });
    await gatewayFetchRaw(`/v1/providers/reload`, { method: "POST" });
    onUpdate();
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${provider.enabled ? "bg-emerald-500" : "bg-zinc-600"}`} />
          <span className="font-medium capitalize">{provider.name}</span>
          <span className="text-xs text-zinc-500">custom</span>
        </div>
        <div className="flex gap-2">
          <button onClick={handleDiscover} disabled={discovering} className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50">
            {discovering ? "Discovering..." : "Discover Models"}
          </button>
          <button onClick={handleToggle} className="text-xs text-zinc-400 hover:text-zinc-200">
            {provider.enabled ? "Disable" : "Enable"}
          </button>
          <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300">
            Remove
          </button>
        </div>
      </div>
      <p className="text-xs text-zinc-500 font-mono mb-1">{provider.baseURL}</p>
      {provider.apiKeyRef && (
        <p className="text-xs text-zinc-500 mb-1">
          Key: <code className="bg-zinc-800 px-1 rounded">{maskApiKeyRef(provider.apiKeyRef)}</code>
          {looksLikeRawKey(provider.apiKeyRef) && (
            <span className="ml-2 text-amber-400">⚠ raw key stored — edit to use a reference name</span>
          )}
        </p>
      )}
      <p className="text-xs text-zinc-400">
        {provider.models.length > 0 ? provider.models.join(", ") : "No models — run discovery"}
      </p>
    </div>
  );
}

export default function ProvidersPage() {
  const [builtinProviders, setBuiltinProviders] = useState<BuiltinProvider[]>([]);
  const [customProvidersList, setCustomProvidersList] = useState<CustomProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  async function handleRefreshModels() {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await gatewayFetchRaw(`/v1/providers/refresh-models`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        const discovered = (data.results || []).filter((r: { discovered: boolean }) => r.discovered);
        const totalModels = discovered.reduce((sum: number, r: { models: string[] }) => sum + r.models.length, 0);
        setRefreshResult(`Discovered ${totalModels} models from ${discovered.length} providers`);
        await fetchData();
      } else {
        setRefreshResult("Failed to refresh models");
      }
    } catch {
      setRefreshResult("Failed to connect to gateway");
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshResult(null), 5000);
    }
  }

  async function fetchData() {
    try {
      const [builtinRes, customRes] = await Promise.all([
        gatewayFetchRaw(`/v1/providers`),
        gatewayFetchRaw(`/v1/admin/providers`),
      ]);
      const builtinData = await builtinRes.json();
      const customData = await customRes.json();
      setBuiltinProviders(builtinData.providers || []);
      setCustomProvidersList(customData.providers || []);
    } catch (err) {
      console.error("Failed to fetch providers:", err);
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
        <p className="text-zinc-400">Loading providers...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Providers</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleRefreshModels}
            disabled={refreshing}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-zinc-700 rounded-lg text-sm font-medium transition-colors"
          >
            {refreshing ? "Refreshing..." : "Refresh Models"}
          </button>
          <AddProviderForm onCreated={fetchData} />
        </div>
      </div>

      {refreshResult && (
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-300">
          {refreshResult}
        </div>
      )}

      {/* Active Providers (built-in) */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Built-in Providers</h2>
        <div className="grid grid-cols-3 gap-3">
          {builtinProviders.map((p) => (
            <div key={p.name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="font-medium capitalize">{p.name}</span>
              </div>
              <p className="text-xs text-zinc-500">
                {p.models.length > 0 ? p.models.join(", ") : "Any model (local)"}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Custom Providers */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Custom Providers</h2>
        {customProvidersList.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
            <p className="text-zinc-400">No custom providers yet.</p>
            <p className="text-sm text-zinc-500 mt-1">
              Add any OpenAI-compatible provider — Together AI, Groq, Fireworks, Perplexity, Deepseek, and more.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {customProvidersList.map((p) => (
              <CustomProviderCard key={p.id} provider={p} onUpdate={fetchData} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
