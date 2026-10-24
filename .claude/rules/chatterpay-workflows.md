# ChatterPay workflow rules — ChatterPay Analytics API

The three `/chatterpay-*` skills are **manual, explicit** workflows. Do not invoke them automatically.

## Repositories

- This repo is the private API of ChatterPay Analytics. `origin` → `chatterpay/chatterpay-analytics-api`. The site and BFF live in `chatterpay/chatterpay-analytics-site`. Verify both with `git remote -v` before building issue links.
- Issue numbers belong to one repository: `#8` in the API does not identify `#8` in the site.
- The repo has no `.doc/development/coding-guidelines.md`. `AGENTS.md` sets the commit format `[type] :gitmoji: message`: one line, English, imperative, at most 80 characters. Types and icons come from the catalog in the reference. Do not invent types or icons.

## Components

Use these areas to describe changes and to group deploy notes:

- Application and server: `src/app.ts` (`buildApp`), `src/server.ts`.
- Routes and schemas: `src/routes` (health, metrics, auth, team, shared schemas and representations).
- Mock metrics: `src/metrics` (seeded generator, ranges, calendar, overview, users, revenue). Changing the generator output requires a new `DATASET_VERSION`.
- Demo login and sessions: `src/auth` (access code, session token, JWT authenticator, principal, client IP).
- Team management and storage: `src/store` (memory store, bootstrap) and the team routes.
- Errors: `src/errors/api-error.ts` and `src/plugins/error-handler.ts`, with the `{ code, message, requestId }` shape.
- Configuration: `src/config/env.ts`; variable names in `.env.example`.
- Contract: `openapi/openapi.yaml`, generated from the route schemas by `scripts/generate-openapi.ts`. The site generates its client from that file.
- Tests: `test/` (Vitest).
- Deployment: `Dockerfile`, Cloud Build trigger and a private Cloud Run service per environment (IAM-only invocation from the site service account).

## Checks

- Before proposing commits, run the non-writing checks: `yarn lint:ci`, `yarn type-check`, `yarn test` and `yarn openapi:check`.
- When a route, a schema or a representation changes, `openapi/openapi.yaml` is regenerated with `yarn openapi` in the same change; `yarn openapi:check` fails otherwise, as in CI. Report failures instead of hiding them.
- `yarn pre-commit` runs `lint:fix` and rewrites files. The text-generation skills never run it; it belongs to the implementation step, before the commit commands are handed over.

## Destinations

- Deploy notes: the operator provides the paths of the develop and main deploy notes. Do not assume a location, do not create the files, and do not read or list anything else in that folder.
- PR texts: printed in the console only. No file is created.

## Restrictions

- Never mark develop work as deployed to main automatically. Both deploy documents are potential destinations, not a mandate to duplicate every item.
- Never execute `git add`, `git commit`, `git push`, PR creation, deployments, Cloud Build or Cloud Run operations, `gcloud` mutations or database writes. Commits are only command suggestions; the deploy workflow writes only the deploy notes the operator named.
- Never read `.env` or other files with secrets; `.env.example` lists the variable names.
- For each command, load the full procedure from `.claude/docs/chatterpay-workflows-reference.md`, falling back to the copy in the user home when available.
