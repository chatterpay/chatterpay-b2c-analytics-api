# AGENTS.md

Instructions for coding agents working in this repository.

## Scope

- This repo is the private API of ChatterPay Analytics. The site repo is `chatterpay-b2c-analytics-site`.
- V0 serves synthetic data only. Do not connect to ChatterPay B2C collections, blockchains, RPC providers or signers, and do not copy production data into fixtures.
- Mock datasets live in this repo, never in the site.

## Code rules

- TypeScript strict; `any` is forbidden. Exported functions declare their return type (enforced by `isolatedDeclarations` in `yarn type-check`) and carry JSDoc.
- Identifiers, comments and log messages in English. Comments explain constraints and decisions, not what a line does. No dates in comments.
- Request input is validated with schemas; MongoDB queries never take operators from client input.
- Error responses use `ApiError` / the shared handler: `{ code, message, requestId }`, no stack traces or internal messages for 5xx.
- Logs never contain JWTs, cookies, access codes, connection strings or emails in clear text.
- Every route declares its querystring and response schemas; run `yarn openapi` in the same change so `openapi/openapi.yaml` matches.
- Changing the mock generator output requires a new `DATASET_VERSION`.

## Before committing

Run `yarn pre-commit` and leave `git status` clean. Commit messages follow `[type] :gitmoji: message`, one line, English, imperative, at most 80 characters.
