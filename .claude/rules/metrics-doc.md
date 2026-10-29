# Metrics documentation

`.doc/metrics.md` describes, per screen of the site, how each figure is calculated. It is written in Spanish and holds only metric definitions.

## When it changes

Any change to how a figure is calculated updates `.doc/metrics.md` in the same change. That covers:

- `src/metrics/`: aggregation (`live.ts`), facts and the synthetic model (`facts.ts`), products, valuation, pricing, token scope, users, overview, revenue and holdings.
- `src/ingest/`: what the ingestion reads or derives for a metric, such as the balance snapshot, master wallets, paymasters and Polymarket fills.
- The meaning of a response field in `src/routes/metrics.ts`.

A change that alters no figure (refactor, logging, performance) leaves the doc as it is.

## How to update it

- Find the section of each screen and figure the change affects, and the shared rules (data origin, counted operation, active user, USD valuation, periods, filters).
- Describe the rule in terms of the data, without endpoints, environment variables, schedulers, links to the README or text taken from a conversation.
- Keep the README metric table (`Metric blocks`) consistent with the doc.
- The help texts of the site (`help.metrics` in the site dictionaries) state the same rules; when a rule changes, the site texts change with it.
