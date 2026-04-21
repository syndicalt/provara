"use client";

import { useEffect, useState } from "react";
import { gatewayFetchRaw } from "../../../lib/gateway-client";

interface ApiKey {
  id: string;
  name: string;
  provider: string;
  maskedValue: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderInfo {
  name: string;
  models: string[];
}

const KNOWN_KEYS = [
  { name: "OPENAI_API_KEY", provider: "openai", placeholder: "sk-..." },
  { name: "ANTHROPIC_API_KEY", provider: "anthropic", placeholder: "sk-ant-..." },
  { name: "GOOGLE_API_KEY", provider: "google", placeholder: "AIza..." },
  { name: "MISTRAL_API_KEY", provider: "mistral", placeholder: "..." },
  { name: "XAI_API_KEY", provider: "xai", placeholder: "xai-..." },
  { name: "ZAI_API_KEY", provider: "zai", placeholder: "..." },
  { name: "OLLAMA_API_KEY", provider: "ollama", placeholder: "sk-ollama-... (remote only)" },
];

function AddKeyForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(KNOWN_KEYS[0].name);
  const [provider, setProvider] = useState(KNOWN_KEYS[0].provider);
  const [value, setValue] = useState("");
  const [customName, setCustomName] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function handlePresetChange(keyName: string) {
    const preset = KNOWN_KEYS.find((k) => k.name === keyName);
    if (preset) {
      setName(preset.name);
      setProvider(preset.provider);
      setCustomName(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const res = await gatewayFetchRaw("/v1/api-keys", {
        method: "POST",
        body: JSON.stringify({ name, provider, value }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error?.message || "Failed to save key");
        return;
      }

      // Reload providers to pick up the new key
      await gatewayFetchRaw("/v1/providers/reload", { method: "POST" });

      setValue("");
      setOpen(false);
      onSaved();
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
        Add API Key
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Add API Key</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Provider Key</label>
          {!customName ? (
            <div className="space-y-2">
              <select
                value={name}
                onChange={(e) => handlePresetChange(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              >
                {KNOWN_KEYS.map((k) => (
                  <option key={k.name} value={k.name}>
                    {k.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCustomName(true)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Use custom key name
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                placeholder="KEY_NAME"
              />
              <button
                type="button"
                onClick={() => {
                  setCustomName(false);
                  handlePresetChange(KNOWN_KEYS[0].name);
                }}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                Use preset
              </button>
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Provider</label>
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. openai"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm text-zinc-400 mb-1">API Key Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-blue-500"
          placeholder={KNOWN_KEYS.find((k) => k.name === name)?.placeholder || "Enter API key"}
        />
        <p className="text-xs text-zinc-500 mt-1">
          Encrypted with AES-256-GCM before storage. The full key is never sent back to the browser.
        </p>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
      >
        {submitting ? "Saving..." : "Save Key"}
      </button>
    </form>
  );
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [masterKeyConfigured, setMasterKeyConfigured] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    try {
      const [statusRes, keysRes, providersRes] = await Promise.all([
        gatewayFetchRaw("/v1/api-keys/status"),
        gatewayFetchRaw("/v1/api-keys").catch(() => null),
        gatewayFetchRaw("/v1/providers"),
      ]);

      if (statusRes.status === 401 || statusRes.status === 403) {
        setForbidden(true);
      } else if (statusRes.ok) {
        const statusData = await statusRes.json();
        setMasterKeyConfigured(statusData.configured);
      }

      if (keysRes?.ok) {
        const keysData = await keysRes.json();
        setKeys(keysData.keys || []);
      }

      const providersData = await providersRes.json();
      setProviders(providersData.providers || []);
    } catch (err) {
      console.error("Failed to fetch API keys:", err);
    } finally {
      setLoading(false);
    }
  }

  async function deleteKey(id: string) {
    try {
      await gatewayFetchRaw(`/v1/api-keys/${id}`, { method: "DELETE" });
      await gatewayFetchRaw("/v1/providers/reload", { method: "POST" });
      fetchData();
    } catch (err) {
      console.error("Failed to delete key:", err);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading API keys...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">API Keys</h1>
        {!forbidden && masterKeyConfigured && <AddKeyForm onSaved={fetchData} />}
      </div>

      {forbidden && (
        <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-4">
          <h3 className="font-medium text-amber-200 mb-1">Admin access required</h3>
          <p className="text-sm text-amber-300/80">
            Provider API keys are shared across the whole tenant, so only Owners and Admins can add or rotate them. Ask an owner on your team if you need a new provider wired up.
          </p>
        </div>
      )}

      {!forbidden && !masterKeyConfigured && (
        <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-4">
          <h3 className="font-medium text-amber-200 mb-1">Master Key Required</h3>
          <p className="text-sm text-amber-300/80">
            Set the <code className="bg-zinc-800 px-1 rounded">PROVARA_MASTER_KEY</code> environment variable to enable encrypted API key storage.
          </p>
          <pre className="mt-2 bg-zinc-900 rounded px-3 py-2 text-xs text-zinc-300 overflow-x-auto">
            {`# Generate a master key\nnode -e "console.log(require('crypto').randomBytes(32).toString('hex'))"\n\n# Set it in your environment\nexport PROVARA_MASTER_KEY=<generated-key>`}
          </pre>
        </div>
      )}

      {/* Active Providers */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Active Providers</h2>
        <div className="grid grid-cols-3 gap-3">
          {providers.map((p) => (
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

      {/* Stored Keys */}
      {masterKeyConfigured && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Stored Keys</h2>
          {keys.length === 0 ? (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
              <p className="text-zinc-400">No API keys stored yet. Add one to enable a provider.</p>
              <p className="text-sm text-zinc-500 mt-1">
                Keys from environment variables are used as fallback when no DB key is set.
              </p>
            </div>
          ) : (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Value</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                      <td className="px-4 py-3 font-mono text-xs">{key.name}</td>
                      <td className="px-4 py-3 capitalize">{key.provider}</td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-400">{key.maskedValue}</td>
                      <td className="px-4 py-3 text-zinc-500 text-xs">
                        {new Date(key.updatedAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => deleteKey(key.id)}
                          className="text-red-400 hover:text-red-300 text-xs"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
