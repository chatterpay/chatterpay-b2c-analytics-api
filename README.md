# chatterpay-b2c-analytics-api

Private backend of ChatterPay Analytics. It serves the analytics datasets, the demo login and the team management to the BFF of the site (`chatterpay-b2c-analytics-site`). Browsers never call it directly.

Metrics come from aggregates of the analytics database. A daily ingestion, started by Cloud Scheduler through `POST /v1/internal/ingest`, copies the ChatterPay B2C activity into that database and rebuilds the aggregates. Metric groups without live data yet stay synthetic; `meta.dataStatus` (`live`, `mixed` or `mock`) and `meta.lastUpdatedAt` tell them apart. Request handlers never read the B2C database or a provider.

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

To run an ingestion locally, set `INGEST_DEV_TRIGGER=true` in `.env` and call `curl -X POST http://127.0.0.1:4001/v1/internal/ingest`. It reads the B2C database read-only and writes only to the analytics database; keep `PRICES_PROVIDER=none` unless the provider snapshot is under test.

## Endpoints

The contract lives in [`openapi/openapi.yaml`](openapi/openapi.yaml) (OpenAPI 3.1), generated from the route schemas with `yarn openapi`; CI fails when the committed file is out of date. The site generates its client from that file.

| Route | Access | Purpose |
|---|---|---|
| `GET /healthz` | infrastructure | Liveness, no internal details |
| `GET /readyz` | infrastructure | Readiness; 503 when the store does not answer |
| `GET /v1/metrics/networks` | admin, viewer | Networks of the environment: id, label and family |
| `GET /v1/metrics/overview?network&range` | admin, viewer | Volume, transactions, fees, active and new users; series and network breakdown |
| `GET /v1/metrics/users?network&granularity` | admin, viewer | Daily/monthly/yearly active users, new and total users, retention cohorts |
| `GET /v1/metrics/revenue?network&range` | admin, viewer | Transfer and swap fees, volume, network and asset breakdowns |
| `POST /v1/internal/ingest` | scheduler service account | One ingestion run; returns its summary. 503 when not configured, 401 for any other caller |
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
| `B2C_MONGO_URI` | unset | Connection string of the ChatterPay B2C database, with the database in its path; its `blockchains` collection lists the networks of the environment. Required in production; unset reuses `MONGO_URI` |
| `B2C_MONGO_DB_NAME` | `chatterpay-dev` | B2C database used when `B2C_MONGO_URI` has no database in its path |
| `INGEST_SCHEDULER_SA_EMAIL` | unset | Service account whose Google ID token may call the ingestion endpoint. Unset keeps the endpoint closed (503) unless `INGEST_DEV_TRIGGER` is on |
| `INGEST_OIDC_AUDIENCE` | unset | `aud` of that token, the audience of the scheduler job. Set together with `INGEST_SCHEDULER_SA_EMAIL` |
| `INGEST_DEV_TRIGGER` | `false` | `true` opens the ingestion endpoint to any caller, for local runs. Refused in production |
| `INGEST_BATCH_SIZE` | `1000` | B2C transaction rows per batch, 100-10000 |
| `INGEST_MAX_TRANSACTIONS_PER_RUN` | `50000` | Ceiling on B2C transaction rows read per run |
| `INGEST_REVISIT_HOURS` | `72` | Rows inserted this many hours before a run are read again for status changes; 0 disables |
| `INGEST_MAX_RUN_SECONDS` | `480` | No batch starts after this; below the Cloud Run request timeout and the scheduler attempt deadline |
| `PRICES_PROVIDER` | `none` | `coingecko` takes one daily USD snapshot of the non-stable tokens; `none` values them with swap-implied prices only |
| `PRICES_MAX_CALLS_PER_RUN` | `1` | Ceiling on price provider requests per run, 0-5 |
| `METRICS_REFRESH_SECONDS` | `300` | How often an instance looks for a newer aggregate build |

## Persistence

| Collection | Content | Indexes |
|---|---|---|
| `users` | Members; removed members keep their record | `email_active_unique` (unique `email` where `status` is `active`), `status_role` |
| `sessions` | Issued session JWTs by `jti` | `user_id`, `expires_at_ttl` |
| `login_challenges` | Login challenges; never the code | `expires_at_ttl` |
| `invites` | Simulated invites | `email_pending_unique` (unique `email` where `status` is `simulated`), `mutation_id_unique`, `created_at` |
| `activity` | Login and team events | `at` |
| `rate_limits` | Fixed-window counters | `reset_at_ttl` |
| `ingest_state` | Ingestion checkpoints (`checkpoints`), run lock (`lock`) and last aggregate build (`aggregates`) | default |
| `b2c_transactions` | Copy of the B2C `transactions` rows, keyed by the B2C `_id` | default |
| `b2c_users` | Id, `creationDate` and wallets (chain id, address) of the B2C users; no phone, name or email | default |
| `b2c_tokens` / `b2c_networks` | Copies of the B2C token list and of the networks with their public contract addresses | default |
| `token_prices` | USD price per symbol and day from the provider | default |
| `agg_hourly` / `agg_user_activity` / `agg_user_signups` | Aggregates of the last build: facts per network and hour, active hours per user, signups | default |

- The API does not create indexes. `REQUIRED_INDEXES` in `src/store/mongo-schema.ts` lists them, and startup fails naming the missing ones.
- Members exist only in the database. The first admin of a new database is inserted by an operator; the rest join through invites.
- Invariants hold without multi-document transactions: unique indexes for one active member and one pending invite per email and one invite per `mutationId`, conditional single-document updates for challenges and invite transitions, and a compensating update for the last active admin (two concurrent changes that would each remove it can both be undone).
- The in-memory store is refused in production and logs a warning elsewhere.
- `MONGO_TEST_URI=mongodb://127.0.0.1:27017 yarn test` runs the route suites on MongoDB, each test on a throwaway database that is dropped afterwards.

## Ingestion

`POST /v1/internal/ingest` runs `runIngestion` (`src/ingest/run.ts`):

1. Takes the lock in `ingest_state`; a run that finds it taken answers 200 with `status: locked`. The lock expires `INGEST_MAX_RUN_SECONDS` plus 5 minutes after it is taken.
2. Copies B2C `transactions` rows with an `_id` above the checkpoint, in batches, saving the checkpoint after each batch. Copies are keyed by the B2C `_id`, so a repeated read replaces instead of duplicating.
3. Reads again the rows inserted in the last `INGEST_REVISIT_HOURS`, for rows whose status changes after insertion (Polymarket orders).
4. Replaces the copies of `users`, `tokens` and `blockchains`.
5. With `PRICES_PROVIDER=coingecko`, requests one USD snapshot per UTC day; the day is marked before the request, so a failing provider is asked once a day at most.
6. Rebuilds every aggregate from the copies and records the build instant.

Steps 2 and 3 stop starting batches at `INGEST_MAX_TRANSACTIONS_PER_RUN` rows or `INGEST_MAX_RUN_SECONDS`; the run answers `status: partial` and the next run continues from the checkpoint. The instance that ran the ingestion loads the new aggregates at once; the others within `METRICS_REFRESH_SECONDS`.

Admitted callers: the Google-signed ID token in `Authorization: Bearer` is verified against Google's keys, with `iss` `https://accounts.google.com`, `aud` equal to `INGEST_OIDC_AUDIENCE`, `email` equal to `INGEST_SCHEDULER_SA_EMAIL` and `email_verified`. Cloud Run IAM admits the site service account too, which is why the API checks the identity itself; the site sends its identity in `X-Serverless-Authorization` and a session JWT in `Authorization`, so it never passes. Locally, `INGEST_DEV_TRIGGER=true` admits any caller.

Valuation and counting (`src/metrics/live.ts`):

- Counted operations: completed `transfer` rows and completed swaps, one per transaction hash and chain. Deposits and Polymarket rows are copied but not counted. Rows of chains outside the catalog are not counted.
- A swap is valued and attributed on its input leg. Its USD value is the stable leg when either leg is stable; otherwise the input amount times the price of the day.
- Stable tokens (`type: 'stable'`) are 1 USD. Other tokens take the swap-implied price of the day, or the provider snapshot; a day without a price takes the closest earlier day, then the closest later one. Operations without any price are valued at zero and counted as `unpriced` in the summary.
- Fees are the `fee` field of the operation, in its token, as the backend computed it; they are not reconciled against charges.
- Active users are the senders of counted operations (B2C user id, or the address when it belongs to no user). New and total users come from `users.creationDate` on each network of the user's wallets; wallets have no date of their own. Users without `creationDate` count in totals from the start.

`LIVE_METRIC_GROUPS` in `src/metrics/sources.ts` lists which metric groups (`activity`, `activeUsers`, `signups`, `retention`) are served from the aggregates once a build exists; the rest stay synthetic.

## Mock dataset

- Networks: one per document of the `blockchains` collection of the B2C database, sorted by name. The id is the slug of the name (`Base Sepolia` → `base-sepolia`); `family` is `evm` (also when absent) or `cardano`, and documents of other families are skipped. The catalog is read at startup, where a failure stops the process, and every 5 minutes, where a failure keeps the previous catalog. Without Mongo, the catalog is `base-sepolia` and `cardano-preprod`.
- Filters: `network` = `all` or a network id, default `all`; `range` = `today` | `week` | `month` | `year` | `ytd` | `all`, default `month`; `granularity` = `daily` | `monthly` | `yearly`, default `monthly`. Unknown parameters, values and networks answer 400.
- Generated in memory from a seeded function of `(datasetVersion, network, day)`: the same day always yields the same figures on every instance. Activity starts on 2025-01-01 and ends at the current UTC hour.
- `today`, `week`, `month` and `year` are rolling windows of 1, 7, 30 and 365 days; `ytd` starts on January 1; `all` starts at the dataset start and has no comparison. The previous period ends at the same hour, so partial days are compared like for like.
- Every total equals the sum of its series, network breakdown and asset breakdown. Volume counts transfers plus the input side of swaps. Cardano networks have no swaps. Every network of a family uses the same activity template; after the first one, user counts are scaled by a factor derived from the id.
- Amounts are USD decimal strings with 2 places, computed in integer cents. `changeRatio` is a decimal string with 4 places, `null` when the previous value is zero or absent.
- Users are counted per network: a person active on Base and Cardano counts once on each. Distinct active users of a window come from a synthetic model bounded by the users that joined until then.

## Deployment

`cloudbuild.yaml` builds and pushes the image and deploys it to Cloud Run. The same file serves both environments.

| Substitution | Value |
|---|---|
| `_SERVICE_NAME` | `chatterpay-analytics-back-develop` or `chatterpay-analytics-back-main` |
| `_DEPLOY_REGION` / `_AR_HOSTNAME` / `_TRIGGER_ID` | Region, Artifact Registry host, trigger id |

- Server variables (`LOG_LEVEL`, `BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`, `JWT_KEY_ID`, `JWT_ISSUER`, `JWT_AUDIENCE`, `SESSION_TTL_MINUTES`, `CHALLENGE_TTL_MINUTES`, `MONGO_DB_NAME` and the `INGEST_*`, `PRICES_*` and `METRICS_*` variables) are defined in the Cloud Run service YAML. The image only sets `NODE_ENV`, `HOST` and `PORT`; the deploy keeps the variables already defined on the service.
- Secrets never enter the image: `DEMO_ACCESS_CODE`, `JWT_PRIVATE_KEY` and `MONGO_URI` come from Secret Manager through `secretKeyRef` in the Cloud Run service YAML. `MONGO_URI` reads `ANALYTICS_BACKEND_MONGO_CONN_STRING_DEV` / `_MAIN`: the connection string of a database user whose only role is `readWrite` on the analytics database of the same Atlas cluster as the backend.
- The service name selects the VPC: `*-develop` deploys on `chatterpay-dev-vpc` / `chatterpay-dev-run`, `*-main` on `chatterpay-main-vpc` / `chatterpay-main-run`; any other name stops the build.
- The service sits behind the HTTPS load balancer on `dev.back.analytics.chatterpay.net` and `back.analytics.chatterpay.net`, with ingress `internal-and-cloud-load-balancing`. The deploy uses `--no-allow-unauthenticated`: only the service account of the site has `roles/run.invoker`. The BFF sends a Google-signed ID token whose audience is the API domain, declared on the service as a custom audience (`run.googleapis.com/custom-audiences`).
- The container listens on `0.0.0.0:8080` as the non-root `node` user.
- The ingestion is started by a Cloud Scheduler HTTP job: `POST https://<API domain>/v1/internal/ingest`, OIDC token of a dedicated scheduler service account with `roles/run.invoker` on the service, audience equal to the API domain (the same custom audience the site uses), attempt deadline above `INGEST_MAX_RUN_SECONDS`. The Cloud Run request timeout must also exceed `INGEST_MAX_RUN_SECONDS`.

The site is served on `dev.analytics.chatterpay.net` and `analytics.chatterpay.net`.
