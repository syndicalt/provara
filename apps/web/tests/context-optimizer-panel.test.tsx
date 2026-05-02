import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ContextOptimizerPanel } from "../src/components/context-optimizer-panel";
import { gatewayFetchRaw } from "../src/lib/gateway-client";

vi.mock("../src/lib/gateway-client", () => ({
  gatewayFetchRaw: vi.fn(),
}));

const mockedFetch = vi.mocked(gatewayFetchRaw);

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("ContextOptimizerPanel", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("renders summary metrics and recent events", async () => {
    mockedFetch.mockImplementation((path) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 2,
            inputChunks: 10,
            outputChunks: 7,
            droppedChunks: 3,
            inputTokens: 1000,
            outputTokens: 730,
            savedTokens: 270,
            reductionPct: 27,
            flaggedChunks: 1,
            quarantinedChunks: 2,
            latestAt: "2026-05-01T21:00:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 3,
            regressedCount: 1,
            avgRawScore: 4.2,
            avgOptimizedScore: 4,
            avgDelta: -0.2,
            latestAt: "2026-05-01T21:30:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/quality/events?limit=10") {
        return Promise.resolve(jsonResponse({
          events: [
            {
              id: "quality-1",
              tenantId: "tenant-pro",
              rawScore: 4,
              optimizedScore: 3,
              delta: -1,
              regressed: true,
              regressionThreshold: -0.5,
              judgeProvider: "openai",
              judgeModel: "gpt-4o-mini",
              promptHash: "abc123",
              rawSourceIds: ["refunds#1", "policy#2"],
              optimizedSourceIds: ["refunds#1"],
              rationale: "Optimized answer omitted one detail.",
              createdAt: "2026-05-01T21:30:00.000Z",
            },
          ],
        }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 2,
            retrievedChunks: 10,
            usedChunks: 6,
            unusedChunks: 4,
            duplicateChunks: 2,
            riskyChunks: 1,
            retrievedTokens: 1000,
            usedTokens: 620,
            unusedTokens: 380,
            efficiencyPct: 62,
            duplicateRatePct: 20,
            riskyRatePct: 10,
            latestAt: "2026-05-01T21:45:00.000Z",
          },
        }));
      }
      if (path === "/v1/context/retrieval/events?limit=10") {
        return Promise.resolve(jsonResponse({
          events: [
            {
              id: "retrieval-1",
              tenantId: "tenant-pro",
              optimizationEventId: "evt-1",
              retrievedChunks: 5,
              usedChunks: 3,
              unusedChunks: 2,
              duplicateChunks: 1,
              riskyChunks: 1,
              retrievedTokens: 500,
              usedTokens: 300,
              unusedTokens: 200,
              efficiencyPct: 60,
              duplicateRatePct: 20,
              riskyRatePct: 20,
              usedSourceIds: ["chunk-a", "chunk-b", "chunk-c"],
              unusedSourceIds: ["chunk-c", "chunk-risky"],
              riskySourceIds: ["chunk-risky"],
              createdAt: "2026-05-01T21:45:00.000Z",
            },
          ],
        }));
      }
      return Promise.resolve(jsonResponse({
        events: [
          {
            id: "evt-1",
            tenantId: "tenant-pro",
            inputChunks: 5,
            outputChunks: 3,
            droppedChunks: 2,
            inputTokens: 500,
            outputTokens: 300,
            savedTokens: 200,
            reductionPct: 40,
            duplicateSourceIds: ["chunk-b", "chunk-c"],
            riskScanned: true,
            flaggedChunks: 1,
            quarantinedChunks: 1,
            riskySourceIds: ["chunk-risky"],
            riskDetails: [
              {
                id: "chunk-risky",
                decision: "quarantine",
                ruleName: "Context injection",
                matchedContent: "ignore previous instructions",
              },
            ],
            createdAt: "2026-05-01T21:00:00.000Z",
          },
        ],
      }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Context Optimizer")).toBeInTheDocument();
    expect(screen.getByText("270")).toBeInTheDocument();
    expect(screen.getByText("10 input chunks scanned")).toBeInTheDocument();
    expect(screen.getByText("27%")).toBeInTheDocument();
    expect(screen.getByText("chunk-b")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-c").length).toBeGreaterThan(0);
    expect(screen.getByText("Risky Chunks")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-risky").length).toBeGreaterThan(0);
    expect(screen.getByText("Quality Delta")).toBeInTheDocument();
    expect(screen.getByText("Regression")).toBeInTheDocument();
    expect(screen.getByText("refunds#1")).toBeInTheDocument();
    expect(screen.getByText("Retrieval Efficiency")).toBeInTheDocument();
    expect(screen.getByText("Unused Context")).toBeInTheDocument();
    expect(screen.getAllByText("chunk-risky").length).toBeGreaterThan(0);
  });

  it("shows the empty state", async () => {
    mockedFetch.mockImplementation((path) => {
      if (path === "/v1/context/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            inputChunks: 0,
            outputChunks: 0,
            droppedChunks: 0,
            inputTokens: 0,
            outputTokens: 0,
            savedTokens: 0,
            reductionPct: 0,
            flaggedChunks: 0,
            quarantinedChunks: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            regressedCount: 0,
            avgRawScore: null,
            avgOptimizedScore: null,
            avgDelta: null,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/quality/events?limit=10") {
        return Promise.resolve(jsonResponse({ events: [] }));
      }
      if (path === "/v1/context/retrieval/summary") {
        return Promise.resolve(jsonResponse({
          summary: {
            eventCount: 0,
            retrievedChunks: 0,
            usedChunks: 0,
            unusedChunks: 0,
            duplicateChunks: 0,
            riskyChunks: 0,
            retrievedTokens: 0,
            usedTokens: 0,
            unusedTokens: 0,
            efficiencyPct: 0,
            duplicateRatePct: 0,
            riskyRatePct: 0,
            latestAt: null,
          },
        }));
      }
      if (path === "/v1/context/retrieval/events?limit=10") {
        return Promise.resolve(jsonResponse({ events: [] }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("No context optimization events yet.")).toBeInTheDocument();
    expect(screen.getByText("No context quality checks yet.")).toBeInTheDocument();
    expect(screen.getByText("No context retrieval events yet.")).toBeInTheDocument();
  });

  it("shows upgrade messaging for gated tenants", async () => {
    mockedFetch.mockResolvedValue(jsonResponse({
      error: { message: "Your current plan does not include this feature." },
      gate: { upgradeUrl: "https://provara.xyz/dashboard/billing" },
    }, { status: 402 }));

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Upgrade required")).toBeInTheDocument();
    expect(screen.getByText("Your current plan does not include this feature.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Billing" })).toHaveAttribute(
      "href",
      "https://provara.xyz/dashboard/billing",
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith("/v1/context/summary"));
  });
});
