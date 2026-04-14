export interface ABTest {
  id: string;
  name: string;
  description?: string;
  variants: ABVariant[];
  status: "active" | "paused" | "completed";
}

export interface ABVariant {
  id: string;
  provider: string;
  model: string;
  weight: number;
}
