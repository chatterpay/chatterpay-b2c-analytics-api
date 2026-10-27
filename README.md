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

Local runs use the `simulated` email provider, which sends nothing, so an emailed code reaches nobody. Sign-in locally goes through the demo accounts: `DEMO_LOGIN_ENABLED=true`, `DEMO_LOGIN_EMAILS` with the demo members of the local database and `DEMO_ACCESS_CODE`. `OTP_HMAC_SECRET` and `OTP_EMAIL_HMAC_SECRET` go in `.env` as described in [Login code keys](#login-code-keys); without them each restart generates new keys.

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
| `GET /v1/metrics/networks` | admin, viewer | Networks the statistics show: id, label and family of the catalog networks no admin hid |
| `GET /v1/metrics/overview?network&range` | admin, viewer | Volume, transactions, fees, active and new users; series and network breakdown; TVL, top tokens, top countries, volume by product |
| `GET /v1/metrics/users?network&granularity` | admin, viewer | Daily/monthly/yearly active users, new and total users, retention cohorts; new wallets, retention at 1/3/6 months |
| `GET /v1/metrics/revenue?network&range` | admin, viewer | Transfer and swap fees, volume, swap volume, network and asset breakdowns; average fee per transaction, Polymarket volume, fees by product, master wallets |
| `POST /v1/internal/ingest` | scheduler service account | One ingestion run; returns its summary. 503 when not configured, 401 for any other caller |
| `POST /v1/auth/request-code` | public (BFF) | Opens a login challenge for `{ email, locale? }` and emails the code; 202 `{ challengeId, expiresAt, delivery, codeLength }`, 429 `RATE_LIMITED` with `Retry-After` |
| `POST /v1/auth/verify-code` | public (BFF) | Exchanges challenge, email and code for `{ token, expiresAt, user }` |
| `GET /v1/auth/me` | admin, viewer | Member and session expiry behind the bearer token |
| `POST /v1/auth/logout` | admin, viewer | Revokes the session; 204 |
| `GET /v1/team/members` | admin | Active members, blocked ones included, sorted by email, with `name`, `status` (`active` or `blocked`), `blockedAt`, `lastLoginAt`, `lastActivityAt` and `loginLockedUntil` |
| `PATCH /v1/team/members/:id` | admin | Changes the role `{ role }`; 409 when no active admin would remain |
| `DELETE /v1/team/members/:id` | admin | Removes the member and revokes its sessions and open login code; 204, 409 when no active admin would remain |
| `POST /v1/team/members/:id/block` | admin | Blocks the member and revokes its sessions and open login code; 200 with the member, 403 `CANNOT_BLOCK_SELF`, 409 when no unblocked admin would remain |
| `POST /v1/team/members/:id/unblock` | admin | Lifts the block; 200 with the member. Opens no session and brings back no session or code |
| `POST /v1/team/members/:id/unlock-login` | admin | Clears the automatic wait between login codes of the member; 204 |
| `GET /v1/team/invites?view&limit&cursor` | admin | Invites of one view, newest first: `pending` (default) or `history` (accepted, revoked and expired); `limit` 1-100, default 25; `nextCursor` of the next page of the same view and `counts` of both views |
| `POST /v1/team/invites` | admin | Creates an invite `{ email, role, mutationId, locale? }` and emails it; 201 with its `delivery`, idempotent by `mutationId` (a replay sends no email), 409 for members and pending invites |
| `POST /v1/team/invites/:id/resend` | admin | Emails a pending invite again; 409 when not pending |
| `POST /v1/team/invites/:id/revoke` | admin | Revokes a pending invite; 409 when not pending |
| `GET /v1/team/activity?limit` | admin | Login and team events, newest first; `limit` 1-100, default 50 |
| `GET /v1/admin/networks` | admin | Every network of the catalog, hidden ones included: `id`, `chainId`, `label`, `family`, `analyticsEnabled`, `b2cEnabled` (informative), `sourcePresent`, with the policy `revision` |
| `PATCH /v1/admin/networks/:chainId` | admin | Shows or hides a network in the statistics `{ analyticsEnabled, expectedRevision }`; 409 `CONFIG_CONFLICT` for a stale revision, 409 `LAST_ENABLED_NETWORK` when no network would stay visible, 404 for a chain id outside the catalog |

### Network visibility

Three independent settings apply to a network:

- B2C `blockchains.enabled` and `tokens.enabled` decide whether B2C accepts new operations. The analytics read every document whatever its `enabled`: the ingestion copies the rows, users, tokens and networks of disabled networks, reads their balances through their endpoint, and their history stays valued. `GET /v1/admin/networks` shows the network flag as `b2cEnabled`, and the snapshot rows record it, for information only.
- `analyticsEnabled` decides whether the statistics include the network. It lives in the analytics database only (`analytics_settings`, document `network_visibility`: hidden chain ids and a revision), keyed by chain id; a network without an entry is visible, so a network imported from B2C, Scroll included, shows until an admin hides it. A hidden network is still copied and read.
- Balance collection decides whether the ingestion sends balance requests for the network. Every network with an endpoint is read by default; the chain ids in `uncollectedChainIds` of the same `network_visibility` document are not (`reason: collection_off`), for instance a network whose node was shut down in one environment. A document without the field reads every network. No route writes the field: an operator sets it with the commands of [Balance collection settings](#balance-collection-settings), and each `ingest_run` event shows the policy per network (`collectBalances`).

A hidden network is left out of `GET /v1/metrics/networks` and of `network=all` on every metrics endpoint (tiles, series, breakdowns, comparisons with the previous period, cohorts, TVL, top tokens, top countries and master wallets), and `network=<hidden id>` answers 400 exactly as an unknown network. Nothing is deleted and nothing is ingested again: the copies and aggregates keep every network, the filter applies when a response is built, so showing the network again restores its figures at once.

- Each metrics request reads the policy once and builds every block with the same networks. The read is cached in memory for 30 seconds: a change applies to the next request of the instance that made it and to the other instances within 30 seconds. When the policy cannot be read the metrics and admin routes answer 503, never a dataset that could include a hidden network.
- Changes are a compare-and-set on the revision, so of two admins acting on the same revision one succeeds and the other gets `CONFIG_CONFLICT`. At least one network of the catalog stays visible; the check runs in the same compare-and-set. Every change, refused ones included, goes to the activity log as `network_hidden` or `network_shown` with the network as target.
- The catalog is the B2C `blockchains` networks plus the networks the analytics database retains for their history (`sourcePresent: false`), refreshed every 5 minutes and after each ingestion run. A refresh after which no network would be visible is refused and the previous catalog kept.
- Top countries over several networks count each user once from the per-network-set counts of the run. A snapshot stored before those counts existed answers `unavailable` (`no_snapshot`) for `all` while some network is hidden and more than one is visible, until the next run.

### Metric blocks

Blocks added to the datasets after the first version carry `source` (`mock` or `live`), `availability` (`available`, `partial` or `unavailable`), `reason` and `asOf`. An unavailable figure is `null`; it is never replaced by a figure of another meaning or by an estimate. `meta.ingest` holds the status of the run behind the live values per source: `transactions` (`complete`, `partial`), `prices` (`complete`, `failed`, `skipped`, `disabled`) `balances` (`complete`, `partial`, `failed`, `disabled`) and `polymarket` (`complete`, `partial`, `failed`, `disabled`; absent in runs stored before the Polymarket fills were read); it is `null` when every value is synthetic.

| Block | Field | Definition | Source | Availability |
|---|---|---|---|---|
| TVL | `overview.tvl` | USD value of the assets in user wallets, from the last balance snapshot taken through the end of the range; `previous` is the last snapshot inside the previous period; each series bucket takes the last snapshot inside it | Balance snapshot of each ingestion run | `unavailable` (`no_snapshot`, or `snapshots_disabled` when the last run took none) before the first snapshot, with `firstSnapshotAt`; there is no back-fill. `partial` (`partial_coverage`) when a selected network was not read completely, `partial` (`native_not_covered`) when neither the B2C token list nor a master wallet of a read EVM network names its native coin, so its wallets were read without it, `partial` (`unpriced_assets`) when an asset had no price that day, `unavailable` (`unpriced_assets`) when no asset had one and `unavailable` (`not_valued`) under `USD_VALUATION=none`; `coverage` lists wallets, wallets read, unpriced assets and the networks without native coverage. A `partial` value is the subtotal of what was read and has no `previous` or `changeRatio`, nor does a value whose previous snapshot was `partial`; a bucket whose held assets all lack a price has `tvlUsd: null`. `unavailable` (`not_read`) when the snapshot read none of the selected networks, such as a network whose reads the settings stop, whose node failed or that B2C no longer lists; `lastComplete` then carries the last earlier snapshot that read them completely, valued, as a dated historical balance (`asOf`, `valueUsd`), or `null`. Each `byNetwork` row carries `status`, `reason` and `lastSuccessAt`, the last run that read every user wallet of the network (an observation date, not a current balance; `null` when unknown) |
| Top tokens | `overview.topTokens` | Units and USD value per asset in user wallets, same snapshot as the TVL | Balance snapshot | As the TVL; an unpriced asset has `valueUsd: null`. A `partial` block lists the assets of the networks read, with `share` over the priced subtotal `totalUsd` |
| Top countries | `overview.topCountries` | Users with a wallet on the selected networks, each counted once, per country of the calling code of their phone number (`libphonenumber-js`); `Unknown` when the number gives no single country. The range does not apply | Country counts of the last ingestion run | `unavailable` (`no_snapshot`) before the first run. Phone numbers are read during the run and never stored; only the counts are |
| Volume by product | `overview.volumeByProduct` | Volume and operations per product (`transfer`, `swap`, `polymarket`) in the range. A swap counts once, as a swap; transfers and swaps add up to the volume tile. `polymarket` is the executed volume of the Polymarket fills, with `transactions` as its fills, listed only with `network=all`: Polygon is outside the networks of the catalog, so the item is not in the volume tile, and shares are over the three products | Activity aggregates and Polymarket fills | The block is `available` when every item is; `polymarket` follows the Polymarket volume block |
| Swap volume | `revenue.tiles.swapVolumeUsd` | Input side of the counted swaps, in USD; the swap part of `volumeUsd` | Activity aggregates | Like the other tiles |
| Polymarket volume | `revenue.polymarketVolume` | Executed volume of the Polymarket orders of the users: pUSD paid by buys plus pUSD received by sells of their `OrderFilled` events on Polygon (1 pUSD = 1 USD), with `fills` and `readThrough`, the time of the last block read. Every user whatever the network filter (`scope: all_networks`); not in the volume tile. The B2C rows are not used: they mark an order `completed` when the order book accepts it and carry the requested amount, not the filled one | `polymarket_fills` | `available` when the last run read up to the confirmed head or the range ends before the hour of `readThrough`; `partial` (`partial_coverage`) when that hour falls inside the range; `unavailable` (`partial_coverage`) when the range starts after it. Before any block is read, `unavailable`: `not_configured` without `POLYMARKET_POLYGON_RPC_URL` or with a zero budget, `not_recorded` otherwise |
| Average fee per transaction | `revenue.avgFeePerTransaction` | Recorded fees of the range divided by its counted transfers and swaps, in USD with 4 places, against the previous period. The fee rate is a separate figure and stays | Activity aggregates | `unavailable` (`no_transactions`) without operations |
| Fees by product | `revenue.feesByProduct` | Recorded `fee` of the operations per product; not reconciled against charges or income. ChatterPay places Polymarket orders without a builder code and charges no fee on them, so `polymarket` is `0.00`, listed only with `network=all`. The fee Polymarket charges on a fill is paid by the user to Polymarket and is not included | Activity aggregates and Polymarket fills | `polymarket` takes the availability of the Polymarket volume; a fill of an order with a builder code in the range leaves it `unavailable` (`not_recorded`), since a builder fee is not stated in the fill |
| Master wallets | `revenue.masterWallets` | Public address, role, explorer link and balances of each signer configured in `MASTER_WALLETS` for the selected networks, from the last snapshot. Balances only: no fee or revenue is attributed to a signer | Balance snapshot | `unavailable` (`not_configured`) without configured wallets, as the TVL without a snapshot; per wallet `status` is `complete`, `failed` or `unsupported` |
| New wallets | `users.newWallets` | Wallets per network counted at their first verifiable appearance (`definition: first_verifiable_appearance`): the earliest completed B2C operation that sent from or paid to the wallet, or the first ingestion run that saw the wallet when an earlier run had not. The tile compares the last 30 days with the 30 before; the series follows the granularity | Activity copies and `wallet_first_seen` | A wallet without either evidence is not counted; `coverage` gives wallets and verified wallets and the block is `partial` (`unverified_wallets`) while some are unverified. `trackingSince` is the first run that observed wallets |
| Retention at 1/3/6 months | `users.retentionSummary` | Over the last 12 monthly cohorts, the share of users active in the 1st, 3rd and 6th month after the month they joined. A cohort counts for month N only when it has N complete months after its own; otherwise its `users` is `null` | Retention aggregates | A month without an eligible cohort with users is `unavailable` (`no_eligible_cohort`) |

Snapshot TVL and balances use stable tokens at 1 USD and the provider price of the same UTC day for the rest; an older price is not used. User wallets hold the ERC-20 tokens of the B2C token list on EVM networks and ADA plus the listed native assets on Cardano, tokens with `enabled: false` included. The native coin of an EVM network is read when the token list has it, as a document whose address is a placeholder (`0x` with a value up to `0xffff`) or the `0xEeee…EeE` sentinel, or else when a wallet of `MASTER_WALLETS` on the network states its `nativeSymbol`; a master wallet without `nativeSymbol` names no coin for the user wallets, since an EVM network is not assumed to use ETH. Each user wallet is read with its own address; master wallet balances are a separate block and never count in the TVL. The native coin is read with 18 decimals, once per address, within `BALANCES_MAX_CALLS_PER_RUN`, and a read native balance of zero is a measured zero. Without either, each network row of the snapshot has `native: not_listed` and the TVL is a subtotal; snapshot rows taken before `native` was recorded count as `not_listed` on EVM. A wrapped token such as WETH is an ERC-20 and never stands for the native coin. A wallet counts in a snapshot only when all its balances were read.

Every error response has the shape `{ code, message, requestId }`. The `x-request-id` response header echoes a valid incoming id (8-64 characters, letters, digits and dashes) or a generated UUID. Auth, team and metrics responses carry `Cache-Control: private, no-store`. Request bodies are JSON only; unknown body or query properties answer 400 and path ids must be UUIDs.

## Authentication

1. The BFF calls `request-code` with the email and forwards the browser IP in `x-client-ip` (used only when it is an IPv4 or IPv6 literal; otherwise the socket address applies). Every email gets the same 202 `{ challengeId, expiresAt, delivery: 'email', codeLength }` and goes through the same limits, members or not, so the answer reveals nothing. A code is generated and emailed only to active members, blocked ones included, and to emails with a pending invite:
   - The code has `OTP_CODE_DIGITS` digits (default 8) from the CSPRNG and lives `OTP_TTL_SECONDS` (default 300). It is emailed in the `locale` of the request (`en`, `es` or `br`, default `en`) with the idempotency key `login-code/<challengeId>`.
   - One challenge per email: a new code replaces the open one. The challenge stores neither the code nor the email: its `_id` is HMAC-SHA256 of the normalized email under `OTP_EMAIL_HMAC_SECRET`, and `codeDigest` is HMAC-SHA256 under `OTP_HMAC_SECRET` of the challenge id, the email and the code, so a code verifies only for the challenge and email it was issued for. `keyVersion` is a fingerprint of the code key.
   - The send happens before the challenge is stored. A failed delivery still answers 202, keeps the previous code valid, does not count against the limits and logs the challenge id and the failure, without the email or the code. The duration of the send is visible to the caller.
2. The BFF calls `verify-code` with the challenge id, the email and the code. Any failure answers the same 401 `Invalid or expired code`: unknown, expired, consumed, replaced or revoked challenge, email or challenge different from the one of the code, wrong code, code issued under another `OTP_HMAC_SECRET`, or an email that is neither an active member nor holder of a pending invite. The right code of a blocked member is consumed and answers 403 `MEMBER_BLOCKED` without a session, so only the owner of the email learns about the block. A challenge admits `OTP_MAX_ATTEMPTS` (default 5) wrong codes and then stops accepting any; each attempt is counted with a conditional update, so concurrent verifications of one code open one session. Codes are compared in constant time.
3. On success the challenge is consumed and the waits and code counters of the email are cleared. An email without an active member but with a pending invite becomes a member with the invite role and the invite turns `accepted`, only after the code sent to that email was verified. The API stores a session (`jti`, expiry `SESSION_TTL_MINUTES`) and returns a JWT signed with EdDSA, header `kid`, claims `iss`, `aud`, `sub` (user id), `jti`, `role`, `iat`, `exp`.
4. Protected routes take `Authorization: Bearer <jwt>`. The token is verified with the public key (EdDSA only), issuer and audience; then the session must exist, be neither revoked nor expired, and belong to an active, unblocked member. The role applied is the current role in the store, not the `role` claim. The session and member reads are cached in memory for 30 seconds and dropped on the instance that revokes a session, changes a role, blocks or removes a member, so those changes apply to its next request and to the other instances within 30 seconds.

| Limit | Scope | Answer |
|---|---|---|
| Wait between codes: none before the 2nd beyond `OTP_RESEND_COOLDOWN_SECONDS` (60 s), then the steps of `OTP_LOCKOUT_STEPS_SECONDS`: 5 min before the 3rd, 15 min before the 4th and later ones, never above `OTP_MAX_LOCKOUT_SECONDS` (15 min) | normalized email | 429 `RATE_LIMITED` with `Retry-After` |
| `OTP_SENDS_PER_EMAIL_HOUR` (5) per hour and `OTP_SENDS_PER_EMAIL_DAY` (10) per 24 hours | email and client IP | 429 with `Retry-After` |
| `OTP_REQUESTS_PER_IP` (30) `request-code` per 15 min | client IP | 429 with `Retry-After` |
| `OTP_VERIFICATIONS_PER_IP` (60) `verify-code` per 15 min | client IP | 429 with `Retry-After` |
| `OTP_MAX_ATTEMPTS` (5) wrong codes | challenge | 401, the challenge stops accepting codes |

The wait counts from the issue of the previous code, so requests refused during it do not extend it. The email state is forgotten 24 hours after its last code, and cleared by a login or by an admin through `unlock-login`. The code caps count per email and client IP, so requests from one IP cannot use up the codes of an email asked from another; the wait per email bounds the codes an email gets from any number of IPs. Emails and IPs reach the `rate_limits` keys only as HMAC identifiers. `unlock-login` does not reset the per-IP counters.

Blocking: `block` sets `blockedAt` on the member, revokes its sessions and its open code, and opens no session for it until an admin calls `unblock`; no limit expiry lifts it. The member still gets codes like anyone else, and verifying one shows the block (`MEMBER_BLOCKED`). `unblock` opens no session and brings back neither the revoked sessions nor the revoked code. A blocked member keeps its email, so it cannot be invited again. An admin cannot block itself, and a block, role change or removal that would leave no unblocked active admin answers 409. The UI states are `ACTIVE`, `ADMIN_BLOCKED` (`status: blocked`), `TEMPORARILY_RATE_LIMITED` (`loginLockedUntil` set) and `DELETED` (removed members are not listed and cannot sign in).

Demo accounts: with `DEMO_LOGIN_ENABLED=true`, the unblocked active members whose email is in `DEMO_LOGIN_EMAILS` get a challenge verified against `DEMO_ACCESS_CODE` instead of an emailed code, and the answer carries `delivery: 'access_code'` and `codeLength: null`. The other emails keep the emailed code, and the demo code opens no session for them. The flag is off by default, and production refuses it unless the Cloud Run service name (`K_SERVICE`) ends in `-develop`.

### Login code keys

`OTP_HMAC_SECRET` and `OTP_EMAIL_HMAC_SECRET` are dedicated keys of at least 256 bits from a CSPRNG, written as hex or base64, different from each other and from any other secret of the system (`JWT_PRIVATE_KEY`, session keys, Resend or OAuth credentials). Production refuses to start without them; outside production an unset key is generated at startup with a warning, and codes and limits end on restart.

Provisioning: each value is generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` on the machine that stores it, without copying it to logs or tickets. Locally it goes in `.env`, which Git ignores. In Cloud Run each key is a Secret Manager secret per environment, read through `secretKeyRef` in the service YAML; develop and main use different values.

Rotation:

- `OTP_HMAC_SECRET`: open codes stop verifying (401) and the member asks for a new one; limits and sessions are not affected.
- `OTP_EMAIL_HMAC_SECRET`: open challenges become unreachable and expire through their TTL, and the waits and code counters start over for every email and IP; sessions are not affected.
- Procedure: add a secret version with the new value, deploy a revision that reads it, and disable the old version once the new revision serves. Rotate after any suspected exposure.

Members carry `name` when the `users` document of the member has a non-empty `name`, set by an operator; otherwise `null`, never derived from the email. `lastActivityAt` is the instant of the latest activity event the member performed, separate from `lastLoginAt`.

Team rules: invites last 7 days and are reported `expired` afterwards. A pending invite carries status `simulated` whatever its delivery, the value persisted invites and the unique pending index use. Role changes, blocks and removals never leave the team without an unblocked active admin. The activity log records `login`, `login_failed` (only for emails of active members), `logout`, `invite_created`, `invite_resent`, `invite_revoked`, `invite_accepted`, `role_changed`, `member_removed`, `member_blocked`, `member_unblocked` and `login_lockout_cleared`; it never holds codes or tokens.

## Emails

Invitations and login codes go through `EmailService`, which renders the templates (`src/email/templates.ts`, English, Spanish and Brazilian Portuguese), derives the idempotency keys and applies the retry policy. The routes depend on the `EmailProvider` contract, never on a provider:

- `simulated` (default): keeps the last 100 messages in memory and sends nothing; deliveries report `simulated`. Production refuses it.
- `resend`: `POST https://api.resend.com/emails` with `fetch` and the `Idempotency-Key` header; Resend accepts each key once for 24 hours. It needs `RESEND_API_KEY` (a sending-only key restricted to the sender domain), `EMAIL_FROM` on the domain verified in Resend and `SITE_URL` for the links.

The templates live in the code, not in Resend, so the simulated provider and the tests render the same copy that is sent.

Retries: up to 3 requests per message, 0.5 s and 1 s apart, or the `retry-after` of the provider up to 5 s; a longer `retry-after` ends the send as failed. Network errors, 429, 5xx and 409 `concurrent_idempotent_requests` are retried with the same idempotency key, so a request that reached Resend but lost its answer is not delivered twice. Any other 4xx (unverified domain, invalid sender or recipient, a key reused with another payload) is a rejection and is not retried.

Invites: creating or resending one stores it first, then sends it with the key `invite/<id>/<resendCount>` and records the outcome in `delivery` (`state`, `attempts`, `lastAttemptAt`, `failure`; the provider message id is stored and not exposed). `state` is `pending` from the store write until the send ends, then `simulated`, `sent` or `failed`. A failed send answers 201 or 200 with the invite, which stays pending; the admin resends it. An invite left `pending` lost its send when the instance stopped, and a resend sends it again. Revoking sends no email. Invites stored before the emails read as `simulated` with `lastSentAt` as `lastAttemptAt` and locale `en`. Challenges stored before the HMAC keys, with a random `_id` and the email in clear, match no request and expire through their TTL.

## Configuration

`loadEnv` validates the environment at startup and lists invalid variables by name only. Empty values count as unset.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` / `PORT` | `127.0.0.1` / `4001` | The container sets `0.0.0.0` / `8080` |
| `LOG_LEVEL` | `info` | |
| `BODY_LIMIT_BYTES` / `REQUEST_TIMEOUT_MS` | `16384` / `10000` | |
| `OTP_HMAC_SECRET` | unset | Key of the login code verifiers, at least 32 bytes as hex or base64; secret. Required in production; unset generates an ephemeral key at startup (warning logged) |
| `OTP_EMAIL_HMAC_SECRET` | unset | Key of the email and IP identifiers of challenges and counters; same format, different from `OTP_HMAC_SECRET`; secret. Required in production |
| `OTP_CODE_DIGITS` | `8` | 8-10 |
| `OTP_TTL_SECONDS` | `300` | 60-600 |
| `OTP_MAX_ATTEMPTS` | `5` | Wrong codes per challenge, 1-10 |
| `OTP_RESEND_COOLDOWN_SECONDS` | `60` | Minimum wait between two codes of an email, 10-600 |
| `OTP_LOCKOUT_STEPS_SECONDS` | `0,300,900` | Comma list: wait before the 2nd, 3rd... code; the last step repeats. None above `OTP_MAX_LOCKOUT_SECONDS` |
| `OTP_MAX_LOCKOUT_SECONDS` | `900` | 60-900 |
| `OTP_SENDS_PER_EMAIL_HOUR` / `OTP_SENDS_PER_EMAIL_DAY` | `5` / `10` | Codes per email and client IP per hour and per 24 hours; the daily cap is not below the hourly one |
| `OTP_REQUESTS_PER_IP` / `OTP_VERIFICATIONS_PER_IP` | `30` / `60` | `request-code` and `verify-code` calls per client IP per 15 minutes |
| `DEMO_LOGIN_ENABLED` | `false` | `true` lets the emails of `DEMO_LOGIN_EMAILS` sign in with `DEMO_ACCESS_CODE`, with no email. Production refuses it unless `K_SERVICE` ends in `-develop` |
| `DEMO_LOGIN_EMAILS` | unset | Comma list, at most 10, of emails on a `demo.` subdomain. Required with `DEMO_LOGIN_ENABLED` |
| `DEMO_ACCESS_CODE` | unset | At least 12 characters; secret. Required with `DEMO_LOGIN_ENABLED`, unused otherwise |
| `K_SERVICE` | unset | Set by Cloud Run to the service name; read only for the demo rule |
| `EMAIL_PROVIDER` | `simulated` | `simulated` sends nothing; `resend` requires the three variables below. Production requires `resend` |
| `RESEND_API_KEY` | unset | Sending-only Resend key restricted to the sender domain; secret |
| `EMAIL_FROM` | unset | `address@domain` or `Name <address@domain>`, on the domain verified in Resend |
| `SITE_URL` | unset | Origin of the site for the email links (trailing slash removed); HTTPS in production. Outside production unset links to `http://localhost:4000` |
| `JWT_PRIVATE_KEY` | unset | PEM PKCS8 Ed25519, `\n` escapes allowed. Required in production; unset generates an ephemeral key at startup (warning logged, sessions end on restart) |
| `JWT_KEY_ID` | `dev` | `kid` header |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `chatterpay-analytics-api` / `chatterpay-analytics-site` | |
| `SESSION_TTL_MINUTES` | `120` | 5-1440 |
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
| `BALANCES_PROVIDER` | `none` | `rpc` takes a balance snapshot per run through the endpoints of the B2C `blockchains` collection (`rpc` on EVM, `providerUrl` on Cardano; HTTPS only, used in memory and never stored or logged); `none` takes no snapshot |
| `BALANCES_MAX_CALLS_PER_RUN` | `100` | Ceiling on balance requests per run (`eth_call` batches, Koios pages and Blockfrost addresses), 0-2000; 0 disables the snapshot |
| `CARDANO_PROVIDER_API_KEY` | unset | Blockfrost project id, sent in the `project_id` header when the Cardano `providerUrl` is a `blockfrost.io` host; the same variable as in the B2C backend. Secret: never logged or stored. Unset leaves a Blockfrost network `unsupported_provider`; Koios needs none |
| `POLYMARKET_POLYGON_RPC_URL` | unset | HTTPS JSON-RPC endpoint of Polygon mainnet that answers `eth_getLogs` over 10000 blocks, the same variable as in the B2C backend. The ingestion reads the Polymarket fills through it, sending the addresses of the Polymarket accounts as log filters; used in memory, never stored or logged. Unset leaves the Polymarket volume `unavailable` (`not_configured`) |
| `POLYMARKET_MAX_CALLS_PER_RUN` | `500` | Ceiling on Polygon requests per run for the Polymarket fills, 0-2000; 0 stops the reads |
| `MASTER_WALLETS` | `[]` | JSON array, at most 20, of `{ network, address, role, nativeSymbol? }`: network id, public address (`0x` plus 40 hex digits, or a Cardano `addr`/`addr_test` address), role shown with it, and the native coin symbol on EVM. Without `nativeSymbol` the balance of the wallet itself is labelled `ETH` and the user wallets of the network are read without a native coin unless the B2C token list carries it. Unknown fields, private keys and seed phrases are rejected |
| `USD_VALUATION` | `market` | `market` values balances and operations (stable tokens at 1 USD, provider and swap-implied prices of the symbol). `none` computes no USD figure, for a deployment whose networks hold test assets without market value: amounts and counts stay, every USD figure answers `unavailable` with `not_valued`. Set per deployment; it is never inferred from network names or symbols |
| `METRICS_REFRESH_SECONDS` | `300` | How often an instance looks for a newer aggregate build |

## Persistence

| Collection | Content | Indexes |
|---|---|---|
| `users` | Members; removed members keep their record | `email_active_unique` (unique `email` where `status` is `active`), `status_role` |
| `sessions` | Issued session JWTs by `jti` | `user_id`, `expires_at_ttl` |
| `login_challenges` | One open challenge per email, keyed by the HMAC identifier of the email: challenge id, kind, code verifier and key version, attempts. Never the code or the email in clear | `expires_at_ttl` |
| `invites` | Invites with the delivery of their last send | `email_pending_unique` (unique `email` where `status` is `simulated`), `mutation_id_unique`, `created_at` |
| `activity` | Login and team events | `at` |
| `rate_limits` | Fixed-window counters and the login code state of each email (codes issued, last issue, version), keyed by HMAC identifiers of emails and IPs | `reset_at_ttl` |
| `ingest_state` | Ingestion checkpoints (`checkpoints`, with `walletsTrackingSince` and the Polygon block reads of the Polymarket fills: `polymarketNextBlock`, `polymarketFrom`, `polymarketThrough`), run lock (`lock`) and last aggregate build (`aggregates`, with the run status, the wallets per network and the Polymarket fills per hour with their coverage) | default |
| `ingest_snapshots` | One document per run, keyed by the run start: balance totals per network and asset, read coverage per network, master wallet balances, and user counts per network and country and per set of networks and country. No per-wallet balance and no phone number | default |
| `wallet_first_seen` | First run that observed each wallet, keyed by chain id and address, with `bounded` (an earlier run had not seen it); inserted once, never updated | default |
| `b2c_transactions` | Copy of the B2C `transactions` rows, keyed by the B2C `_id` | default |
| `b2c_users` | Id, `creationDate` and wallets (chain id, address) of the B2C users; no phone, country, name or email | default |
| `b2c_tokens` / `b2c_networks` | Copies of the B2C token list and of the networks with their family and public contract addresses, stamped `sourcePresent` and `lastSeenAt`. A copy the B2C database dropped stays, with `sourcePresent: false`, while copied rows use it | default |
| `analytics_settings` | Analytics settings by `_id`; `network_visibility` holds the hidden chain ids, the revision and who changed it last, and `uncollectedChainIds` when an operator stops the balance reads of a network | default |
| `token_prices` | USD price per symbol and day from the provider | default |
| `polymarket_fills` | Fills of the orders of the Polymarket accounts, keyed by transaction hash and log index: hour, side, pUSD amount, Polymarket fee and whether the order had a builder code. No address, market or user | default |
| `agg_hourly` / `agg_user_activity` / `agg_user_signups` | Aggregates of the last build: facts per network and hour, active hours per user, signups | default |

- The API does not create indexes. `REQUIRED_INDEXES` in `src/store/mongo-schema.ts` lists them, and startup fails naming the missing ones.
- Members exist only in the database. The first admin of a new database is inserted by an operator; the rest join through invites.
- Invariants hold without multi-document transactions: unique indexes for one active member and one pending invite per email and one invite per `mutationId`, conditional single-document updates for challenges and invite transitions, and a compensating update for the last active admin (two concurrent changes that would each remove it can both be undone).
- The in-memory store is refused in production and logs a warning elsewhere.
- `MONGO_TEST_URI=mongodb://127.0.0.1:27017 yarn test` runs the route suites on MongoDB, each test on a throwaway database that is dropped afterwards, the Polymarket fill store of `test/polymarket-fills.integration.test.ts`, and the ingestion suite of `test/retired-network.integration.test.ts`, which seeds a synthetic B2C database and an analytics database with unique names, drops both, and refuses a server that is not on this machine. Without `MONGO_TEST_URI` that suite is skipped.

## Ingestion

`POST /v1/internal/ingest` runs `runIngestion` (`src/ingest/run.ts`):

1. Takes the lock in `ingest_state`; a run that finds it taken answers 200 with `status: locked`. The lock expires `INGEST_MAX_RUN_SECONDS` plus 5 minutes after it is taken.
2. Copies B2C `transactions` rows with an `_id` above the checkpoint, in batches, saving the checkpoint after each batch. Copies are keyed by the B2C `_id`, so a repeated read replaces instead of duplicating.
3. Reads again the rows inserted in the last `INGEST_REVISIT_HOURS`, for rows whose status changes after insertion (Polymarket orders).
4. Replaces the copies of `users`, `tokens` and `blockchains`, whatever their `enabled`. A network the B2C database dropped is kept, `sourcePresent: false`, while a copied transaction, user wallet or wallet observation is on it, and a token while a copied transaction on its chain uses its symbol; the report counts them as `retainedNetworks` and `retainedTokens`. The country of each phone number is counted per network, per set of networks and overall, and the number is dropped. A failed B2C read fails the run before anything is replaced.
5. Records in `wallet_first_seen` every wallet not seen before. The first run sets `walletsTrackingSince`; its observations are unbounded, since the wallets may be older.
6. With `PRICES_PROVIDER=coingecko`, requests one USD snapshot per UTC day for the non-stable tokens and the native coins of the EVM master wallets, in one request; the day is marked before the request, so a failing provider is asked once a day at most.
7. With `BALANCES_PROVIDER=rpc`, reads the balances of every user wallet and master wallet of each network with an endpoint, whatever its B2C `enabled` and its analytics visibility, except the networks in `uncollectedChainIds`, and stores the totals, with the country counts, in `ingest_snapshots`. Without it the run stores the country counts only.
8. With `POLYMARKET_POLYGON_RPC_URL`, reads on Polygon the `OrderFilled` events of the Polymarket CLOB V2 exchanges whose maker is the `polygon_address` of a B2C Polymarket account, from the block after the last one read up to the head minus 128 blocks, and stores the fills in `polymarket_fills` without any address.
9. Rebuilds every aggregate from the copies and records the build instant and the run status per source.

Steps 2 and 3 stop starting batches at `INGEST_MAX_TRANSACTIONS_PER_RUN` rows or `INGEST_MAX_RUN_SECONDS`; the run answers `status: partial` and the next run continues from the checkpoint. A run is idempotent per start instant: copies, observations and the snapshot are keyed, so a repeated write replaces or skips.

Balance requests per run, bounded by `BALANCES_MAX_CALLS_PER_RUN` and `INGEST_MAX_RUN_SECONDS`, each with a 15 s timeout:

- EVM network: `ceil((W × T + M × (T + 1)) / 200)` `eth_call` requests to Multicall3 `aggregate3` (`0xcA11bde05977b3631167028862bE2a173976CA11`), for `W` user wallets, `M` master wallets and `T` ERC-20 tokens with a contract and decimals.
- Cardano network with a Koios endpoint: `ceil((W + M) / 50)` requests to `address_utxos`, plus one per additional page of 1000 UTxOs, at most 20 pages per batch.
- Cardano network with a Blockfrost endpoint (host under `blockfrost.io`) and `CARDANO_PROVIDER_API_KEY`: `W + M` requests to `/addresses/{address}`, one per address; an address the chain has never seen answers 404 and holds zero. Without the key the network is `unsupported_provider` and takes no request.
- Each network row of the report and of the run event carries `plannedCalls`, the requests a full read of the network takes, counted before the read (on Koios without the additional pages); `calls` below `plannedCalls` with `budget_exhausted` means `BALANCES_MAX_CALLS_PER_RUN` is under the sum of `plannedCalls` of the networks read.
- Networks are read one after the other within the shared budget and deadline. Two failed requests in a row stop the reads of an endpoint for the run, so a node that is down or times out takes at most two requests and 30 s, and the networks after it keep the rest.
- A failed request or a spent budget leaves its wallets unread and lowers the coverage; the run continues. An unreachable endpoint, such as the RPC of a network that was shut down, marks its network `failed` (`rpc_failed`) with no holdings, the balances source `partial` and the blocks that cover it `partial` (`partial_coverage`); the network is never read as zero. Wallets left unread by the budget or the deadline give `budget_exhausted` or `deadline_reached`, other gaps `read_incomplete`. Error messages of the requests are not kept, since they can carry the endpoint key.
- A network gets a row without any request when the settings stop its reads (`collection_off`), when B2C no longer lists it (`source_absent`: the endpoint comes from the B2C document, so none is left), without an HTTPS endpoint (`no_endpoint`) or with a provider the reader does not speak (`unsupported_provider`). Its earlier snapshots, copies and aggregates stay. Snapshot rows stored while B2C `enabled: false` kept a network from being read carry `b2c_disabled`.
- Each network row records `collectBalances`, `attempted` and `lastSuccessAt`, the start of the last run that read every user wallet of the network (kept from the stored snapshots while later runs do not read it). It is the date of an observation and never served as a current balance.

Polymarket fill requests per run, bounded by `POLYMARKET_MAX_CALLS_PER_RUN` and the same deadline, each with a 15 s timeout, after the balances:

- `eth_getLogs` on the CTF Exchange (`0xE111180000d2663C0091e4f400237545B87B996B`) and the Neg Risk CTF Exchange (`0xe2222d279d744050d28e00520010520000310F59`), filtered by the `OrderFilled` topic and the makers: one request per 10000 blocks (about 4 hours of Polygon) and per group of 500 accounts, plus `eth_blockNumber` and one `eth_getBlockByNumber` for the head.
- The first run finds the block of the earliest account creation date by binary search (about 27 requests); an account without a creation date starts the reads at the opening of the CLOB V2 exchanges (2026-04-28).
- The checkpoint moves past a range of blocks only when every group of it was read, so a stopped run leaves no hole; one request is kept to date the last block read. A daily run takes about 8 requests per group of accounts; the first runs read back to the earliest account and may take several runs, each one `partial`.
- Each fill counts once: the event of the taker side of a match has the account as maker and the exchange as taker, and fills are keyed by transaction and log index. A buy counts the pUSD paid (`makerAmountFilled`) and a sell the pUSD received (`takerAmountFilled`).
- Each run reads the accounts of its own time. When a `polygon_address` is replaced, the fills of the old address already read stay and its later ones are not read.

With 1000 user wallets and 4 tokens on one EVM network, a run sends 20 `eth_call` requests; 1000 wallets on Cardano take 20 Koios requests when each batch fits in one page. The instance that ran the ingestion loads the new aggregates at once; the others within `METRICS_REFRESH_SECONDS`. After the run that instance logs the catalog size, the retained networks and how many networks the statistics show and hide (`catalogRetained`, `analyticsEnabled`, `analyticsDisabled`). Each run, failed ones included, also logs one `ingest run` event (`event: ingest_run`) with `runId`, `status`, `startedAt`, `durationMs`, `builtAt`, `valuation`, the duration of each phase in `phasesMs` (`copyTransactions`, `revisit`, `catalogUsers`, `prices`, `snapshot`, `polymarket`, `aggregateRebuild`, `persist`, and `readback`, the load of the new build), the transaction, user, catalog and price counters, the balance status, calls and failed calls with, per network, `network`, `chainId`, `status`, `reason`, `b2cEnabled`, `analyticsVisible`, `collectBalances`, `endpointPresent` (a boolean, never the URL), `attempted`, `wallets`, `walletsRead`, `calls`, `plannedCalls`, `failedCalls`, `native`, `unpricedAssets`, `startedAt`, `finishedAt`, `durationMs`, `takenAt` and `lastSuccessAt`, the Polymarket status, calls, failed calls, accounts, fills read and the time of the first and last block covered (`polymarket`), and the aggregate counters (`unpriced`, `unpricedFees`, `unverifiedSwaps`, `undatedUsers`, ...). It carries no endpoint URL, credential, phone number or wallet address; a failed run records only the class of its error.

### Balance collection settings

No route writes `uncollectedChainIds`. An operator authorized for the analytics database of the environment runs, in mongosh, with the chain id of the network as a string:

```js
db.analytics_settings.updateOne({ _id: "network_visibility" }, { $addToSet: { uncollectedChainIds: "<chainId>" }, $inc: { revision: 1 }, $set: { updatedAt: new Date(), updatedBy: "operator" }, $setOnInsert: { disabledChainIds: [] } }, { upsert: true })
```

and, to read the network again:

```js
db.analytics_settings.updateOne({ _id: "network_visibility" }, { $pull: { uncollectedChainIds: "<chainId>" }, $inc: { revision: 1 }, $set: { updatedAt: new Date(), updatedBy: "operator" } })
```

The revision bump makes a visibility change that an admin started on the previous revision answer `CONFIG_CONFLICT` instead of overwriting the write; visibility changes `$set` their own fields and keep `uncollectedChainIds`. The next run applies the change; its `ingest_run` event shows `collectBalances: false` and `reason: collection_off` for the network, with `calls: 0`. A network with an endpoint and no entry is read.

A network B2C no longer lists has no endpoint, since the URL comes from its B2C document; the run keeps its catalog copy, rows and snapshots and records `source_absent` without a current reading. Reading such a network would take an endpoint configured in the analytics: a secret per network (for instance `BALANCES_ENDPOINTS` in Secret Manager, a JSON map of chain id to HTTPS URL, mounted as an environment variable), used in memory like the B2C one and never stored in MongoDB, logged or sent to the site. It is not implemented.

Admitted callers: the Google-signed ID token in `Authorization: Bearer` is verified against Google's keys, with `iss` `https://accounts.google.com`, `aud` equal to `INGEST_OIDC_AUDIENCE`, `email` equal to `INGEST_SCHEDULER_SA_EMAIL` and `email_verified`. Cloud Run IAM admits the site service account too, which is why the API checks the identity itself; the site sends its identity in `X-Serverless-Authorization` and a session JWT in `Authorization`, so it never passes. Locally, `INGEST_DEV_TRIGGER=true` admits any caller.

Valuation and counting (`src/metrics/live.ts`):

- Counted operations: completed `transfer` rows and complete swaps. Deposits and Polymarket rows are copied but not counted. Rows of chains outside the catalog are not counted.
- A swap is two B2C rows with the chain's transaction hash: the user's wallet to the router and the router back to the wallet. B2C rows carry no operation id, so rows are grouped by chain id, hash and the unordered pair of addresses, which keeps apart two swaps sharing one transaction. Rows with the same direction, token and amount are one leg written twice. A group is a complete swap only with exactly two mirrored legs, both `completed`; any other group with a completed row (one leg, a leg still pending, extra legs, a row without hash) is counted as `unverifiedSwaps` in the summary and left out of every figure, never read as a transfer. The rows are walked by B2C id, so the result does not depend on their order and a rebuild of the same copies gives the same aggregates.
- A swap is valued and attributed on its input leg, the one sent by a known user wallet (the earlier one when that does not decide). Its USD value is the stable leg when either leg is stable; otherwise the input amount times the price of the day.
- Stable tokens (`type: 'stable'`) are 1 USD. Other tokens take the swap-implied price of the day, or the provider snapshot; a day without a price takes the closest earlier day, then the closest later one. A price of zero or less is no price. An amount, or a fee other than zero, without any price is left out of the USD figures and counted per network and asset in the hourly `unpriced` counts and as `unpriced` / `unpricedFees` in the summary; it is never valued at zero. The money tiles then answer `partial` (`unpriced_assets`) with the subtotal of the valued operations, or `unavailable` with `value: null` when none is valued; `previous` and `changeRatio` are served only for periods valued completely, series points and network rows whose operations have no value are `null`, and `valuation` lists the unpriced networks and assets. With `USD_VALUATION=none` nothing is valued and the reason is `not_valued`.
- Fees are the `fee` field of the operation, in its token, as the backend computed it; they are not reconciled against charges.
- Active users are the senders of counted operations (B2C user id, or the address when it belongs to no user). New and total users come from `users.creationDate` on each network of the user's wallets; wallets have no date of their own. Users without `creationDate` count in totals from the start and in no signup window or cohort; no date is inferred for them. `users.signups` gives the users and the undated ones and is `partial` (`undated_users`) while some exist, as is the retention summary; the summary of a run counts them as `undatedUsers`.
- User tiles, series totals and retention cohorts count a user id once across the selected networks; the `byNetwork` rows count per network, so a user with wallets on Base and Cardano appears in both rows and the rows can add up to more than the tile.

`LIVE_METRIC_GROUPS` in `src/metrics/sources.ts` lists which metric groups (`activity`, `activeUsers`, `signups`, `retention`, `wallets`, `balances`, `countries`) are served from the aggregates and snapshots once a build exists; the rest stay synthetic. A live group without data answers `unavailable`; it does not fall back to synthetic values.

## Mock dataset

- Networks: one per document of the `blockchains` collection of the B2C database, sorted by name. The id is the slug of the name (`Base Sepolia` → `base-sepolia`); `family` is `evm` (also when absent) or `cardano`, and documents of other families are skipped. The catalog is read at startup, where a failure stops the process, and every 5 minutes, where a failure keeps the previous catalog. Without Mongo, the catalog is `base-sepolia` and `cardano-preprod`.
- Filters: `network` = `all` or a network id, default `all`; `range` = `today` | `week` | `month` | `year` | `ytd` | `all`, default `month`; `granularity` = `daily` | `monthly` | `yearly`, default `monthly`. Unknown parameters, values and networks answer 400.
- Generated in memory from a seeded function of `(datasetVersion, network, day)`: the same day always yields the same figures on every instance. Activity starts on 2025-01-01 and ends at the current UTC hour.
- `today`, `week`, `month` and `year` are rolling windows of 1, 7, 30 and 365 days; `ytd` starts on January 1; `all` starts at the dataset start and has no comparison. The previous period ends at the same hour, so partial days are compared like for like.
- Every total equals the sum of its series, network breakdown and asset breakdown. Volume counts transfers plus the input side of swaps. Cardano networks have no swaps. Every network of a family uses the same activity template; after the first one, user counts are scaled by a factor derived from the id.
- Amounts are USD decimal strings with 2 places, computed in integer cents. `changeRatio` is a decimal string with 4 places, `null` when the previous value is zero or absent.
- The synthetic model has no user identities: each network is its own population, so user totals over several networks are the sums of the networks. Distinct active users of a window come from that model, bounded by the users that joined until then.
- Dataset version `mock-v2`. Synthetic snapshots are taken daily at 03:00 UTC from the dataset start, with every network read completely; prices are seeded around 2500 USD for ETH/WETH, 60000 for WBTC and 0.45 for ADA. Countries follow fixed weights with an `Unknown` share. Every synthetic wallet has a first appearance. Synthetic master wallets have the role `Synthetic signer`, addresses that cannot belong to a signer and no explorer link.

## Deployment

`cloudbuild.yaml` builds and pushes the image and deploys it to Cloud Run. The same file serves both environments.

| Substitution | Value |
|---|---|
| `_SERVICE_NAME` | `chatterpay-analytics-back-develop` or `chatterpay-analytics-back-main` |
| `_DEPLOY_REGION` / `_AR_HOSTNAME` / `_TRIGGER_ID` | Region, Artifact Registry host, trigger id |

- Server variables (`LOG_LEVEL`, `BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`, `JWT_KEY_ID`, `JWT_ISSUER`, `JWT_AUDIENCE`, `SESSION_TTL_MINUTES`, `MONGO_DB_NAME`, the `OTP_*` limits and the `INGEST_*`, `PRICES_*`, `BALANCES_*`, `POLYMARKET_*`, `MASTER_WALLETS` and `METRICS_*` variables) are defined in the Cloud Run service YAML. The image only sets `NODE_ENV`, `HOST` and `PORT`; the deploy keeps the variables already defined on the service.
- Secrets never enter the image: `OTP_HMAC_SECRET`, `OTP_EMAIL_HMAC_SECRET`, `DEMO_ACCESS_CODE`, `JWT_PRIVATE_KEY` and `MONGO_URI` come from Secret Manager through `secretKeyRef` in the Cloud Run service YAML, and so does `CARDANO_PROVIDER_API_KEY` when a Cardano network reads through Blockfrost. With `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` reads `CHATTERPAY_RESEND_API_KEY_DEV` / `_MAIN` the same way, and `EMAIL_PROVIDER`, `EMAIL_FROM`, `SITE_URL`, `DEMO_LOGIN_ENABLED` and `DEMO_LOGIN_EMAILS` are plain variables of the service YAML. The main service leaves `DEMO_LOGIN_ENABLED` unset. `POLYMARKET_POLYGON_RPC_URL` and `POLYMARKET_MAX_CALLS_PER_RUN` are plain variables of the service YAML; an endpoint whose URL carries a key goes through `secretKeyRef` instead. `MONGO_URI` reads `ANALYTICS_BACKEND_MONGO_CONN_STRING_DEV` / `_MAIN`: the connection string of a database user whose only role is `readWrite` on the analytics database of the same Atlas cluster as the backend.
- The service name selects the VPC: `*-develop` deploys on `chatterpay-dev-vpc` / `chatterpay-dev-run`, `*-main` on `chatterpay-main-vpc` / `chatterpay-main-run`; any other name stops the build.
- The service sits behind the HTTPS load balancer on `dev.back.analytics.chatterpay.net` and `back.analytics.chatterpay.net`, with ingress `internal-and-cloud-load-balancing`. The deploy uses `--no-allow-unauthenticated`: only the service account of the site has `roles/run.invoker`. The BFF sends a Google-signed ID token whose audience is the API domain, declared on the service as a custom audience (`run.googleapis.com/custom-audiences`).
- The container listens on `0.0.0.0:8080` as the non-root `node` user.
- The ingestion is started by a Cloud Scheduler HTTP job: `POST https://<API domain>/v1/internal/ingest`, OIDC token of a dedicated scheduler service account with `roles/run.invoker` on the service, audience equal to the API domain (the same custom audience the site uses), attempt deadline above `INGEST_MAX_RUN_SECONDS`. The Cloud Run request timeout must also exceed `INGEST_MAX_RUN_SECONDS`.

The site is served on `dev.analytics.chatterpay.net` and `analytics.chatterpay.net`.
