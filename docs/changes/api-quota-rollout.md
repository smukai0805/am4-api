# AM4 API quota preservation — implementation and rollout gate

## Status

This change is prepared on `fix/api-quota-preserve-data-20260921`. It is not a Production deployment. Do not merge/promote the repository tree over the current CLI deployment without reconciling its uncommitted changes.

Verified production identity: `dpl_6XrXU43Nee3yKywEfMeKW13JVLuX`, source `cli`, metadata commit `a6beed227ac2acf1b36cf1e5ab7efb7ca96f99e1`. Production runtime stack positions and its published daily-performance JavaScript differ from that GitHub commit. Metadata alone is insufficient to establish source parity.

## Implemented design

- One shared private-Blob namespace stores successful raw provider responses. Existing article, media sidecar, monitor and Notion namespaces are untouched.
- Conditional ETag writes coordinate cache refreshes and a shared daily request budget. Process-local memory is only a fast cache, not the production source of truth.
- `/fixtures?id=...` and individual match-section calls share the documented `/fixtures?ids=...` bundle. This implementation bundles sections of one match; it does not yet batch 20 different matches.
- Live bundle TTL is 60 seconds. Recently finished matches retain short correction windows; settled matches and profiles are cached longer.
- Timeouts, HTTP-200 provider errors, unexplained empty refreshes and missing optional sections do not replace last-good data. Missing player photos are reused only for the same validated player identity.
- Provider errors and stale partial responses cannot poison CDN cache as fresh successful empty data.
- Daily list labels use the provider snapshot timestamp, not the current render time. SSR inserts a saved-data notice when applicable.
- A 6,500/day internal reservation limit leaves 1,000 requests below the reported 7,500 plan cap. The counter is conservative; reservations include failures, and observed provider remaining headers account for other usage after it becomes visible. Other tools using the key outside this shared gate cannot be absolutely constrained by this code.
- Per-instance and persistent single-flight handling stop duplicate cache misses. The update lease is 30 seconds; raw upstream timeouts are bounded; no blind immediate retries.
- Existing reader routes are retained. No new cron, paid service, plan change or article rewrite is introduced.

## Conditional daily estimate

Assume: the cache is warmed, one current-day list key is updated every minute for 24 hours, each distinct watched live match is refreshed every minute for two hours, and other endpoint/update traffic is budgeted separately.

| Scenario | Day-list updates | Live bundles | Other reads assumed | Approximate total |
| --- | ---: | ---: | ---: | ---: |
| 10 distinct live matches/day | 1,440 | 1,200 | 800 | 3,440 |
| 20 distinct live matches/day | 1,440 | 2,400 | 1,200 | 5,040 |

These are examples, not observed production counts or guaranteed upper bounds. Cold archive/player searches, additional day/league keys, initial population, previews and separate external monitors can increase totals. The 6,500 reservation gate pauses new upstream fetches while preserving already saved displays; it cannot keep live information current after the provider budget is exhausted. A single saved match shown to 1,000 readers is not 1,000 upstream fetches.

## Important limits and acceptance checks

This is shared read-through caching with TTLs and the existing CDN, not a complete independent scheduled ingestion system. The first cold/stale request can still wait for shared storage and an upstream refresh. Do not claim all first visits consume zero calls or that production latency has been measured. New Blob operations/transfer have separate Vercel costs; this change does not alter billing settings.

Before enabling in Production:

1. Recover the complete current CLI source. Apply only the reviewed diff and keep daily performance, article rendering, photo and AdSense changes intact.
2. Confirm the existing private Blob connection supports `get(useCache:false)` and conditional `put(ifMatch)`. Test leases and counters in isolated Preview storage. Do not silently use only memory if production storage is absent.
3. Confirm the live provider's bundle shape in one bounded request after quota availability. Verify initially absent optional sections do not block the main fixture or lose authored content.
4. Warm required fixtures/dates and same-ID photos. Data that has never been saved cannot be reconstructed during an upstream outage. Retain old persistent stores.
5. Browser checks: initial and repeated date switches, expired caches, simulated quota/timeout/empty responses, concurrent requests, ended and live matches, predictions/reports/labels, key players/MOTM/portraits, team/player/standings pages and AdSense gating.
6. Measure first/warm TTFB and date-switch timings against production; refuse promotion if missing content or slower behavior appears. Validate reset on the direct provider's UTC-day boundary (09:00 JST).
7. Reconcile the pre-existing complete-suite failures without changing unrelated editorial behavior to make a test green.
8. Preview first, then promote the exact tested deployment and repeat regression checks on am4football.com. Record its actual Deployment ID. No background promise or unverified completion claim.

## Primary references

- API-Football, "How to Optimize API-Sports Calls and Quota Usage": https://www.api-football.com/news/post/how-to-optimize-api-sports-calls-and-quota-usage
- API-Football terms, direct dashboard UTC reset versus RapidAPI subscription-time reset: https://www.api-football.com/terms
- Vercel Blob SDK conditional writes: https://vercel.com/docs/vercel-blob/using-blob-sdk
- Vercel private storage consistent reads: https://vercel.com/changelog/vercel-blob-now-supports-consistent-reads-on-private-storage
