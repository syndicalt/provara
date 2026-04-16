"use client";

import { useEffect, useRef, useState } from "react";
import type { AdaptiveCell, SparklinePoint } from "../components/adaptive-heatmap";

const BUFFER_CAPACITY = 30;
const PULSE_WINDOW_MS = 60_000;
const PULSE_CLEAR_MS = 1_200;

interface UseAdaptiveScoreBufferResult {
  getSparkline: (key: string) => SparklinePoint[];
  pulsedKeys: Set<string>;
  recentUpdateCount: number;
  pulseTick: number;
}

function bufferKey(taskType: string, complexity: string, provider: string, model: string): string {
  return `${taskType}:${complexity}:${provider}:${model}`;
}

export function useAdaptiveScoreBuffer(cells: AdaptiveCell[]): UseAdaptiveScoreBufferResult {
  const [buffers, setBuffers] = useState<Map<string, SparklinePoint[]>>(() => new Map());
  const [pulsedKeys, setPulsedKeys] = useState<Set<string>>(() => new Set());
  const [recentUpdateCount, setRecentUpdateCount] = useState(0);
  const [pulseTick, setPulseTick] = useState(0);
  const prevSampleCounts = useRef<Map<string, number>>(new Map());
  const updateLog = useRef<Array<{ key: string; timestamp: number }>>([]);

  useEffect(() => {
    const now = Date.now();
    let buffersChanged = false;
    const nextBuffers = new Map(buffers);
    const nextPulsed = new Set<string>();
    const nextPrev = new Map(prevSampleCounts.current);

    for (const cell of cells) {
      for (const score of cell.scores) {
        const key = bufferKey(cell.taskType, cell.complexity, score.provider, score.model);
        const prevCount = prevSampleCounts.current.get(key);
        const firstSeen = prevCount === undefined;
        const sampleIncreased = !firstSeen && score.sampleCount > prevCount;

        if (firstSeen || sampleIncreased) {
          const existing = nextBuffers.get(key) ?? [];
          const next = existing.concat({ timestamp: now, qualityScore: score.qualityScore });
          if (next.length > BUFFER_CAPACITY) next.shift();
          nextBuffers.set(key, next);
          buffersChanged = true;
        }

        if (sampleIncreased) {
          nextPulsed.add(key);
          updateLog.current.push({ key, timestamp: now });
        }

        nextPrev.set(key, score.sampleCount);
      }
    }

    prevSampleCounts.current = nextPrev;
    if (buffersChanged) setBuffers(nextBuffers);
    if (nextPulsed.size > 0) {
      setPulsedKeys(nextPulsed);
      setPulseTick((n) => n + 1);
    }

    updateLog.current = updateLog.current.filter((e) => now - e.timestamp <= PULSE_WINDOW_MS);
    setRecentUpdateCount(updateLog.current.length);
  }, [cells]);

  useEffect(() => {
    if (pulsedKeys.size === 0) return;
    const id = setTimeout(() => setPulsedKeys(new Set()), PULSE_CLEAR_MS);
    return () => clearTimeout(id);
  }, [pulsedKeys]);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      updateLog.current = updateLog.current.filter((e) => now - e.timestamp <= PULSE_WINDOW_MS);
      setRecentUpdateCount(updateLog.current.length);
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  return {
    getSparkline: (key: string) => buffers.get(key) ?? [],
    pulsedKeys,
    recentUpdateCount,
    pulseTick,
  };
}
