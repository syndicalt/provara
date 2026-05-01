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
            latestAt: "2026-05-01T21:00:00.000Z",
          },
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
            createdAt: "2026-05-01T21:00:00.000Z",
          },
        ],
      }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("Context Optimizer")).toBeInTheDocument();
    expect(screen.getByText("270")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("27%")).toBeInTheDocument();
    expect(screen.getByText("chunk-b")).toBeInTheDocument();
    expect(screen.getByText("chunk-c")).toBeInTheDocument();
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
            latestAt: null,
          },
        }));
      }
      return Promise.resolve(jsonResponse({ events: [] }));
    });

    render(<ContextOptimizerPanel />);

    expect(await screen.findByText("No context optimization events yet.")).toBeInTheDocument();
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
