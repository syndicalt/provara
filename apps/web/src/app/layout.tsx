import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Provara",
  description: "Multi-provider LLM gateway",
};

function Nav() {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center gap-8">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Provara
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-zinc-100 transition-colors">
              Dashboard
            </Link>
            <Link href="/dashboard/routing" className="hover:text-zinc-100 transition-colors">
              Routing
            </Link>
            <Link href="/dashboard/ab-tests" className="hover:text-zinc-100 transition-colors">
              A/B Tests
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 antialiased">
        <Nav />
        {children}
      </body>
    </html>
  );
}
