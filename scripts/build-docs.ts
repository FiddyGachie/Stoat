/**
 * Converts docs/USER_GUIDE.md and docs/ADMIN_GUIDE.md into static HTML under
 * console/public/docs so the console host serves them at /docs/*.html.
 * Small purpose-built converter: no dependencies. Input is escaped first.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "console", "public", "docs");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s: string) =>
  s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function inline(raw: string): string {
  let s = esc(raw);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, href) => {
    const safe = /^(https?:|\/|#|mailto:)/.test(href) ? href : "#";
    let h = safe.replace(/^\.?\/?(?:docs\/)?USER_GUIDE\.md/, "/docs/user-guide.html").replace(/^\.?\/?(?:docs\/)?ADMIN_GUIDE\.md/, "/docs/admin-guide.html");
    h = h.replace(/^(?:\.\/)?USER_GUIDE\.md/, "/docs/user-guide.html").replace(/^(?:\.\/)?ADMIN_GUIDE\.md/, "/docs/admin-guide.html");
    const ext = /^https?:/.test(h) ? ' rel="noopener noreferrer" target="_blank"' : "";
    return `<a href="${h}"${ext}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);
}

function render(md: string): { html: string; toc: { level: number; id: string; text: string }[]; title: string } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const toc: { level: number; id: string; text: string }[] = [];
  let title = "Stoat";
  let i = 0;
  const used = new Set<string>();
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      let id = slug(h[2]) || "section";
      while (used.has(id)) id += "-x";
      used.add(id);
      if (level === 1) title = h[2];
      else if (level <= 3) toc.push({ level, id, text: h[2].replace(/[`*]/g, "") });
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>"
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<aside class="callout">${inline(buf.join(" "))}</aside>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[3]); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|```|>|\|.*\|\s*$|---+\s*$|\s*([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return { html: out.join("\n"), toc, title };
}

function page(file: string, other: { href: string; label: string }, active: string): string {
  const md = readFileSync(join(ROOT, "docs", file), "utf8");
  const { html, toc, title } = render(md);
  const tocHtml = toc
    .map((t) => `<li class="l${t.level}"><a href="#${t.id}">${esc(t.text)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f4f7fb">
<title>${esc(title)} · Stoat</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="/docs/docs.css">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="bar">
  <a class="brand" href="/">Stoat</a>
  <nav aria-label="Documentation">
    <a href="/docs/user-guide.html"${active === "user" ? ' aria-current="page"' : ""}>User guide</a>
    <a href="/docs/admin-guide.html"${active === "admin" ? ' aria-current="page"' : ""}>Admin guide</a>
    <a class="open" href="/">Open console</a>
  </nav>
</header>
<div class="layout">
  <nav class="toc" aria-label="On this page"><p>On this page</p><ul>${tocHtml}</ul></nav>
  <main id="content">
${html}
<p class="other">Looking for something else? <a href="${other.href}">${other.label}</a></p>
  </main>
</div>
</body>
</html>
`;
}

const CSS_EXTRA = `
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 10% -10%,#e3ebfb 0,transparent 60%),var(--bg-base,#f4f7fb);color:var(--text-primary,#16202e);font:16px/1.65 var(--font-body,Inter,system-ui,sans-serif)}
h1,h2,h3,h4{font-family:var(--font-heading,"Plus Jakarta Sans",Inter,system-ui,sans-serif);line-height:1.25;color:var(--text-primary,#16202e);scroll-margin-top:80px}
h1{font-size:2rem;margin:0 0 .5rem}h2{font-size:1.4rem;margin:2.2rem 0 .6rem;padding-top:1rem;border-top:1px solid rgba(20,40,80,.1)}h3{font-size:1.1rem;margin:1.6rem 0 .4rem}
a{color:#2754c5}a:focus-visible,.skip:focus{outline:3px solid #2754c5;outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px;top:8px;background:#fff;padding:8px 12px;z-index:10}.skip:focus{left:8px}
.bar{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 24px;background:rgba(255,255,255,.85);border-bottom:1px solid rgba(20,40,80,.1)}
@supports (backdrop-filter:blur(8px)){.bar{background:rgba(255,255,255,.65);backdrop-filter:blur(14px) saturate(160%)}}
.brand{font:800 1.2rem var(--font-heading,"Plus Jakarta Sans",sans-serif);color:#16202e;text-decoration:none}
.bar nav{display:flex;gap:6px;flex-wrap:wrap}.bar nav a{padding:6px 12px;border-radius:999px;text-decoration:none;color:#35435a;font-weight:500}
.bar nav a[aria-current=page]{background:#e3ebfb;color:#1d3f96}.bar nav a.open{background:#2754c5;color:#fff}
.layout{display:grid;grid-template-columns:minmax(200px,260px) minmax(0,1fr);gap:32px;max-width:1120px;margin:0 auto;padding:24px}
.toc{position:sticky;top:76px;align-self:start;max-height:calc(100vh - 100px);overflow:auto;padding:16px;border-radius:16px;background:rgba(255,255,255,.7);border:1px solid rgba(20,40,80,.1);font-size:.9rem}
.toc p{margin:0 0 8px;font-weight:600}.toc ul{list-style:none;margin:0;padding:0}.toc li{margin:4px 0}.toc .l3{padding-left:14px}.toc a{text-decoration:none;color:#35435a}.toc a:hover{color:#2754c5}
main{background:rgba(255,255,255,.8);border:1px solid rgba(20,40,80,.1);border-radius:20px;padding:28px 32px;min-width:0;box-shadow:0 8px 30px rgba(20,40,80,.06)}
code{background:#eef2f9;padding:1px 6px;border-radius:6px;font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#101a2e;color:#e8eefb;padding:16px;border-radius:12px;overflow:auto}pre code{background:none;color:inherit;padding:0}
.table-wrap{overflow-x:auto;margin:1rem 0}table{border-collapse:collapse;width:100%;font-size:.93rem}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid rgba(20,40,80,.12);vertical-align:top}th{background:#eef2f9}
.callout{border-left:4px solid #2754c5;background:#eef3ff;padding:10px 16px;border-radius:0 12px 12px 0;margin:1rem 0}
hr{border:0;border-top:1px solid rgba(20,40,80,.12);margin:2rem 0}.other{margin-top:2.5rem;color:#4a586e}
@media (max-width:860px){.layout{grid-template-columns:1fr;padding:12px}.toc{position:static;max-height:none}main{padding:18px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
html{scroll-behavior:smooth}
`;

mkdirSync(OUT, { recursive: true });
const tokens = readFileSync(join(ROOT, "console", "src", "styles", "tokens.css"), "utf8").replace(/\r\n/g, "\n");
writeFileSync(join(OUT, "docs.css"), `/* Generated by scripts/build-docs.ts. Do not edit. */\n${tokens}\n${CSS_EXTRA}`);
writeFileSync(join(OUT, "user-guide.html"), page("USER_GUIDE.md", { href: "/docs/admin-guide.html", label: "Read the admin guide" }, "user"));
writeFileSync(join(OUT, "admin-guide.html"), page("ADMIN_GUIDE.md", { href: "/docs/user-guide.html", label: "Read the user guide" }, "admin"));
console.log("docs built ->", OUT);
