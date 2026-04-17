import type { Metadata } from "next";
import { AuthProvider } from "../lib/auth-context";
import { ToastProvider } from "../components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Provara",
  description: "Multi-provider LLM gateway",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
