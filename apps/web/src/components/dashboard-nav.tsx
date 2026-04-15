"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserMenu } from "./user-menu";

const links = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/providers", label: "Providers" },
  { href: "/dashboard/routing", label: "Routing" },
  { href: "/dashboard/quality", label: "Quality" },
  { href: "/dashboard/ab-tests", label: "A/B Tests" },
  { href: "/dashboard/tokens", label: "Tokens" },
  { href: "/dashboard/api-keys", label: "API Keys" },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center gap-8">
          <Link href="/" className="text-lg font-bold tracking-tight">
            Provara
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400 ml-auto">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`hover:text-zinc-100 transition-colors ${
                  pathname === link.href ? "text-zinc-100" : ""
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
          <UserMenu />
        </div>
      </div>
    </nav>
  );
}
