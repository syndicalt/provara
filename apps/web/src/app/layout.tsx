import type { Metadata } from "next";
import { AuthProvider } from "../lib/auth-context";
import { ToastProvider } from "../components/toast";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.provara.xyz"),
  title: {
    default: "Provara — The Adaptive LLM Gateway",
    template: "%s · Provara",
  },
  description:
    "Routes every request. Learns from every response. Catch provider regressions, cut spend at equal quality, and answer 'why did our bill double?' in one screen. Self-host or Cloud.",
  openGraph: {
    title: "Provara — The Adaptive LLM Gateway",
    description:
      "Routes every request. Learns from every response. Built for teams shipping AI-powered products who've outgrown raw API access.",
    url: "https://www.provara.xyz",
    siteName: "Provara",
    images: [
      {
        url: "/provara.png",
        width: 3021,
        height: 1617,
        alt: "Provara — The Adaptive LLM Gateway",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Provara — The Adaptive LLM Gateway",
    description:
      "Routes every request. Learns from every response. Self-host or Cloud.",
    images: ["/provara.png"],
  },
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
