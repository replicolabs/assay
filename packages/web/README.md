# @assay/web

The human web frontend for Assay: a single-screen app that takes a task
description, calls the gateway for a ranked agent shortlist, and renders it
with the hallmark/receipt visual language described in the product spec —
confidence as a stamped mark, never a bare score.

## Run it

```bash
# from packages/web
NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first" npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` type-checks (`tsc -b`)
and produces a production build in `dist/`.

## Data source: gateway vs. fixtures

All data fetching goes through one call site: `src/api/client.ts` →
`fetchAssessment(request)`. Nothing else in the app (`App.tsx`, components)
knows or cares whether the `Assessment` it renders came from the real
gateway or a local fixture.

`POST /v1/web/lookup` isn't wired up on the gateway yet (other milestones are
still in progress), so there are two ways fixture data gets used instead of a
live response:

1. **Explicit** — force fixtures on regardless of backend state:
   - Set the build-time env var `VITE_USE_FIXTURES=true` (e.g. in a `.env`
     file in this package, or `VITE_USE_FIXTURES=true npm run dev`), **or**
   - Append `?mock=1` to the page URL (e.g. `http://localhost:5173/?mock=1`)
     — useful for sharing a demo link without rebuilding.
2. **Automatic fallback** — if neither flag above is set, the client still
   tries `POST /v1/web/lookup` first. If that call fails for any reason
   (network error, non-2xx status, the route not existing yet), it silently
   falls back to a fixture so the UI stays demoable today.

Once the gateway route is live, case 2 simply stops falling back on its own
— no component code changes required. Fixtures live in `src/api/fixtures.ts`
as three hand-written `Assessment` objects (a Solidity-audit request with
three candidates spanning `high_confidence` → `unproven`, one candidate with
`divergence_flag: true` and `consistency_variance: "high"`; a copy-editing
request; and a single-candidate data-engineering request) matching
`packages/gateway/src/api/contracts.ts` exactly. `fetchAssessment` picks
among them with a light keyword match against the submitted task summary so
demos feel responsive to input.

## Types

Types are imported directly from `packages/gateway/src/api/contracts.ts` via
a relative `import type` (no local duplication) — this resolved cleanly
under the existing `moduleResolution: "bundler"` config since `zod` is
hoisted to the repo-root `node_modules` by the npm workspace.

## Structure

- `src/api/client.ts` — `fetchAssessment`, the single data-fetching call site.
- `src/api/fixtures.ts` — hand-written fixture `Assessment`s.
- `src/App.tsx` — task-input form + result rendering.
- `src/components/ShortlistView.tsx` — ranked list of candidate cards.
- `src/components/CandidateCard.tsx` — one candidate: reasoning, hallmark, evidence, terms.
- `src/components/ConfidenceHallmark.tsx` — the stamp/seal confidence mark.
- `src/components/EvidencePanel.tsx` — the evidence "receipt" (canary score, disputes, variance, drift/divergence callouts).
- `src/styles.css` — design tokens and all styling (plain CSS, no framework).
