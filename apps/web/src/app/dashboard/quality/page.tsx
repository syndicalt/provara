"use client";

import { useEffect, useState } from "react";
import { formatNumber } from "../../../lib/format";
import { DataTable, type Column } from "../../../components/data-table";
import { gatewayUrl, adminHeaders } from "../../../lib/gateway-client";

interface QualityByModel {
  provider: string;
  model: string;
  avgScore: number;
  count: number;
  userCount: number;
  judgeCount: number;
}

interface QualityByCell {
  provider: string;
  model: string;
  taskType: string | null;
  complexity: string | null;
  avgScore: number;
  count: number;
}

interface AdaptiveScore {
  provider: string;
  model: string;
  qualityScore: number;
  sampleCount: number;
  costPer1M: number;
}

interface AdaptiveCell {
  taskType: string;
  complexity: string;
  scores: AdaptiveScore[];
}

interface FeedbackEntry {
  id: string;
  requestId: string;
  tenantId: string | null;
  score: number;
  comment: string | null;
  source: string;
  createdAt: string;
  model: string | null;
  provider: string | null;
  taskType: string | null;
  complexity: string | null;
}

const TASK_TYPES = ["coding", "creative", "summarization", "qa", "general"];
const COMPLEXITIES = ["simple", "medium", "complex"];

function ScoreBar({ score, max = 5 }: { score: number; max?: number }) {
  const pct = (score / max) * 100;
  const color =
    score >= 4 ? "bg-emerald-500" : score >= 3 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
        <div className={`${color} h-full rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-medium w-8 text-right">{score.toFixed(1)}</span>
    </div>
  );
}

function AdaptiveMatrix({ cells }: { cells: AdaptiveCell[] }) {
  // Build matrix: taskType × complexity → best model and score
  const matrix: Record<string, Record<string, AdaptiveScore | null>> = {};
  for (const tt of TASK_TYPES) {
    matrix[tt] = {};
    for (const cx of COMPLEXITIES) {
      const cell = cells.find((c) => c.taskType === tt && c.complexity === cx);
      if (cell && cell.scores.length > 0) {
        // Sort by quality score descending
        const best = [...cell.scores].sort((a, b) => b.qualityScore - a.qualityScore)[0];
        matrix[tt][cx] = best;
      } else {
        matrix[tt][cx] = null;
      }
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-400 text-left">
            <th className="px-4 py-3">Task Type</th>
            {COMPLEXITIES.map((c) => (
              <th key={c} className="px-4 py-3 text-center capitalize">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TASK_TYPES.map((tt) => (
            <tr key={tt} className="border-b border-zinc-800/50">
              <td className="px-4 py-3 capitalize font-medium">{tt}</td>
              {COMPLEXITIES.map((cx) => {
                const score = matrix[tt][cx];
                return (
                  <td key={cx} className="px-4 py-3 text-center">
                    {score ? (
                      <div>
                        <p className="font-mono text-xs">{score.model}</p>
                        <ScoreBar score={score.qualityScore} />
                        <p className="text-xs text-zinc-500 mt-1">
                          {score.sampleCount} samples
                        </p>
                      </div>
                    ) : (
                      <span className="text-zinc-600">No data</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const qualityColumns: Column<QualityByModel>[] = [
  { key: "provider", label: "Provider", sortable: true, filterable: true },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.model}</span> },
  { key: "avgScore", label: "Avg Score", sortable: true, render: (row) => <div className="w-48"><ScoreBar score={row.avgScore} /></div> },
  { key: "count", label: "Total", sortable: true, align: "right", render: (row) => formatNumber(row.count) },
  { key: "userCount", label: "User", sortable: true, align: "right", render: (row) => formatNumber(row.userCount) },
  { key: "judgeCount", label: "Judge", sortable: true, align: "right", render: (row) => formatNumber(row.judgeCount) },
];

const feedbackColumns: Column<FeedbackEntry>[] = [
  {
    key: "source", label: "Source", sortable: true, filterable: true,
    render: (row) => (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${row.source === "judge" ? "bg-purple-900/50 text-purple-300" : "bg-blue-900/50 text-blue-300"}`}>
        {row.source}
      </span>
    ),
  },
  { key: "model", label: "Model", sortable: true, filterable: true, render: (row) => <span className="font-mono text-xs">{row.provider}/{row.model}</span> },
  { key: "taskType", label: "Task", sortable: true, filterable: true, render: (row) => <span className="text-xs text-zinc-400">{row.taskType ? `${row.taskType}/${row.complexity}` : "—"}</span>, getValue: (row) => row.taskType },
  {
    key: "score", label: "Score", sortable: true,
    render: (row) => (
      <span className={`font-medium ${row.score >= 4 ? "text-emerald-400" : row.score >= 3 ? "text-yellow-400" : "text-red-400"}`}>
        {row.score}/5
      </span>
    ),
  },
  { key: "comment", label: "Comment", render: (row) => <span className="text-xs text-zinc-400 max-w-xs truncate block">{row.comment || "—"}</span> },
];

export default function QualityPage() {
  const [byModel, setByModel] = useState<QualityByModel[]>([]);
  const [byCell, setByCell] = useState<QualityByCell[]>([]);
  const [adaptiveCells, setAdaptiveCells] = useState<AdaptiveCell[]>([]);
  const [recentFeedback, setRecentFeedback] = useState<FeedbackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [modelRes, cellRes, adaptiveRes, feedbackRes] = await Promise.all([
          fetch(gatewayUrl("/v1/feedback/quality/by-model"), { headers: adminHeaders() }),
          fetch(gatewayUrl("/v1/feedback/quality/by-cell"), { headers: adminHeaders() }),
          fetch(gatewayUrl("/v1/analytics/adaptive/scores"), { headers: adminHeaders() }),
          fetch(gatewayUrl("/v1/feedback?limit=20"), { headers: adminHeaders() }),
        ]);
        const modelData = await modelRes.json();
        const cellData = await cellRes.json();
        const adaptiveData = await adaptiveRes.json();
        const feedbackData = await feedbackRes.json();
        setByModel(modelData.quality || []);
        setByCell(cellData.quality || []);
        setAdaptiveCells(adaptiveData.cells || []);
        setRecentFeedback(feedbackData.feedback || []);
      } catch (err) {
        console.error("Failed to fetch quality data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-zinc-400">Loading quality data...</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <h1 className="text-2xl font-bold">Quality Analytics</h1>

      {/* Adaptive Routing Matrix */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Adaptive Routing Matrix</h2>
        <p className="text-sm text-zinc-400 mb-3">
          Best model per cell based on EMA quality scores from feedback. The router uses these scores to auto-select models.
        </p>
        <AdaptiveMatrix cells={adaptiveCells} />
      </section>

      {/* Quality by Model */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Quality by Model</h2>
        <DataTable
          columns={qualityColumns}
          data={byModel}
          pageSize={10}
          emptyMessage="No quality data yet. Submit feedback via POST /v1/feedback or enable the LLM judge."
        />
      </section>

      {/* Recent Feedback */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Recent Feedback</h2>
        <DataTable
          columns={feedbackColumns}
          data={recentFeedback}
          pageSize={10}
          emptyMessage="No feedback yet."
        />
      </section>
    </div>
  );
}
