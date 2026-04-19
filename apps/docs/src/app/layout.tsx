import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import type { ReactNode } from "react";

export const metadata = {
  title: { default: "Provara Docs", template: "%s · Provara Docs" },
  description:
    "Documentation for Provara — the self-hostable LLM operations platform with adaptive routing, regression detection, and cost migration.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
