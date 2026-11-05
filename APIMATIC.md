# APIMatic Integration Plan

## Purpose

Use APIMatic as a real contract tool, not a logo or unsupported claim. OpenAPI is canonical. APIMatic may validate/lint the contract, generate a TypeScript SDK, and optionally publish a developer portal or context workflow if account entitlement permits.

## Workflow

1. Validate `API_SPEC.yaml` with OpenAPI 3.1-compatible tooling.
2. Import into APIMatic and run definition validation.
3. Fix warnings that affect correctness; document intentional deviations.
4. Generate TypeScript client into a generated-only directory.
5. Build the buyer agent's API wrapper using generated SDK for at least one meaningful call path.
6. Add contract tests comparing runtime responses to schemas.
7. Record APIMatic project/export evidence and tool version.
8. If access is unavailable, state that clearly and use a local OpenAPI validator; do not claim APIMatic use.

## Rules

Generated code is never hand-edited. Regenerate after contract change. Keep generated SDK version aligned with OpenAPI version. Never expose credentials in SDK defaults or browser code.
