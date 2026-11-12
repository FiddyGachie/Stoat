/**
 * Static UI/UX + docs verifier. No browser is available, so this checks source
 * and build output only. It does NOT prove visual fidelity: that needs a human
 * or a real browser run. Report: .agents/reports/ui-qa.json
 * Usage: tsx scripts/verify/ui.ts [--fast]   (--fast skips tsc + vite build)
 */
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";

type Owner =
  | "design-system-agent"
  | "navigation-ux-agent"
  | "user-docs-agent"
  | "admin-docs-agent"
  | "ui-qa-agent";
interface Check {
  owner: Owner;
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
const check = (owner: Owner, name: string, ok: boolean, detail?: string) =>
  checks.push({ owner, name, ok, detail: ok ? undefined : detail });

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const walk = (dir: string, exts: string[], acc: string[] = []): string[] => {
  for (const n of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, n);
    if (n === "node_modules" || n === "dist") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, exts, acc);
    else if (exts.includes(extname(n))) acc.push(rel);
  }
  return acc;
};

// ---- colour maths (WCAG 2.x) ----
const lum = (hex: string) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const tokens = read("console/src/styles/tokens.css");
const layout = read("console/src/styles/layout.css");
const root = tokens.split(/:root\s*\{/)[1]?.split("}")[0] ?? "";
const v = (name: string) =>
  new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root)?.[1];

// ---- design system ----
const html = read("console/index.html");
check(
  "design-system-agent",
  "Google Fonts stylesheet linked with display=swap",
  /fonts\.googleapis\.com\/css2\?[^"]*display=swap/.test(html),
);
check(
  "design-system-agent",
  "Fonts preconnect present",
  /rel="preconnect"\s+href="https:\/\/fonts\.googleapis\.com"/.test(html) &&
    /fonts\.gstatic\.com/.test(html),
);
check(
  "design-system-agent",
  "Heading + UI families named",
  /Plus\+Jakarta\+Sans/.test(html) && /Inter/.test(html),
);
check(
  "design-system-agent",
  "System font fallback stacks",
  /--font-[a-z]+:[^;]*(system-ui|sans-serif)/.test(tokens),
);

const pairs: [string, string, number][] = [
  ["--text-primary", "--surface-solid", 4.5],
  ["--text-secondary", "--surface-solid", 4.5],
  ["--text-muted", "--surface-solid", 4.5],
  ["--text-primary", "--bg-base", 4.5],
  ["--text-muted", "--bg-base", 4.5],
  ["--text-muted", "--surface-muted", 4.5],
  ["--text-on-primary", "--color-primary", 4.5],
];
for (const [fg, bg, min] of pairs) {
  const a = v(fg),
    b = v(bg);
  const r = a && b ? ratio(a, b) : 0;
  check(
    "design-system-agent",
    `Contrast ${fg} on ${bg} >= ${min}`,
    r >= min,
    `got ${r.toFixed(2)} (${a} / ${b})`,
  );
}
const bg = v("--bg-base");
check(
  "design-system-agent",
  "Light theme (bg luminance > 0.85)",
  !!bg && lum(bg) > 0.85,
  `bg=${bg}`,
);
check(
  "design-system-agent",
  "Glass: backdrop-filter used",
  /backdrop-filter/.test(layout) || /backdrop-filter/.test(tokens),
);
check(
  "design-system-agent",
  "Glass: @supports fallback",
  /@supports not/.test(tokens + layout),
);
check(
  "design-system-agent",
  "Reduced motion / transparency / contrast handled",
  /prefers-reduced-motion/.test(tokens + layout) &&
    /prefers-reduced-transparency/.test(tokens + layout) &&
    /prefers-contrast/.test(tokens + layout),
);
check(
  "design-system-agent",
  "Adaptive card grid (auto-fit/minmax)",
  /repeat\(auto-fit,\s*minmax\(/.test(layout),
);
check(
  "design-system-agent",
  "Responsive breakpoints >= 2",
  (layout.match(/@media \(max-width/g) ?? []).length >= 2,
);
check(
  "design-system-agent",
  "Visible focus style",
  /:focus-visible/.test(layout + tokens),
);

const tsx = walk("console/src", [".tsx"]);
const rawHex = tsx.filter((f) =>
  /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/.test(
    read(f).replace(/&#\d+;|href="#[^"]*"|"#[a-z-]+"|'#[a-z-]+'/g, ""),
  ),
);
check(
  "design-system-agent",
  "No raw hex colours in TSX (use tokens)",
  rawHex.length === 0,
  rawHex.join(", "),
);
const iconFiles = tsx.filter((f) => /from "lucide-react"/.test(read(f)));
check(
  "design-system-agent",
  "Icon set (lucide-react) used in >= 5 files",
  iconFiles.length >= 5,
  `${iconFiles.length} files`,
);
const iconOnly: string[] = [];
for (const f of tsx) {
  for (const m of read(f).matchAll(
    /<button\b[^>]*>\s*<(?:Icon|[A-Z][A-Za-z]+)\b[^>]*\/>\s*<\/button>/g,
  )) {
    if (!/aria-label|title=/.test(m[0])) iconOnly.push(f);
  }
}
check(
  "design-system-agent",
  "Icon-only buttons have accessible names",
  iconOnly.length === 0,
  iconOnly.join(", "),
);

// AG Charts 14 draws nothing (and throws) unless each series type's module is registered.
{
  const chartPanel = read("console/src/components/ChartPanel.tsx");
  const registered = /ModuleRegistry\.registerModules\(/.test(chartPanel);
  const used = new Set<string>();
  for (const f of tsx)
    for (const m of read(f).matchAll(
      /type:\s*["'](bar|line|pie|donut|area|scatter|bubble|histogram)["']/g,
    ))
      used.add(m[1]);
  const moduleFor: Record<string, string> = {
    bar: "BarSeriesModule",
    line: "LineSeriesModule",
    pie: "PieSeriesModule",
    donut: "DonutSeriesModule",
    area: "AreaSeriesModule",
    scatter: "ScatterSeriesModule",
    bubble: "BubbleSeriesModule",
    histogram: "HistogramSeriesModule",
  };
  const registeredList =
    /ModuleRegistry\.registerModules\(\[([\s\S]*?)\]\)/.exec(chartPanel)?.[1] ??
    "";
  const missing = [...used].filter(
    (s) => !new RegExp(`\\b${moduleFor[s]}\\b`).test(registeredList),
  );
  check(
    "design-system-agent",
    "AG Charts modules registered for every chart type used",
    registered && missing.length === 0,
    registered
      ? `not registered: ${missing.join(", ")}`
      : "ChartPanel never calls ModuleRegistry.registerModules",
  );
}

// ---- navigation ----
const app = read("console/src/App.tsx");
const navIds = [
  ...(
    app.split("NAV_GROUPS: NavGroup[] =")[1]?.split("const ALL_ITEMS")[0] ?? ""
  ).matchAll(/id:\s*"([a-z-]+)"/g),
].map((m) => m[1]);
const wsBlock = app.split("const WORKSPACES")[1]?.split("};")[0] ?? "";
const wsIds = [...wsBlock.matchAll(/^\s*"?([a-z-]+)"?:\s*</gm)].map(
  (m) => m[1],
);
check(
  "navigation-ux-agent",
  "14 nav items defined",
  navIds.length === 14,
  `found ${navIds.length}`,
);
check(
  "navigation-ux-agent",
  "Every nav id has a workspace",
  navIds.every((i) => wsIds.includes(i)),
  `missing: ${navIds.filter((i) => !wsIds.includes(i)).join(",")}`,
);
check(
  "navigation-ux-agent",
  "Hash routing + hashchange",
  /location\.hash/.test(app) && /hashchange/.test(app),
);
check(
  "navigation-ux-agent",
  "Skip link",
  /skip-link/.test(app) && /\.skip-link/.test(layout),
);
check(
  "navigation-ux-agent",
  "Landmarks: nav aria-label, main id, page title",
  /<nav aria-label=/.test(app) &&
    /<main id="main"/.test(app) &&
    /id="page-title"/.test(app + read("console/src/components/ui.tsx")),
);
check(
  "navigation-ux-agent",
  "aria-current on active nav",
  /aria-current/.test(app),
);
check(
  "navigation-ux-agent",
  "Mobile drawer with close control",
  /Open navigation menu/.test(app) && /Close navigation menu/.test(app),
);
check(
  "navigation-ux-agent",
  "Session-expiry handled",
  /SESSION_EXPIRED_EVENT/.test(app),
);
check(
  "navigation-ux-agent",
  "Docs links in shell and portals",
  /\/docs\/user-guide\.html/.test(
    app + read("console/src/components/HelpLinks.tsx"),
  ) &&
    /HelpLinks/.test(read("console/src/workspaces/BuyerPortal.tsx")) &&
    /HelpLinks/.test(read("console/src/workspaces/AgentPortal.tsx")),
);
const unlabeled: string[] = [];
for (const f of tsx)
  for (const m of read(f).matchAll(/<input\b[^>]*>/g))
    if (
      !/aria-label|id=|aria-labelledby/.test(m[0]) &&
      !/type="hidden"/.test(m[0])
    )
      unlabeled.push(f);
const inputsInLabel = tsx.filter((f) =>
  /<label[^>]*>[\s\S]*?<input/.test(read(f)),
);
check(
  "navigation-ux-agent",
  "Inputs are labelled",
  unlabeled.every((f) => inputsInLabel.includes(f)),
  [...new Set(unlabeled.filter((f) => !inputsInLabel.includes(f)))].join(", "),
);

// ---- docs ----
const user = existsSync(join(ROOT, "docs/USER_GUIDE.md"))
  ? read("docs/USER_GUIDE.md")
  : "";
const admin = existsSync(join(ROOT, "docs/ADMIN_GUIDE.md"))
  ? read("docs/ADMIN_GUIDE.md")
  : "";
check(
  "user-docs-agent",
  "USER_GUIDE.md exists and is substantial",
  user.length > 3000,
);
check(
  "admin-docs-agent",
  "ADMIN_GUIDE.md exists and is substantial",
  admin.length > 3000,
);
const labels = [
  ...(
    app.split("NAV_GROUPS: NavGroup[] =")[1]?.split("const ALL_ITEMS")[0] ?? ""
  ).matchAll(/label:\s*"([^"]+)",\s*icon/g),
].map((m) => m[1]);
check(
  "admin-docs-agent",
  "Every console nav label documented",
  labels.every((l) => admin.includes(l)),
  labels.filter((l) => !admin.includes(l)).join(", "),
);
for (const [owner, name, md] of [
  ["user-docs-agent", "user", user],
  ["admin-docs-agent", "admin", admin],
] as const) {
  check(
    owner,
    `${name} guide cross-links the other guide`,
    /user-guide\.html|USER_GUIDE/.test(admin) &&
      /admin-guide\.html|ADMIN_GUIDE/.test(user),
  );
  void md;
}
const srcText =
  [...walk("src", [".ts"]), ...walk("scripts", [".ts"])].map(read).join("\n") +
  (existsSync(join(ROOT, ".env.example")) ? read(".env.example") : "") +
  (existsSync(join(ROOT, "render.yaml")) ? read("render.yaml") : "");
const apiText = walk("src", [".ts"]).map(read).join("\n");
for (const [owner, md] of [
  ["user-docs-agent", user],
  ["admin-docs-agent", admin],
] as const) {
  const paths = [
    ...new Set(
      [
        ...md.matchAll(
          /`(?:GET |POST |PUT |PATCH |DELETE )?(\/v1\/[A-Za-z0-9_/:{}.-]+)`/g,
        ),
      ].map((m) => m[1]),
    ),
  ];
  const bad = paths.filter(
    (p) => !apiText.includes(p.replace(/\{[^}]+\}/g, ":").split(":")[0]),
  );
  check(
    owner,
    `API paths in ${owner === "user-docs-agent" ? "user" : "admin"} guide exist in code`,
    bad.length === 0,
    bad.join(", "),
  );
}
const envs = [
  ...new Set(
    [...admin.matchAll(/`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`/g)].map((m) => m[1]),
  ),
];
const badEnv = envs.filter((e) => !srcText.includes(e));
check(
  "admin-docs-agent",
  "Env vars in admin guide exist in code/.env.example",
  badEnv.length === 0,
  badEnv.join(", "),
);

// contract: every path in API_SPEC.yaml is a route the server really registers
{
  const spec = parseYaml(read("API_SPEC.yaml")) as {
    paths: Record<string, unknown>;
    info: { version: string };
  };
  // Routes live in app.ts and in the agentic modules' *_ROUTE_PATHS lists (each list is asserted
  // against its registered handlers by the module's own tests).
  const appSrc = [
    "src/api/app.ts",
    "src/modules/agentic/agentic.routes.ts",
    "src/modules/mandates/mandate.routes.ts",
    "src/modules/watchdog/watchdog.routes.ts",
    "src/modules/proposals/proposal.routes.ts",
    "src/modules/payments-analytics/analytics.routes.ts",
    "src/modules/agent-tools/agent-tools.routes.ts",
    "src/modules/agent-tools/integrity-check.routes.ts",
  ]
    .map((f) => read(f))
    .join("\n");
  const routes = new Set(
    [...appSrc.matchAll(/"(\/v1\/[^"]+)"/g)].map((m) =>
      m[1].replace(/:[A-Za-z]+/g, ":x"),
    ),
  );
  const missing = Object.keys(spec.paths)
    .map((p) => "/v1" + p.replace(/\{[^}]+\}/g, ":x"))
    .filter((p) => !routes.has(p));
  check(
    "admin-docs-agent",
    "API_SPEC.yaml routes all exist in the server",
    missing.length === 0,
    missing.join(", "),
  );
  check(
    "admin-docs-agent",
    "API_SPEC.yaml is version 2.1.x",
    /^2\.1\./.test(spec.info.version),
    spec.info.version,
  );
}
// generated HTML is current (rebuild is deterministic; hash before/after)
const outs = [
  "console/public/docs/user-guide.html",
  "console/public/docs/admin-guide.html",
  "console/public/docs/docs.css",
];
const hash = () =>
  outs
    .map((f) =>
      existsSync(join(ROOT, f))
        ? createHash("sha256")
            .update(readFileSync(join(ROOT, f)))
            .digest("hex")
        : "missing",
    )
    .join("|");
const before = hash();
const b = spawnSync("npx", ["tsx", "scripts/build-docs.ts"], {
  cwd: ROOT,
  shell: true,
  encoding: "utf8",
});
check(
  "user-docs-agent",
  "Docs HTML builds",
  b.status === 0,
  (b.stderr || "").slice(-300),
);
check(
  "user-docs-agent",
  "Generated docs HTML is current (run npm run docs:build)",
  before === hash(),
  "regenerated output differed",
);
check(
  "user-docs-agent",
  "Docs HTML has title, nav, TOC, skip link",
  outs.slice(0, 2).every((f) => {
    const t = existsSync(join(ROOT, f)) ? read(f) : "";
    return (
      /<title>/.test(t) &&
      /aria-label="On this page"/.test(t) &&
      /class="skip"/.test(t) &&
      !/<script/i.test(t)
    );
  }),
);
check(
  "user-docs-agent",
  "Docs HTML has no unresolved .md links",
  outs.slice(0, 2).every((f) => !/href="[^"]*\.md/.test(read(f))),
);

// ---- builds ----
if (!process.argv.includes("--fast")) {
  const t = spawnSync("npx", ["tsc", "-p", "console/tsconfig.json"], {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
  });
  check(
    "ui-qa-agent",
    "Console type-check",
    t.status === 0,
    (t.stdout || t.stderr).slice(0, 400),
  );
  const vb = spawnSync(
    "npx",
    ["vite", "build", "--config", "console/vite.config.ts"],
    { cwd: ROOT, shell: true, encoding: "utf8" },
  );
  check(
    "ui-qa-agent",
    "Console production build",
    vb.status === 0,
    (vb.stdout + vb.stderr).slice(-400),
  );
}

const failed = checks.filter((c) => !c.ok);
const signal = failed.length === 0 ? "UI_VERIFIED" : "UI_DEFECTS_FOUND";
mkdirSync(join(ROOT, ".agents", "reports"), { recursive: true });
const note =
  "Static analysis and builds only. No browser rendering, screenshots or real-device testing were performed.";
writeFileSync(
  join(ROOT, ".agents", "reports", "ui-qa.json"),
  JSON.stringify(
    {
      signal,
      passed: checks.length - failed.length,
      total: checks.length,
      failed,
      note,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
);
for (const c of checks)
  console.log(
    `${c.ok ? "PASS" : "FAIL"} [${c.owner}] ${c.name}${c.ok ? "" : ` -> ${c.detail ?? ""}`}`,
  );
console.log(
  `\n${signal}: ${checks.length - failed.length}/${checks.length} checks passed`,
);
console.log(`NOTE: ${note}`);
process.exit(failed.length ? 1 : 0);
