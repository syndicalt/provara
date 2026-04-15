"use client";

import Link from "next/link";
import { useAuth } from "../lib/auth-context";

const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

export function PublicNav() {
  const { user, loading } = useAuth();

  return (
    <nav className="border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Provara
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400 ml-auto items-center">
            <Link href="/models" className="hover:text-zinc-100 transition-colors">
              Models
            </Link>
            {!loading && (
              user ? (
                <Link
                  href="/dashboard"
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Dashboard
                </Link>
              ) : (
                <Link
                  href="/login"
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Sign In
                </Link>
              )
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
