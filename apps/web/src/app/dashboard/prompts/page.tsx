"use client";

import { useEffect, useState } from "react";
import { gatewayClientFetch, gatewayFetchRaw } from "../../../lib/gateway-client";

interface PromptTemplate {
  id: string;
  name: string;
  description: string | null;
  publishedVersionId: string | null;
  versionCount: number;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface PromptVersion {
  id: string;
  templateId: string;
  version: number;
  messages: string; // JSON
  variables: string; // JSON
  note: string | null;
  createdAt: string;
}

interface Message {
  role: string;
  content: string;
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---- Create Template Form ----

function CreateTemplateForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ role: "system", content: "" }]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function addMessage() {
    setMessages([...messages, { role: "user", content: "" }]);
  }

  function updateMessage(index: number, field: "role" | "content", value: string) {
    const updated = [...messages];
    updated[index] = { ...updated[index], [field]: value };
    setMessages(updated);
  }

  function removeMessage(index: number) {
    setMessages(messages.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await gatewayFetchRaw("/v1/admin/prompts", {
        method: "POST",
        body: JSON.stringify({ name, description: description || undefined, messages, note: note || undefined }),
      });
      setName(""); setDescription(""); setMessages([{ role: "system", content: "" }]); setNote("");
      setOpen(false);
      onCreated();
    } catch (err) {
      console.error("Failed to create template:", err);
    } finally {
      setSubmitting(false);
    }
  }

  // Detect variables
  const variables = new Set<string>();
  for (const msg of messages) {
    for (const match of msg.content.matchAll(/\{\{(\w+)\}\}/g)) {
      variables.add(match[1]);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors">
        Create Template
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Create Prompt Template</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">Cancel</button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" placeholder="e.g. summarizer" />
        </div>
        <div>
          <label className="block text-sm text-zinc-400 mb-1">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" placeholder="Summarizes long text" />
        </div>
      </div>

      {/* Messages editor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm text-zinc-400">Messages</label>
          <button type="button" onClick={addMessage} className="text-xs text-blue-400 hover:text-blue-300">+ Add message</button>
        </div>
        {messages.map((msg, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <select
                value={msg.role}
                onChange={(e) => updateMessage(i, "role", e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300 w-28 focus:outline-none focus:border-blue-500"
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
              {messages.length > 1 && (
                <button type="button" onClick={() => removeMessage(i)} className="text-zinc-600 hover:text-red-400 text-xs ml-auto">Remove</button>
              )}
            </div>
            <textarea
              value={msg.content}
              onChange={(e) => updateMessage(i, "content", e.target.value)}
              rows={3}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:border-blue-500 resize-y"
              placeholder={`Use {{variable_name}} for variables`}
            />
          </div>
        ))}
      </div>

      {variables.size > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">Variables detected:</span>
          {[...variables].map((v) => (
            <span key={v} className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-800/50 font-mono">
              {`{{${v}}}`}
            </span>
          ))}
        </div>
      )}

      <div>
        <label className="block text-sm text-zinc-400 mb-1">Version Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500" placeholder="Initial version" />
      </div>

      <button type="submit" disabled={submitting} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors">
        {submitting ? "Creating..." : "Create Template"}
      </button>
    </form>
  );
}

// ---- Template Detail Modal ----

function TemplateDetail({ template, onClose, onRefresh }: { template: PromptTemplate; onClose: () => void; onRefresh: () => void }) {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [publishedId, setPublishedId] = useState(template.publishedVersionId);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    gatewayClientFetch<{ template: PromptTemplate; versions: PromptVersion[] }>(`/v1/admin/prompts/${template.id}`)
      .then((data) => {
        setVersions(data.versions || []);
        setPublishedId(data.template.publishedVersionId);
      })
      .finally(() => setLoading(false));
  }, [template.id]);

  async function handlePublish(versionId: string) {
    await gatewayFetchRaw(`/v1/admin/prompts/${template.id}/publish/${versionId}`, { method: "POST" });
    setPublishedId(versionId);
    onRefresh();
  }

  async function handleDelete() {
    if (!confirm(`Delete template "${template.name}" and all its versions?`)) return;
    await gatewayFetchRaw(`/v1/admin/prompts/${template.id}`, { method: "DELETE" });
    onClose();
    onRefresh();
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-16 px-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-3xl max-h-[80vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <div>
            <h2 className="text-lg font-bold">{template.name}</h2>
            {template.description && <p className="text-xs text-zinc-500 mt-0.5">{template.description}</p>}
          </div>
          <div className="flex items-center gap-3">
            <code className="text-[10px] text-zinc-600 bg-zinc-800 px-2 py-1 rounded font-mono">
              /v1/admin/prompts/resolve/{template.name}
            </code>
            <button onClick={handleDelete} className="px-3 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded text-xs">Delete</button>
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">X</button>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {loading ? (
            <p className="text-zinc-400 text-sm">Loading versions...</p>
          ) : versions.length === 0 ? (
            <p className="text-zinc-500 text-sm">No versions.</p>
          ) : (
            versions.map((v) => {
              const messages: Message[] = JSON.parse(v.messages);
              const variables: string[] = JSON.parse(v.variables);
              const isPublished = v.id === publishedId;

              return (
                <div key={v.id} className={`border rounded-lg p-4 space-y-3 ${isPublished ? "border-emerald-800/50 bg-emerald-950/10" : "border-zinc-800"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">v{v.version}</span>
                      {isPublished && (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-800/50">Published</span>
                      )}
                      {v.note && <span className="text-xs text-zinc-500">— {v.note}</span>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-600">{formatDate(v.createdAt)}</span>
                      {!isPublished && (
                        <button
                          onClick={() => handlePublish(v.id)}
                          className="px-2.5 py-1 bg-emerald-900/50 hover:bg-emerald-800/50 text-emerald-300 rounded text-xs"
                        >
                          Publish
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Messages */}
                  <div className="space-y-2">
                    {messages.map((msg, i) => (
                      <div key={i} className="bg-zinc-800/50 rounded p-3">
                        <p className={`text-[10px] font-semibold uppercase tracking-widest mb-1 ${
                          msg.role === "user" ? "text-blue-400" : msg.role === "assistant" ? "text-emerald-400" : "text-zinc-500"
                        }`}>{msg.role}</p>
                        <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans">{msg.content}</pre>
                      </div>
                    ))}
                  </div>

                  {variables.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-zinc-600">Variables:</span>
                      {variables.map((v) => (
                        <span key={v} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-800/50 font-mono">{`{{${v}}}`}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Main Page ----

export default function PromptsPage() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PromptTemplate | null>(null);

  async function fetchData() {
    try {
      const data = await gatewayClientFetch<{ templates: PromptTemplate[] }>("/v1/admin/prompts");
      setTemplates(data.templates || []);
    } catch (err) {
      console.error("Failed to fetch prompts:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading prompts...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Prompt Templates</h1>
          <p className="text-sm text-zinc-400 mt-1">Manage versioned prompt templates. Reference them by name in API calls.</p>
        </div>
        <CreateTemplateForm onCreated={fetchData} />
      </div>

      {templates.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
          <p className="text-zinc-400">No prompt templates yet.</p>
          <p className="text-sm text-zinc-500 mt-1">
            Create a template to start managing versioned prompts.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelected(t)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 cursor-pointer hover:border-zinc-700 transition-colors space-y-2"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">{t.name}</h3>
                <span className="text-[10px] text-zinc-600 bg-zinc-800 px-2 py-0.5 rounded">
                  v{t.latestVersion} ({t.versionCount} ver{t.versionCount !== 1 ? "s" : ""})
                </span>
              </div>
              {t.description && <p className="text-xs text-zinc-500">{t.description}</p>}
              <div className="flex items-center justify-between text-[10px] text-zinc-600">
                <span>Created {formatDate(t.createdAt)}</span>
                <span>Updated {formatDate(t.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <TemplateDetail
          template={selected}
          onClose={() => setSelected(null)}
          onRefresh={fetchData}
        />
      )}
    </div>
  );
}
