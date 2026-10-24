# AGENTS.md

Instructions for coding agents working in this repository.

## Scope

- This repo is the private API of ChatterPay Analytics. The site repo is `chatterpay-analytics-site`.
- Metrics come from aggregates in the analytics database. Only the ingestion (`src/ingest/`, behind `POST /v1/internal/ingest`) reads the ChatterPay B2C database (read-only) or calls a provider, within its per-run budget; request handlers never do. Do not copy production data into fixtures.
- `LIVE_METRIC_GROUPS` states which metric groups are live; the others stay synthetic. Changing how B2C rows become metrics requires a new `LIVE_DATASET_VERSION`.
- Mock datasets live in this repo, never in the site.

## Code rules

- TypeScript strict; `any` is forbidden. Exported functions declare their return type (enforced by `isolatedDeclarations` in `yarn type-check`) and carry JSDoc.
- Identifiers, comments and log messages in English. Comments explain constraints and decisions, not what a line does. No dates in comments.
- Request input is validated with schemas; MongoDB queries never take operators from client input.
- Error responses use `ApiError` / the shared handler: `{ code, message, requestId }`, no stack traces or internal messages for 5xx.
- Logs never contain JWTs, cookies, access codes, connection strings or emails in clear text.
- The activity log never stores access codes or tokens. Every `verify-code` failure answers the same generic 401, and `request-code` answers the same for members and unknown emails.
- Persistence goes through the `Store` interface (`src/store/types.ts`). A store method that checks an invariant (last active admin, pending invite, challenge attempts) performs the check and the write atomically; routes never split them across calls.
- Every route declares its querystring and response schemas; run `yarn openapi` in the same change so `openapi/openapi.yaml` matches.
- Changing the mock generator output requires a new `DATASET_VERSION`.

## Before committing

Run `yarn pre-commit` and leave `git status` clean. Commit messages follow `[type] :gitmoji: message`, one line, English, imperative, at most 80 characters.
