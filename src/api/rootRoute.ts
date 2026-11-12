import type { Request, Response } from 'express';

/**
 * Root route handler — serves a simple HTML landing page so localhost:3000
 * isn't a dead end. Links to the key API endpoints.
 */
export function rootRouteHandler(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Stoat API v2.1</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;padding:48px;max-width:680px;margin:0 auto;line-height:1.6}
    h1{font-size:24px;margin-bottom:4px}
    a{color:#38bdf8;text-decoration:none}
    a:hover{text-decoration:underline}
    code{background:#1e2235;padding:2px 6px;border-radius:3px;font-size:13px}
    ul{list-style:none;padding:0}
    li{padding:8px 0;border-bottom:1px solid #1e2235}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#22c55e22;color:#22c55e;border:1px solid #22c55e44}
  </style>
</head>
<body>
  <h1>Stoat API <span class="badge">v2.1.0</span></h1>
  <p>Verified-delivery payments layer for autonomous software agents.</p>

  <h3>Endpoints</h3>
  <ul>
    <li><a href="/v1/health">GET /v1/health</a> &mdash; service health check</li>
    <li><a href="/v1/ready">GET /v1/ready</a> &mdash; readiness (DB connectivity)</li>
    <li><a href="/v1/openapi.yaml">GET /v1/openapi.yaml</a> &mdash; OpenAPI 3.1 contract</li>
    <li>GET /v1/services &mdash; list services (requires auth)</li>
    <li>GET /v1/missions &mdash; list missions (requires auth)</li>
    <li>GET /v1/integrity &mdash; integrity report (requires auth)</li>
    <li>POST /v1/mcp &mdash; MCP JSON-RPC endpoint (requires auth)</li>
  </ul>

  <h3>Quick start</h3>
  <p>Run <code>npm run demo</code> for the full end-to-end mission, or <code>npm run evidence</code> to generate evidence.</p>
  <p>Operator console: <code>npm run console</code> (starts on port 5173).</p>
</body>
</html>`);
}
