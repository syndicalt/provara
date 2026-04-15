const colors: Record<string, string> = {
  default: "bg-zinc-800 text-zinc-300",
  coding: "bg-blue-900/50 text-blue-300",
  creative: "bg-purple-900/50 text-purple-300",
  summarization: "bg-green-900/50 text-green-300",
  qa: "bg-amber-900/50 text-amber-300",
  general: "bg-zinc-800 text-zinc-300",
  simple: "bg-emerald-900/50 text-emerald-300",
  medium: "bg-yellow-900/50 text-yellow-300",
  complex: "bg-red-900/50 text-red-300",
};

export function Badge({ children, variant = "default" }: { children: React.ReactNode; variant?: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[variant] || colors.default}`}>
      {children}
    </span>
  );
}
