"use client";

import { PublicNav } from "../../components/public-nav";

export default function ModelsPage() {
  return (
    <>
      <PublicNav />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <h1 className="text-3xl font-bold mb-4">Models</h1>
        <p className="text-zinc-400">
          Model catalog coming soon. Browse all available models across providers with pricing and performance data.
        </p>
      </div>
    </>
  );
}
