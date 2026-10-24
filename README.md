# chatterpay-b2c-analytics-api

Private backend of ChatterPay Analytics. It serves the analytics datasets, the demo login and the team management to the BFF of the site (`chatterpay-b2c-analytics-site`). Browsers never call it directly.

In V0 every metric is synthetic: responses carry `dataStatus: "mock"` and the site labels them `DEMO DATA`. The API does not read ChatterPay B2C collections, blockchains or providers.

## Stack

- Node.js 22.12+ or 24 (the container runs 24), TypeScript strict, ES modules.
- Fastify 5 with JSON Schema validation and `@fastify/helmet`.
- Biome for lint and format, Vitest for tests, Yarn 1 with a frozen lockfile.
- `jose` for the session JWTs (EdDSA, Ed25519).
- Persistence behind a store interface (`src/store/types.ts`): MongoDB on an analytics-only database (`src/store/mongo-store.ts`), and an in-memory implementation for tests and local runs without MongoDB.

## Local development

```sh
yarn install --frozen-lockfile
yarn dev
```

The server listens on `http://127.0.0.1:4001`. `yarn dev` loads `.env` when it exists; outside production every variable has a default or is optional, see `.env.example` for the names and [Configuration](#configuration) for the rules.

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
| `GET /readyz` | infrastructure | Readiness; 503 when the store does not answer |
| `GET /v1/metrics/overview?network&range` | admin, viewer | Volume, transactions, fees, active and new users; series and network breakdown |
| `GET /v1/metrics/users?network&granularity` | admin, viewer | Daily/monthly/yearly active users, new and total users, retention cohorts |
| `GET /v1/metrics/revenue?network&range` | admin, viewer | Transfer and swap fees, volume, network and asset breakdowns |
| `POST /v1/auth/request-code` | public (BFF) | Opens a login challenge for an email; 202 `{ challengeId, expiresAt }` |
| `POST /v1/auth/verify-code` | public (BFF) | Exchanges challenge, email and access code for `{ token, expiresAt, user }` |
| `GET /v1/auth/me` | admin, viewer | Member and session expiry behind the bearer token |
| `POST /v1/auth/logout` | admin, viewer | Revokes the session; 204 |
| `GET /v1/team/members` | admin | Active members sorted by email |
| `PATCH /v1/team/members/:id` | admin | Changes the role `{ role }`; 409 when no active admin would remain |
| `DELETE /v1/team/members/:id` | admin | Removes the member and revokes its sessions; 204, 409 when no active admin would remain |
| `GET /v1/team/invites` | admin | Invites, newest first |
| `POST /v1/team/invites` | admin | Creates an invite `{ email, role, mutationId }`; 201, idempotent by `mutationId`, 409 for members and pending invites |
| `POST /v1/team/invites/:id/resend` | admin | Simulates a new delivery of a pending invite; 409 when not pending |
| `POST /v1/team/invites/:id/revoke` | admin | Revokes a pending invite; 409 when not pending |
| `GET /v1/team/activity?limit` | admin | Login and team events, newest first; `limit` 1-100, default 50 |

Every error response has the shape `{ code, message, requestId }`. The `x-request-id` response header echoes a valid incoming id (8-64 characters, letters, digits and dashes) or a generated UUID. Auth, team and metrics responses carry `Cache-Control: private, no-store`. Request bodies are JSON only; unknown body or query properties answer 400 and path ids must be UUIDs.

## Authentication

1. The BFF calls `request-code` with the email and forwards the browser IP in `x-client-ip` (used only when it is an IPv4 or IPv6 literal; otherwise the socket address applies). A challenge is created for every email, members or not, so the answer reveals nothing. No email is sent and no code is generated: the code is the shared `DEMO_ACCESS_CODE`.
2. The BFF calls `verify-code` with the challenge id, the email and the code. Any failure answers the same 401 `Invalid or expired code`: unknown, expired or consumed challenge, email different from the challenge, wrong code, or an email that is neither an active member nor holder of a pending invite. A challenge admits 5 attempts. The code is compared in constant time (HMAC-SHA256 with a per-process key, then `timingSafeEqual`). Without `DEMO_ACCESS_CODE` the route answers 503.
3. On success the challenge is consumed. An email without an active member but with a pending invite becomes a member with the invite role and the invite turns `accepted`. The API stores a session (`jti`, expiry `SESSION_TTL_MINUTES`) and returns a JWT signed with EdDSA, header `kid`, claims `iss`, `aud`, `sub` (user id), `jti`, `role`, `iat`, `exp`.
4. Protected routes take `Authorization: Bearer <jwt>`. The token is verified with the public key (EdDSA only), issuer and audience; then the session must exist, be neither revoked nor expired, and belong to an active member. The role applied is the current role in the store, not the `role` claim, so role changes and removals apply to the next request.

| Limit | Scope | Window | Answer |
|---|---|---|---|
| 5 `request-code` | normalized email | 15 min | 429 `RATE_LIMITED` with `Retry-After` |
| 20 `request-code` | client IP | 15 min | 429 with `Retry-After` |
| 30 `verify-code` | client IP | 15 min | 429 with `Retry-After` |
| 5 attempts | challenge | challenge lifetime | 401, the challenge stops accepting codes |

Team rules: invites last 7 days and are reported `expired` afterwards; delivery is simulated (status `simulated`, `lastSentAt`, `resendCount`), no email is sent. Role changes and removals never leave the team without an active admin. The activity log records `login`, `login_failed` (only for emails of active members), `logout`, `invite_created`, `invite_resent`, `invite_revoked`, `invite_accepted`, `role_changed` and `member_removed`; it never holds codes or tokens.

## Configuration

`loadEnv` validates the environment at startup and lists invalid variables by name only. Empty values count as unset.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` / `PORT` | `127.0.0.1` / `4001` | The container sets `0.0.0.0` / `8080` |
| `LOG_LEVEL` | `info` | |
| `BODY_LIMIT_BYTES` / `REQUEST_TIMEOUT_MS` | `16384` / `10000` | |
| `DEMO_ACCESS_CODE` | unset | At least 12 characters. Required in production; unset answers 503 on `verify-code` |
| `JWT_PRIVATE_KEY` | unset | PEM PKCS8 Ed25519, `\n` escapes allowed. Required in production; unset generates an ephemeral key at startup (warning logged, sessions end on restart) |
| `JWT_KEY_ID` | `dev` | `kid` header |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `chatterpay-analytics-api` / `chatterpay-analytics-site` | |
| `SESSION_TTL_MINUTES` | `120` | 5-1440 |
| `CHALLENGE_TTL_MINUTES` | `10` | 1-60 |
| `MONGO_URI` | unset | `mongodb://` or `mongodb+srv://`. Required in production; unset uses the in-memory store |
| `MONGO_DB_NAME` | `chatterpay-analytics-dev` | Analytics-only database |

## Persistence

| Collection | Content | Indexes |
|---|---|---|
| `users` | Members; removed members keep their record | `email_active_unique` (unique `email` where `status` is `active`), `status_role` |
| `sessions` | Issued session JWTs by `jti` | `user_id`, `expires_at_ttl` |
| `login_challenges` | Login challenges; never the code | `expires_at_ttl` |
| `invites` | Simulated invites | `email_pending_unique` (unique `email` where `status` is `simulated`), `mutation_id_unique`, `created_at` |
| `activity` | Login and team events | `at` |
| `rate_limits` | Fixed-window counters | `reset_at_ttl` |

- The API does not create indexes. `REQUIRED_INDEXES` in `src/store/mongo-schema.ts` lists them, and startup fails naming the missing ones.
- Members exist only in the database. The first admin of a new database is inserted by an operator; the rest join through invites.
- Invariants hold without multi-document transactions: unique indexes for one active member and one pending invite per email and one invite per `mutationId`, conditional single-document updates for challenges and invite transitions, and a compensating update for the last active admin (two concurrent changes that would each remove it can both be undone).
- The in-memory store is refused in production and logs a warning elsewhere.
- `MONGO_TEST_URI=mongodb://127.0.0.1:27017 yarn test` runs the route suites on MongoDB, each test on a throwaway database that is dropped afterwards.

## Mock dataset

- Filters: `network` = `all` | `base` (Base Sepolia) | `cardano` (Cardano Preprod), default `all`; `range` = `today` | `week` | `month` | `year` | `ytd` | `all`, default `month`; `granularity` = `daily` | `monthly` | `yearly`, default `daily`. Unknown parameters or values answer 400.
- Generated in memory from a seeded function of `(datasetVersion, network, day)`: the same day always yields the same figures on every instance. Activity starts on 2025-01-01 and ends at the current UTC hour.
- `today`, `week`, `month` and `year` are rolling windows of 1, 7, 30 and 365 days; `ytd` starts on January 1; `all` starts at the dataset start and has no comparison. The previous period ends at the same hour, so partial days are compared like for like.
- Every total equals the sum of its series, network breakdown and asset breakdown. Volume counts transfers plus the input side of swaps. Cardano has no swaps.
- Amounts are USD decimal strings with 2 places, computed in integer cents. `changeRatio` is a decimal string with 4 places, `null` when the previous value is zero or absent.
- Users are counted per network: a person active on Base and Cardano counts once on each. Distinct active users of a window come from a synthetic model bounded by the users that joined until then.

## Deployment

`cloudbuild.yaml` writes the trigger substitutions to `.env` (`CreateEnv`), turns the names declared as `ARG` in the `Dockerfile` into build arguments, builds and pushes the image, and deploys it to Cloud Run. The same file serves both environments.

| Substitution | Value |
|---|---|
| `_SERVICE_NAME` | `chatterpay-analytics-api-develop` or `chatterpay-analytics-api-main` |
| `_DEPLOY_REGION` / `_AR_HOSTNAME` / `_TRIGGER_ID` | Region, Artifact Registry host, trigger id |
| `_LOG_LEVEL`, `_BODY_LIMIT_BYTES`, `_REQUEST_TIMEOUT_MS`, `_JWT_KEY_ID`, `_JWT_ISSUER`, `_JWT_AUDIENCE`, `_SESSION_TTL_MINUTES`, `_CHALLENGE_TTL_MINUTES`, `_MONGO_DB_NAME` | Non-secret settings; empty applies the default |

- A new non-secret variable is added to `CreateEnv` and as `ARG`/`ENV` in the `Dockerfile`.
- Secrets never enter the image: `DEMO_ACCESS_CODE`, `JWT_PRIVATE_KEY` and `MONGO_URI` come from Secret Manager through `secretKeyRef` in the Cloud Run service YAML. The `Build` step skips these names if they are ever declared as `ARG`.
- The service name selects the VPC: `*-develop` deploys on `chatterpay-dev-vpc` / `chatterpay-dev-run`, `*-main` on `chatterpay-main-vpc` / `chatterpay-main-run`; any other name stops the build.
- The service sits behind the HTTPS load balancer on `dev.analytics-api.chatterpay.net` and `analytics-api.chatterpay.net`, with ingress `internal-and-cloud-load-balancing`. The deploy uses `--no-allow-unauthenticated`: only the service account of the site has `roles/run.invoker`. The BFF sends a Google-signed ID token whose audience is the API domain, declared on the service as a custom audience (`run.googleapis.com/custom-audiences`).
- The container listens on `0.0.0.0:8080` as the non-root `node` user.

The site is served on `dev.analytics.chatterpay.net` and `analytics.chatterpay.net`.
