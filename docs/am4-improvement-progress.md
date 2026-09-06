# AM4 improvement progress — 2026-09-06

## Start-state and safety record

- Working branch: `codex/am4-improvements-20260906`, in a separate worktree.
- Worktree base: `4df00816b84d1fa04aaa300bf8b7ba5686419074` (`am4-production` local head at start).
- Remote `origin/am4-production`: `5e398f58c4313ed658407b91d49d4e458c88e334`; this is the audit commit supplied in the request, and was not checked out, reset, or reverted to.
- The source worktree was clean and left unchanged. No production branch, remote branch, Vercel deployment, production data, Notion page, environment variable, paid generation job, or scheduled job was modified.
- `https://am4football.com/` responded `200` through Vercel on 2026-09-06 JST. The accessible response did not prove a deployment commit, so the currently deployed Git revision remains **unverified** without approved Vercel project access.

## Phase 1 — defects and data reliability

| Item | Status | Implemented / confirmed |
| --- | --- | --- |
| 4-1 Saved article and club restoration | Fixed | Saved entries now retain small local metadata separately from the home catalog. Article pages persist their own metadata; the home restores each saved article by ID without deleting IDs on transient failure. Legacy IDs remain reachable as safe placeholders. Storage-write failure does not show a false saved state. |
| 4-2 Missing article vs temporary failure | Fixed | Article detail distinguishes `404` from non-`404` HTTP failures and transport failures; the latter show a retry action. Article-store read failures now propagate to the API instead of becoming false absence / empty results. Column search preserves current data and offers retry on failure. |
| 4-3 Undefined confidence displayed as 0% | Fixed | Notion parsing and client presentation accept only explicit finite numeric percentages in `0..100`; `null`, `undefined`, empty strings, numeric strings, and invalid values are not rendered as a percentage. Explicit numeric `0` remains valid. |
| 4-4 Table of contents in card deck | Fixed | Shared excerpt normalization detects structural contents/source lists without article-specific exceptions, preserves prose and ordinary bullet summaries, and omits a deck when no safe introduction exists. |
| 4-5 Publication date consistency | Fixed | Article detail, home cards, and 20 Seasons use one safe `Asia/Tokyo` formatter. Invalid dates render as empty / unset instead of crashing a page. |
| 4-6 Structured sources | Fixed | Notion source blocks are normalized into safe `http(s)` structured sources with title and URL; valid references are removed from duplicate body output, while unparseable source lines stay in the body. |
| 4-7 Content badges after the first 50 fixtures | Fixed | Fixture IDs are deduplicated and requested in bounded batches. Successful batches update their cache; a failed batch does not mean “no article”; stale responses are ignored and redraw preserves scroll position. |
| 4-8 Automatic generation route | Fixed in code / operations unverified | `自動生成` is no longer a public Notion state. The transfer-news writer is skipped and returns retryable `503` when its research call fails, verified with injected local mock clients. Existing report/player pipelines save drafts. Production logs, provider balance, and cron execution were not queried or invoked because credentials / paid external execution were out of scope. |

### Phase 1 files and rationale

- `favorites.js`, `article-page.js`, `index.html`: durable saved-item restoration and honest storage failure handling.
- `article-presentation.js`, `article-load-state.js`, article / series / match pages: shared date, excerpt, confidence, and load-state rules.
- `lib/notion-content-sync.js`, `lib/article-store.js`: safe Notion-source normalization, valid confidence parsing, correct public-state gate, and error propagation.
- `match-centre.js`: all-fixture bounded content-availability batches.
- `lib/transfer-news-core.js`, `api/transfer-news-watch.js`: prevent source-less publication after research failure.
- Focused tests: `tests/favorites.test.js`, `tests/article-presentation.test.js`, `tests/article-load-state.test.js`, `tests/notion-content-sync.test.js`, `tests/match-centre.test.js`, `tests/transfer-news-core.test.js`.

### Phase 1 validation

- `git diff --check` — passed.
- `npm test` — **111 passed, 0 failed**. Existing Node module-type warnings were retained; no package configuration was changed.
- Browser and responsive screenshots: **pending Phase 2 UI changes**. No production browser behavior is being represented as locally verified.

## Phase 2 — favorites and discovery

Work begins only after the Phase 1 suite above passed. Pending implementation and verification:

- Favourite club / league ordering without duplicate fixtures; retained date and round navigation.
- Top-level routes for fixtures, COLUMN, 20 Seasons, and saved items; compact, keyboard-accessible favourite controls.
- Readable Japanese prediction/report badges; no empty-major-league blocks ahead of real fixtures.
- Restore list state after match or article navigation; safe expiry for device-only state.
- Mobile/zoom/reduced-motion/accessibility checks and real browser screenshots.

## Phase 3+ recommended follow-up (not implemented here)

1. Match-detail editorial flow: post-match explanation summary, preserved pre-match prediction, result comparison, and separate official vs AM4 MOTM metadata.
2. COLUMN / 20 Seasons reading flow: heading hierarchy, clickable contents, published-only previous/next/series links, separately tracked read state, and clearly separated latest/editorial/popular concepts.
3. Search / sharing: article-specific initial HTML, canonical/OGP/sitemap/structured-data design while preserving URLs and handling unavailable content correctly.
4. Scale and trust: paged article retrieval with independent editorial/live caches, then editorial policy/corrections/contact routes only from verified operator information.

## Release requirements

- Complete Phase 2 tests and local browser verification, including screenshots at the requested widths.
- Review the final diff and receive explicit authorization before any push, merge to `am4-production`, Vercel preview creation requiring external authorization, or production deployment.
- For the generation route, inspect authorized provider/Vercel logs before changing cron schedules, balances, notification destinations, or external configuration.
