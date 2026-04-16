"use client";

import React from "react";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

export interface AdaptiveScore {
  provider: string;
  model: string;
  qualityScore: number;
  sampleCount: number;
  costPer1M: number;
  avgLatencyMs?: number;
}

export interface AdaptiveCell {
  taskType: string;
  complexity: string;
  scores: AdaptiveScore[];
}

export interface SparklinePoint {
  timestamp: number;
  qualityScore: number;
}

interface Props {
  cells: AdaptiveCell[];
  minSamples?: number;
  pulsedKeys?: Set<string>;
  getSparkline?: (key: string) => SparklinePoint[];
}

const TASK_TYPES = ["coding", "creative", "summarization", "qa", "general"] as const;
const COMPLEXITIES = ["simple", "medium", "complex"] as const;

export function cellKey(taskType: string, complexity: string, provider: string, model: string): string {
  return `${taskType}:${complexity}:${provider}:${model}`;
}

function scoreColor(score: number): string {
  const clamped = Math.max(1, Math.min(5, score));
  const hue = ((clamped - 1) / 4) * 120;
  return `hsl(${hue}, 55%, 42%)`;
}

function Strip({
  score,
  maxSamplesInCell,
  minSamples,
  pulsing,
  sparkline,
  rowIndex,
}: {
  score: AdaptiveScore;
  maxSamplesInCell: number;
  minSamples: number;
  pulsing: boolean;
  sparkline: SparklinePoint[] | undefined;
  rowIndex: number;
}) {
  const isBelowThreshold = score.sampleCount < minSamples;
  const confidenceOpacity = 0.35 + 0.65 * (score.sampleCount / Math.max(maxSamplesInCell, 1));
  const fillColor = scoreColor(score.qualityScore);
  const animationStyle = pulsing ? { animation: "adaptive-tick 900ms ease-out" } : {};
  const tooltipPositionClass = rowIndex === 0 ? "top-full mt-1" : "bottom-full mb-1";

  return (
    <div
      className="relative group rounded-sm"
      style={{
        borderStyle: isBelowThreshold ? "dashed" : "solid",
        borderColor: "rgba(255,255,255,0.6)",
        borderWidth: "1px",
        ...animationStyle,
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 rounded-sm pointer-events-none"
        style={{ backgroundColor: fillColor, opacity: confidenceOpacity }}
      />
      <div className="flex items-center justify-between px-2 py-1 text-[10px] text-zinc-50 font-mono relative z-10">
        <span className="truncate pr-1">{score.model}</span>
        <span className="opacity-90 shrink-0">{score.qualityScore.toFixed(2)}</span>
      </div>
      {sparkline && sparkline.length >= 2 && (
        <div className="absolute inset-0 pointer-events-none opacity-55 z-[5]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkline} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <YAxis domain={[1, 5]} hide />
              <Line
                type="stepAfter"
                dataKey="qualityScore"
                stroke="rgba(255,255,255,0.9)"
                strokeWidth={1.25}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className={`invisible group-hover:visible absolute ${tooltipPositionClass} left-0 z-20 bg-zinc-950 border border-zinc-700 rounded p-2 text-[10px] whitespace-nowrap shadow-xl pointer-events-none`}>
        <div className="text-zinc-200 font-medium mb-1 font-mono">{score.provider}/{score.model}</div>
        <div className="text-zinc-400 space-y-0.5">
          <div>
            Quality: <span className="text-zinc-200">{score.qualityScore.toFixed(2)}</span>
          </div>
          <div>
            Samples: <span className="text-zinc-200">{score.sampleCount}</span>
            {isBelowThreshold && <span className="text-amber-400 ml-1">(below threshold)</span>}
          </div>
          {score.avgLatencyMs !== undefined && score.avgLatencyMs > 0 && (
            <div>
              Avg latency: <span className="text-zinc-200">{score.avgLatencyMs.toFixed(0)}ms</span>
            </div>
          )}
          <div>
            Cost/1M: <span className="text-zinc-200">${score.costPer1M.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AdaptiveHeatmap({ cells, minSamples = 5, pulsedKeys, getSparkline }: Props) {
  const cellMap = new Map<string, AdaptiveCell>();
  for (const c of cells) {
    cellMap.set(`${c.taskType}:${c.complexity}`, c);
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))]">
        <div className="border-b border-zinc-800 bg-zinc-950/50" />
        {COMPLEXITIES.map((cx) => (
          <div
            key={cx}
            className="border-b border-l border-zinc-800 bg-zinc-950/50 px-4 py-2 text-xs font-medium text-zinc-400 capitalize text-center"
          >
            {cx}
          </div>
        ))}

        {TASK_TYPES.map((tt, rowIndex) => (
          <React.Fragment key={tt}>
            <div className="border-b border-zinc-800 px-4 py-3 text-xs font-medium text-zinc-300 capitalize flex items-center">
              {tt}
            </div>
            {COMPLEXITIES.map((cx) => {
              const cell = cellMap.get(`${tt}:${cx}`);
              const scores = [...(cell?.scores ?? [])].sort((a, b) => b.qualityScore - a.qualityScore);
              const maxSamples = scores.reduce((m, s) => Math.max(m, s.sampleCount), 0);

              return (
                <div
                  key={`${tt}-${cx}`}
                  className="border-b border-l border-zinc-800 p-1 min-h-[64px]"
                >
                  {scores.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-[10px] text-zinc-600">
                      No data
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {scores.map((s) => {
                        const key = cellKey(tt, cx, s.provider, s.model);
                        return (
                          <Strip
                            key={key}
                            score={s}
                            maxSamplesInCell={maxSamples}
                            minSamples={minSamples}
                            pulsing={pulsedKeys?.has(key) ?? false}
                            sparkline={getSparkline?.(key)}
                            rowIndex={rowIndex}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="border-t border-zinc-800 bg-zinc-950/40 px-4 py-2 flex items-center justify-between text-[10px] text-zinc-500">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: scoreColor(1.5) }} />
            <span>Low</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: scoreColor(3) }} />
            <span>Mid</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: scoreColor(4.8) }} />
            <span>High</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-3 rounded-sm border border-dashed border-zinc-500" />
            <span>Below {minSamples} samples</span>
          </span>
          <span>Opacity = confidence</span>
        </div>
      </div>
    </div>
  );
}
