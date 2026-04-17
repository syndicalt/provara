"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

export default function ApiDocsPage() {
  return (
    <div className="overflow-x-hidden">
      <ApiReferenceReact
        configuration={{
          url: "/openapi.yaml",
          theme: "kepler",
          darkMode: true,
          // classic = single-column expandable-section layout. The modern
          // three-column layout blew out viewport width; classic avoids the
          // right-rail request builder pushing horizontal scroll.
          layout: "classic",
          hideClientButton: false,
          metaData: { title: "Provara Gateway API · Reference" },
        }}
      />
    </div>
  );
}
