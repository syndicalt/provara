"use client";

import { useEffect, useState, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { gatewayClientFetch } from "../lib/gateway-client";

interface StageStats {
  count: number;
  avgLatency?: number;
  active: boolean;
  activeTests?: number;
  feedbackCount?: number;
  providerCount?: number;
}

interface PipelineData {
  totalRequests: number;
  stages: {
    classifier: StageStats;
    abTest: StageStats;
    adaptive: StageStats;
    fallback: StageStats;
    providers: StageStats;
  };
}

function formatNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// Custom node component
function PipelineNode({ data }: NodeProps) {
  const d = data as {
    label: string;
    subtitle: string;
    icon: string;
    count: number;
    avgLatency?: number;
    active: boolean;
    color: string;
    detail?: string;
  };

  const borderColor = d.active ? d.color : "border-zinc-700";
  const bgColor = d.active ? `${d.color.replace("border-", "bg-")}/10` : "bg-zinc-900";

  return (
    <div className={`px-4 py-3 rounded-xl border-2 ${borderColor} ${bgColor} min-w-[160px] shadow-lg`}>
      <Handle type="target" position={Position.Left} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{d.icon}</span>
        <span className="text-sm font-semibold text-zinc-100">{d.label}</span>
      </div>
      <p className="text-xs text-zinc-500 mb-2">{d.subtitle}</p>
      <div className="flex items-center gap-3 text-xs">
        <div>
          <span className="text-zinc-400">{formatNum(d.count)}</span>
          <span className="text-zinc-600 ml-1">reqs</span>
        </div>
        {d.avgLatency != null && d.avgLatency > 0 && (
          <div>
            <span className="text-zinc-400">{d.avgLatency}</span>
            <span className="text-zinc-600 ml-1">ms</span>
          </div>
        )}
      </div>
      {d.detail && (
        <p className="text-xs text-zinc-500 mt-1">{d.detail}</p>
      )}
      {!d.active && (
        <p className="text-xs text-zinc-600 mt-1 italic">inactive</p>
      )}
      <Handle type="source" position={Position.Right} className="!bg-zinc-600 !border-zinc-500 !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNode };

function buildNodes(data: PipelineData | null): Node[] {
  const s = data?.stages;
  return [
    {
      id: "request",
      type: "pipeline",
      position: { x: 0, y: 150 },
      data: {
        label: "Request",
        subtitle: "Incoming",
        icon: "\u{1F4E8}",
        count: data?.totalRequests || 0,
        active: true,
        color: "border-zinc-500",
      },
    },
    {
      id: "classifier",
      type: "pipeline",
      position: { x: 260, y: 150 },
      data: {
        label: "Classifier",
        subtitle: "Task + Complexity",
        icon: "\u{1F9E0}",
        count: s?.classifier.count || 0,
        avgLatency: s?.classifier.avgLatency,
        active: s?.classifier.active ?? true,
        color: "border-blue-500",
      },
    },
    {
      id: "abtest",
      type: "pipeline",
      position: { x: 540, y: 0 },
      data: {
        label: "A/B Test",
        subtitle: "Traffic split",
        icon: "\u{1F500}",
        count: s?.abTest.count || 0,
        avgLatency: s?.abTest.avgLatency,
        active: s?.abTest.active ?? false,
        color: "border-violet-500",
        detail: s?.abTest.activeTests ? `${s.abTest.activeTests} active` : undefined,
      },
    },
    {
      id: "adaptive",
      type: "pipeline",
      position: { x: 540, y: 150 },
      data: {
        label: "Adaptive",
        subtitle: "Quality scoring",
        icon: "\u{1F4CA}",
        count: s?.adaptive.count || 0,
        avgLatency: s?.adaptive.avgLatency,
        active: s?.adaptive.active ?? false,
        color: "border-emerald-500",
        detail: s?.adaptive.feedbackCount ? `${s.adaptive.feedbackCount} feedback` : undefined,
      },
    },
    {
      id: "fallback",
      type: "pipeline",
      position: { x: 540, y: 300 },
      data: {
        label: "Cost Fallback",
        subtitle: "Cheapest first",
        icon: "\u{1F4B0}",
        count: s?.fallback.count || 0,
        avgLatency: s?.fallback.avgLatency,
        active: s?.fallback.active ?? true,
        color: "border-amber-500",
      },
    },
    {
      id: "provider",
      type: "pipeline",
      position: { x: 820, y: 150 },
      data: {
        label: "Provider",
        subtitle: "Execute request",
        icon: "\u{26A1}",
        count: s?.providers.count || 0,
        active: s?.providers.active ?? true,
        color: "border-cyan-500",
        detail: s?.providers.providerCount ? `${s.providers.providerCount} active` : undefined,
      },
    },
  ];
}

const edges: Edge[] = [
  { id: "e-req-cls", source: "request", target: "classifier", animated: true, style: { stroke: "#3b82f6", strokeWidth: 2 } },
  { id: "e-cls-ab", source: "classifier", target: "abtest", animated: true, style: { stroke: "#8b5cf6", strokeWidth: 1.5 } },
  { id: "e-cls-adp", source: "classifier", target: "adaptive", animated: true, style: { stroke: "#10b981", strokeWidth: 1.5 } },
  { id: "e-cls-fb", source: "classifier", target: "fallback", animated: true, style: { stroke: "#f59e0b", strokeWidth: 1.5 } },
  { id: "e-ab-prv", source: "abtest", target: "provider", animated: true, style: { stroke: "#8b5cf6", strokeWidth: 1.5 } },
  { id: "e-adp-prv", source: "adaptive", target: "provider", animated: true, style: { stroke: "#10b981", strokeWidth: 1.5 } },
  { id: "e-fb-prv", source: "fallback", target: "provider", animated: true, style: { stroke: "#f59e0b", strokeWidth: 1.5 } },
];

export function PipelineVisualization() {
  const [nodes, setNodes, onNodesChange] = useNodesState(buildNodes(null));

  useEffect(() => {
    gatewayClientFetch<PipelineData>("/v1/analytics/pipeline")
      .then((d) => {
        setNodes(buildNodes(d));
      })
      .catch((err) => console.error("Failed to fetch pipeline data:", err));
  }, [setNodes]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden" style={{ height: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="#27272a" gap={20} size={1} />
        <Controls
          showInteractive={false}
          className="!bg-zinc-800 !border-zinc-700 !shadow-lg [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
        />
      </ReactFlow>
    </div>
  );
}
