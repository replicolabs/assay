# Task Difficulty Analysis

## Overall assessment

**Difficulty: Medium (5/10).** A basic proof of concept is straightforward, but a reliable hourly service requires precise market definitions, API handling, scheduling, deduplication, and operational safeguards.

## Required data sources and integrations

- A DEX market-data source, such as the selected DEX's official API/subgraph or an aggregator such as DexScreener or GeckoTerminal.
- Pair/token metadata: chain, pair address, base/quote token, liquidity, volume, and price-change fields.
- A Discord webhook URL and Discord's webhook API.
- A scheduler/runtime, such as cron, Windows Task Scheduler, APScheduler, or a continuously running worker.
- Optional persistent state/logging for prior rankings, retries, and execution history.

## Ambiguity

Ambiguity is **high** unless acceptance criteria define:

- Which DEX and blockchain are in scope.
- Whether “gainers” means tokens or trading pairs.
- The gain window (1 hour, 24 hours, or since the previous run).
- The eligible universe and quote currency.
- Minimum liquidity/volume thresholds and treatment of newly created or illiquid pairs.
- Whether stablecoins, wrapped assets, duplicates, and suspicious tokens are excluded.
- Required Discord message format and behavior when fewer than five valid results exist.
- Deployment environment, secret storage, retry policy, and timezone.

These choices can materially change the ranking. A thin-liquidity filter is especially important because otherwise manipulated or economically meaningless pairs may dominate.

## Dispute risk

**Moderate to high (6/10) as written.** The main dispute vector is not Python complexity but differing interpretations of “top 5 gainers on a DEX.” Results may disagree with a buyer's reference because of differing time windows, pair universes, data providers, refresh times, or liquidity filters. Dispute risk falls to **low (2/10)** if the DEX/chain, endpoint, ranking formula, time window, filters, output schema, and test cases are fixed in advance.

## Estimated execution effort

- Basic script using an existing API, environment-based webhook secret, and simple hourly scheduling: **4–8 engineering hours**.
- Production-ready version with pagination, normalization, liquidity filters, retries/backoff, logging, tests, containerization, and deployment documentation: **1–2 engineering days**.
- Additional time may be required if the selected DEX has no suitable indexed API and on-chain event indexing must be built.

## Probability of acceptance

- **About 70% as currently specified**, because a competent implementation may still use definitions that differ from the buyer's expectations.
- **About 90–95% after the ambiguities above are resolved** and acceptance is tested against a fixed sample response plus a successful Discord webhook post.

## Recommended acceptance criteria

Specify one chain and DEX/data endpoint, a precise price-change window, minimum liquidity and volume, deterministic tie-breaking, excluded asset categories, the Discord message schema, hourly scheduling tolerance, secret handling, timeout/retry behavior, and a dry-run mode. Require unit tests with mocked API/webhook responses and one documented end-to-end test.
