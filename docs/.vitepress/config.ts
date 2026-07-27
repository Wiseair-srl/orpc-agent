import { defineConfig } from "vitepress";
import type MarkdownIt from "markdown-it";

/**
 * Links that leave the docs tree (to repository-root files) are served by
 * wrapper pages under /appendix (and /roadmap), which @include the root
 * markdown. This plugin rewrites both directions:
 *  - doc links like `../../ROADMAP.md` → the wrapper page;
 *  - links inside included root files like `docs/security/x.md` → site paths.
 */
const LINK_REWRITES: [RegExp, string][] = [
  [/^(?:\.\.\/)+ROADMAP\.md/, "/roadmap"],
  [/^(?:\.\.\/)*CONTRIBUTING\.md/, "/appendix/contributing"],
  [/^(?:\.\.\/)*SECURITY\.md/, "/appendix/security-policy"],
  [/^(?:\.\.\/)*GOVERNANCE\.md/, "/appendix/governance"],
  [/^(?:\.\.\/)*CODE_OF_CONDUCT\.md/, "/appendix/code-of-conduct"],
  [/^ROADMAP\.md/, "/roadmap"],
  [/^docs\/(.+?)\.md/, "/$1"],
];

function rewriteRepoLinks(md: MarkdownIt): void {
  md.core.ruler.push("orpc-agent-repo-links", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline" || !token.children) continue;
      for (const child of token.children) {
        if (child.type !== "link_open") continue;
        const href = child.attrGet("href");
        if (!href) continue;
        for (const [pattern, replacement] of LINK_REWRITES) {
          if (pattern.test(href)) {
            child.attrSet("href", href.replace(pattern, replacement));
            break;
          }
        }
      }
    }
  });
}

const SITE_URL = "https://orpc-agent.dev";

export default defineConfig({
  title: "oRPC Agent",
  description:
    "Governed capabilities: make AI agents first-class clients of your oRPC application.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,

  sitemap: { hostname: SITE_URL },

  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
    ["meta", { name: "theme-color", content: "#0d9488" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "oRPC Agent" }],
  ],

  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/((^|\/)index)?\.md$/, "$2");
    const url = `${SITE_URL}/${path}`;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: pageData.title || "oRPC Agent" }],
    );
  },

  markdown: {
    config: rewriteRepoLinks,
  },

  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "oRPC Agent",

    search: {
      provider: "local",
      options: {
        detailedView: true,
      },
    },

    outline: { level: [2, 3], label: "On this page" },

    nav: [
      { text: "Guide", link: "/getting-started", activeMatch: "^/(getting-started|guides)" },
      { text: "Concepts", link: "/concepts/capabilities", activeMatch: "^/concepts/" },
      { text: "Reference", link: "/reference/metadata", activeMatch: "^/(reference|adapters)/" },
      { text: "Security", link: "/security/security-model", activeMatch: "^/security/" },
      { text: "Examples", link: "/examples/customer-support-agent", activeMatch: "^/examples/" },
      {
        text: "Project",
        activeMatch: "^/(roadmap|open-questions|faq|glossary|implementation|contributing|appendix)",
        items: [
          { text: "Roadmap", link: "/roadmap" },
          { text: "Open questions", link: "/open-questions" },
          { text: "FAQ", link: "/faq" },
          { text: "Glossary", link: "/glossary" },
          { text: "Contributing", link: "/appendix/contributing" },
          { text: "Security policy", link: "/appendix/security-policy" },
        ],
      },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting started", link: "/getting-started" },
          { text: "FAQ", link: "/faq" },
          { text: "Glossary", link: "/glossary" },
        ],
      },
      {
        text: "Concepts",
        collapsed: false,
        items: [
          { text: "Capabilities", link: "/concepts/capabilities" },
          { text: "The registry", link: "/concepts/registry" },
          { text: "The agent runtime", link: "/concepts/runtime" },
          { text: "Context and actors", link: "/concepts/context" },
          { text: "Policies", link: "/concepts/policies" },
          { text: "Approvals", link: "/concepts/approvals" },
          { text: "Errors", link: "/concepts/errors" },
          { text: "Lifecycle walkthrough", link: "/concepts/lifecycle" },
        ],
      },
      {
        text: "Guides",
        collapsed: false,
        items: [
          { text: "Defining capabilities", link: "/guides/defining-capabilities" },
          { text: "Capability exposure", link: "/guides/capability-exposure" },
          { text: "Adding policies", link: "/guides/adding-policies" },
          { text: "Human approval", link: "/guides/human-approval" },
          { text: "Auditing", link: "/guides/auditing" },
          { text: "Application context", link: "/guides/application-context" },
          { text: "Headless invocations", link: "/guides/headless-invocations" },
          { text: "Workflow steps", link: "/guides/workflow-steps" },
          { text: "MCP authentication", link: "/guides/mcp-authentication" },
          { text: "Testing capabilities", link: "/guides/testing-capabilities" },
          { text: "Migrating existing tools", link: "/guides/migrating-existing-tools" },
        ],
      },
      {
        text: "Reference",
        collapsed: false,
        items: [
          { text: "Capability metadata", link: "/reference/metadata" },
          { text: "Core", link: "/reference/core" },
          { text: "Runtime", link: "/reference/runtime" },
          { text: "Errors", link: "/reference/errors" },
          { text: "Events and tracing", link: "/reference/events" },
          { text: "Configuration", link: "/reference/configuration" },
        ],
      },
      {
        text: "Adapters",
        collapsed: false,
        items: [
          { text: "Vercel AI SDK", link: "/adapters/ai-sdk" },
          { text: "MCP", link: "/adapters/mcp" },
          { text: "Postgres persistence", link: "/adapters/postgres" },
          { text: "OpenTelemetry", link: "/adapters/opentelemetry" },
          { text: "Testing", link: "/adapters/testing" },
        ],
      },
      {
        text: "Security",
        collapsed: false,
        items: [
          { text: "Security model", link: "/security/security-model" },
          { text: "Threat model", link: "/security/threat-model" },
          { text: "Authorization", link: "/security/authorization" },
          { text: "Prompt injection", link: "/security/prompt-injection" },
          { text: "Sensitive data", link: "/security/sensitive-data" },
          { text: "Idempotency and retries", link: "/security/idempotency-and-retries" },
        ],
      },
      {
        text: "Architecture",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/overview" },
          { text: "Package boundaries", link: "/architecture/package-boundaries" },
          { text: "Adapter model", link: "/architecture/adapter-model" },
          { text: "Execution pipeline", link: "/architecture/execution-pipeline" },
          { text: "Decision records (ADRs)", link: "/architecture/decisions" },
        ],
      },
      {
        text: "Examples",
        items: [
          { text: "Customer-support agent", link: "/examples/customer-support-agent" },
          { text: "Mastra task board", link: "/examples/mastra-task-board" },
        ],
      },
      {
        text: "Project",
        collapsed: true,
        items: [
          { text: "Roadmap", link: "/roadmap" },
          { text: "Open questions", link: "/open-questions" },
          { text: "Implementation brief", link: "/implementation/brief" },
          { text: "Milestones", link: "/implementation/milestones" },
          { text: "Development", link: "/contributing/development" },
          { text: "Documentation", link: "/contributing/documentation" },
          { text: "Governance", link: "/contributing/governance" },
          { text: "Release process", link: "/contributing/release-process" },
          { text: "Contributing", link: "/appendix/contributing" },
          { text: "Security policy", link: "/appendix/security-policy" },
          { text: "Project governance", link: "/appendix/governance" },
          { text: "Code of conduct", link: "/appendix/code-of-conduct" },
        ],
      },
    ],

    footer: {
      message:
        "Independent community project — not affiliated with or endorsed by the oRPC maintainers.",
      copyright: "Released under the MIT License.",
    },

    docFooter: { prev: "Previous", next: "Next" },
  },
});
