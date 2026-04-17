"use client";

import { useEffect } from "react";

const SCALAR_CDN = "https://cdn.jsdelivr.net/npm/@scalar/api-reference";

export default function ApiDocsPage() {
  useEffect(() => {
    // Scalar's standalone build looks for a <script id="api-reference">
    // element with data-url + data-configuration, then renders next to it.
    // We append directly to body (where Scalar expects to mount) instead of
    // wrapping in a React tree node — otherwise we'd end up with an orphan
    // div taking up a full viewport before the real content renders.
    const configScript = document.createElement("script");
    configScript.id = "api-reference";
    configScript.setAttribute("data-url", "/openapi.yaml");
    configScript.setAttribute(
      "data-configuration",
      JSON.stringify({
        theme: "kepler",
        darkMode: true,
        // classic = single-column, expandable-section layout. Avoids the horizontal
        // request-builder rail that caused body-wide horizontal scroll in `modern`.
        layout: "classic",
        hideClientButton: false,
        metaData: { title: "Provara Gateway API · Reference" },
      }),
    );
    document.body.appendChild(configScript);

    const loader = document.createElement("script");
    loader.src = SCALAR_CDN;
    loader.async = true;
    document.body.appendChild(loader);

    // Belt-and-suspenders: any stray overflow inside Scalar's rendered tree
    // (long code samples, auto-generated schema tables) shouldn't push the page
    // sideways. Only apply on this route; restored on unmount so other pages
    // keep their default scrolling.
    const prevOverflowX = document.documentElement.style.overflowX;
    document.documentElement.style.overflowX = "hidden";

    return () => {
      configScript.remove();
      loader.remove();
      document.querySelectorAll(".scalar-app, scalar-api-reference").forEach((el) => el.remove());
      document.documentElement.style.overflowX = prevOverflowX;
    };
  }, []);

  return null;
}
