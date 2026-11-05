# Stoat Control — AG Grid and AG Charts

## Workspaces

1. **Economy overview:** mission counts, obligations by status, captured/reconciled totals, policy denials, integrity status.
2. **Agents:** identity, role, status, current run, limits, trace drill-down.
3. **Exchange:** services, provider, capability, price, verification profile.
4. **Quotes and agreements:** scope, price, expiry, policy decision, immutable agreement view.
5. **Event stream:** ordered events, actor, mission, correlation ID, hash-chain status.
6. **Deliveries:** artifact, provider run, verifier verdict, individual checks, revision history.
7. **Obligations:** amount, currency, agreement, status, reservation and hold.
8. **Settlement:** batch items, approval, PayPal order/capture, webhook and reconciliation.
9. **Policy and trust:** policy version, denials, holds, approvals, watchdog events.
10. **Integrity:** balance by currency, chain continuity, duplicate obligations, orphan reservations, batch sum, capture reconciliation.

## Functional requirements

- All rows from API, not hardcoded mock arrays.
- Stable `getRowId` based on immutable ID.
- Server-side pagination or cursor pagination for large datasets.
- Sorting/filtering mapped to allowlisted API query parameters.
- Row selection and detail panel drill-down.
- Async transaction updates for event stream where appropriate.
- Clear empty, loading, error and stale states.
- Keyboard navigation and accessible labels.
- Currency displayed in every money column.
- Status distinguishes live, seeded, replayed and mocked.
- Destructive actions require confirmation and server authorization.

## Charts

Use real aggregate endpoints:
- obligations by status;
- mission spend vs budget;
- event volume over time;
- capture/reconciliation outcomes;
- policy denials by reason.

Charts are explanatory, not sources of truth. Clicking chart segments filters the corresponding grid. Do not infer missing values or display simulated data as live.

## Performance

Batch frequent event updates. Avoid rerendering the full grid for every event. Use server-side filtering for large data. Test with 1,000+ events and stable row identities.
