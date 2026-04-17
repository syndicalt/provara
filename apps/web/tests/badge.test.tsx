import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../src/components/badge";

describe("Badge", () => {
  it("renders children text", () => {
    render(<Badge>coding</Badge>);
    expect(screen.getByText("coding")).toBeInTheDocument();
  });

  it("applies variant-specific classes", () => {
    const { container } = render(<Badge variant="complex">complex</Badge>);
    const el = container.querySelector("span");
    expect(el?.className).toContain("bg-red-900/50");
    expect(el?.className).toContain("text-red-300");
  });

  it("falls back to default variant for unknown keys", () => {
    const { container } = render(<Badge variant="unknown-xyz">x</Badge>);
    const el = container.querySelector("span");
    expect(el?.className).toContain("bg-zinc-800");
  });
});
