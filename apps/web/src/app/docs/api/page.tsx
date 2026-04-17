"use client";

import { useEffect } from "react";

const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";

export default function ApiDocsPage() {
  useEffect(() => {
    // Scalar's standalone build looks for a <script id="api-reference">
    // element with data-url + data-configuration, then renders next to it.
    // We create those via DOM APIs to sidestep Next.js's JSX <script> warnings.
    const configScript = document.createElement("script");
    configScript.id = "api-reference";
    configScript.setAttribute("data-url", "/openapi.yaml");
    configScript.setAttribute(
      "data-configuration",
      JSON.stringify({
        theme: "kepler",
        darkMode: true,
        layout: "modern",
        hideClientButton: false,
        metaData: { title: "Provara Gateway API · Reference" },
      }),
    );
    document.body.appendChild(configScript);

    const loader = document.createElement("script");
    loader.src = SCALAR_CDN;
    loader.async = true;
    document.body.appendChild(loader);

    return () => {
      configScript.remove();
      loader.remove();
      // Scalar injects its own DOM next to the config script; tear it down
      // when the route unmounts so client-side nav back to the page re-inits.
      document.querySelectorAll(".scalar-app, scalar-api-reference").forEach((el) => el.remove());
    };
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Scalar renders itself into the body via the loader script. */}
    </div>
  );
}
