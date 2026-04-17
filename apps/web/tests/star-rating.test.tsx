import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StarRating } from "../src/components/chat/StarRating";

describe("StarRating", () => {
  it("renders 5 star buttons", () => {
    render(<StarRating onChange={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(5);
  });

  it("calls onChange with the clicked star value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StarRating onChange={onChange} />);
    await user.click(screen.getByLabelText("Rate 4 of 5"));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("highlights stars up to the current value", () => {
    const { container } = render(<StarRating value={3} onChange={() => {}} />);
    const buttons = container.querySelectorAll("button");
    // First 3 should have amber-400 (filled), last 2 zinc-700 (empty)
    expect(buttons[0].className).toContain("text-amber-400");
    expect(buttons[2].className).toContain("text-amber-400");
    expect(buttons[3].className).toContain("text-zinc-700");
    expect(buttons[4].className).toContain("text-zinc-700");
  });
});
