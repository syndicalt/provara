import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <strong>Provara</strong>
        <span style={{ marginLeft: 8, opacity: 0.6, fontSize: "0.9em" }}>Docs</span>
      </>
    ),
    url: "/",
  },
  links: [
    { text: "Documentation", url: "/docs" },
    { text: "GitHub", url: "https://github.com/syndicalt/provara" },
    { text: "Dashboard", url: "https://www.provara.xyz/dashboard", external: true },
  ],
};
