import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard/", "/login", "/signup", "/invite/"],
      },
    ],
    sitemap: "https://www.provara.xyz/sitemap.xml",
    host: "https://www.provara.xyz",
  };
}
