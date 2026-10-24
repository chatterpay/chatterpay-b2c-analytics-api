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
| `yarn openapi` / `yarn openapi:check` | Regenerate `openapi/openapi.yaml` from the route schemas / fail when it is out of date |
| `yarn pre-commit` | `lint:fix`, `type-check` and `test` |

## Endpoints

The contract lives in [`openapi/openapi.yaml`](openapi/openapi.yaml) (OpenAPI 3.1), generated from the route schemas with `yarn openapi`; CI fails when the committed file is out of date. The site generates its client from that file.

| Route | Access | Purpose |
|---|---|---|
| `GET /healthz` | infrastructure | Liveness, no internal details |
| `GET /readyz` | infrastructure | Readiness; will check MongoDB once persistence is added |
| `GET /v1/metrics/overview?network&range` | admin, viewer | Volume, transactions, fees, active and new users; series and network breakdown |
| `GET /v1/metrics/users?network&granularity` | admin, viewer | Daily/monthly/yearly active users, new and total users, retention cohorts |
| `GET /v1/metrics/revenue?network&range` | admin, viewer | Transfer and swap fees, volume, network and asset breakdowns |

Every error response has the shape `{ code, message, requestId }`. The `x-request-id` response header echoes a valid incoming id (8-64 characters, letters, digits and dashes) or a generated UUID.

Until the login flow exists, the metrics routes answer 401 to every request: the default authenticator admits nobody. Tests inject their own authenticator through `buildApp`.

## Mock dataset

- Filters: `network` = `all` | `base` (Base Sepolia) | `cardano` (Cardano Preprod), default `all`; `range` = `today` | `week` | `month` | `year` | `ytd` | `all`, default `month`; `granularity` = `daily` | `monthly` | `yearly`, default `daily`. Unknown parameters or values answer 400.
- Generated in memory from a seeded function of `(datasetVersion, network, day)`: the same day always yields the same figures on every instance. Activity starts on 2025-01-01 and ends at the current UTC hour.
- `today`, `week`, `month` and `year` are rolling windows of 1, 7, 30 and 365 days; `ytd` starts on January 1; `all` starts at the dataset start and has no comparison. The previous period ends at the same hour, so partial days are compared like for like.
- Every total equals the sum of its series, network breakdown and asset breakdown. Volume counts transfers plus the input side of swaps. Cardano has no swaps.
- Amounts are USD decimal strings with 2 places, computed in integer cents. `changeRatio` is a decimal string with 4 places, `null` when the previous value is zero or absent.
- Users are counted per network: a person active on Base and Cardano counts once on each. Distinct active users of a window come from a synthetic model bounded by the users that joined until then.

## Deployment

- Cloud Run service per environment (`chatterpay-analytics-dev-api`, `chatterpay-analytics-api`) that requires authenticated invocations: only the service account of the site has `roles/run.invoker`.
- No public custom domain. The BFF calls the `*.run.app` URL with a Google-signed ID token whose audience is that URL.
- The container listens on `0.0.0.0:8080` as the non-root `node` user.
- Secrets come from Secret Manager at runtime; nothing is passed as build argument.

Public domains belong to the site: `dev.analytics.chatterpay.net` and `analytics.chatterpay.net`.
