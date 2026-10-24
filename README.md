# chatterpay-b2c-analytics-api

Private backend of ChatterPay Analytics. It serves the analytics datasets, the demo login and the team management to the BFF of the site (`chatterpay-b2c-analytics-site`). Browsers never call it directly.

In V0 every metric is synthetic: responses carry `dataStatus: "mock"` and the site labels them `DEMO DATA`. The API does not read ChatterPay B2C collections, blockchains or providers.

## Stack

- Node.js 22.12+ or 24 (the container runs 24), TypeScript strict, ES modules.
- Fastify 5 with JSON Schema validation and `@fastify/helmet`.
- Biome for lint and format, Vitest for tests, Yarn 1 with a frozen lockfile.
- MongoDB (analytics-only database) for sessions, invites, login attempts and audit, added in the persistence phase.

## Local development

```sh
yarn install --frozen-lockfile
yarn dev
```

The server listens on `http://127.0.0.1:4001`. `yarn dev` loads `.env` when it exists; every variable has a default, see `.env.example` for the names.

| Script | Purpose |
|---|---|
| `yarn dev` | Watch mode with `tsx` |
| `yarn build` / `yarn start` | Compile to `dist/` and run the compiled server |
| `yarn lint:fix` | Biome lint + format with fixes |
| `yarn lint:ci` | Biome check without writing, as in CI |
| `yarn type-check` | `tsc` over sources and tests, plus explicit-type check of exported declarations |
| `yarn test` / `yarn test:coverage` | Vitest |
| `yarn pre-commit` | `lint:fix`, `type-check` and `test` |

## Endpoints

The contract lives in [`openapi/openapi.yaml`](openapi/openapi.yaml) (OpenAPI 3.1). The site generates its client from that file.

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness, no internal details |
| `GET /readyz` | Readiness; will check MongoDB once persistence is added |

Every error response has the shape `{ code, message, requestId }`. The `x-request-id` response header echoes a valid incoming id (8-64 characters, letters, digits and dashes) or a generated UUID.

## Deployment

- Cloud Run service per environment (`chatterpay-analytics-dev-api`, `chatterpay-analytics-api`) that requires authenticated invocations: only the service account of the site has `roles/run.invoker`.
- No public custom domain. The BFF calls the `*.run.app` URL with a Google-signed ID token whose audience is that URL.
- The container listens on `0.0.0.0:8080` as the non-root `node` user.
- Secrets come from Secret Manager at runtime; nothing is passed as build argument.

Public domains belong to the site: `dev.analytics.chatterpay.net` and `analytics.chatterpay.net`.
