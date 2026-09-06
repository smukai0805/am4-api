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
- The behavior was subsequently exercised against the current working tree during Phase 2 browser verification; this is a local preview only, not a production claim.

## Phase 2 — favorites and discovery

Work began only after the Phase 1 suite above passed.

| Item | Status | Implemented / confirmed |
| --- | --- | --- |
| 5-1 League / club favourites | Fixed | Compact ☆/★ controls use stable provider IDs, retain legacy club matching, stop propagation from match cards, expose pressed state / labels, and keep stored article / club data. Fixture groups are ordered favourite clubs, favourite leagues, then other competitions, with each fixture shown once. |
| 5-2 Article discovery navigation | Fixed | The top navigation now exposes matches, COLUMN, 20 Seasons, and saved items before the long fixture list. `#for-you` restores saved articles independently of the current home catalog and provides a safe remove action for unavailable saved entries. |
| 5-3 Editorial badges | Fixed | Match cards use `予想あり` / `解説あり` for Japanese and English labels for English, at a 11px baseline without lengthening cards unnecessarily. |
| 5-4 Empty states and return behavior | Fixed | Provider failures now render an unavailable state rather than sample fixtures. URL selection state is shareable; scroll / expansion / spoiler state is device-only, expires after six hours, and is restored only for the matching list selection. Article and match return links honor the saved home/list state. |
| 5-5 Small-screen and motion resilience | Fixed in code / partially browser-verified | The viewport no longer limits zoom, horizontal overflow is clipped at the document boundary, reduced motion disables smooth scrolling / reveal reliance, and semantic buttons retain focus-visible behavior. Chromium viewport checks are complete; actual browser 200% zoom and iPhone Safari remain unverified. |

### Phase 2 files and rationale

- `navigation-state.js`, `article-page.js`, `article.html`, `match.html`, `match-detail.js`: bounded, internal-only return-state storage and match/article return links, including the loading-state return link.
- `match-centre.js`, `tests/match-centre.test.js`, `tests/navigation-state.test.js`: favourite priority/deduplication, localized badges, failure state, and URL/device-state rules.
- `index.html`, `brand.css`: main discovery navigation, saved-item recovery/removal UI, responsive cards, zoom-friendly viewport, and reduced-motion / overflow behavior.

### Phase 2 validation

- `node --check navigation-state.js match-centre.js match-detail.js article-page.js` — passed.
- Focused tests (`tests/navigation-state.test.js`, `tests/match-centre.test.js`, `tests/favorites.test.js`) — **21 passed, 0 failed**.
- Full `npm test` — **117 passed, 0 failed** after the final state-restoration and cache-reference changes. Existing Node module-type warnings remain unchanged.
- `git diff --check` — passed.
- Independent final review found a stale bare-home state restore and protocol-relative return-link acceptance; both were corrected with navigation-state regression coverage (including invalid calendar dates).
- Updated modified static asset references use a shared version token and were reloaded in the local browser; the loaded CSS, favourites, editorial presentation, navigation, and match-centre resources all resolved to the current version.
- Local Chromium preview at `http://127.0.0.1:4180/` (current worktree; no deployment):
  - Saved three distinct article-detail pages, returned home, reloaded, opened `保存`, and confirmed all three restored article destinations.
  - Added a league and a club; confirmed the click did not navigate, ordering was club → league → other, no duplicate Rayo fixture appeared, and both persisted after reload.
  - Opened a match detail and returned through its visible return link; the list URL, daily selection, favourite ordering, and list viewport were restored.
  - After opening a shared 2026-09-07 list, opening a fresh home URL correctly selected the current Tokyo date rather than reusing the stale device-only selection.
  - Inspected actual screenshots at 360, 375, 390, 430, 1280, and 1440 CSS pixels. This is Chromium viewport testing, not iPhone Safari testing.
- Screenshots inspected: `docs/screenshots/am4-home-mobile-360-top.png`, `am4-home-375.png`, `am4-home-390.png`, `am4-home-430.png`, `am4-home-1280.png`, `am4-home-1440.png`, `am4-for-you-saved-articles.png`, and `am4-match-return-restored.png`.

## Phase 3+ recommended follow-up (not implemented here)

1. Match-detail editorial flow: post-match explanation summary, preserved pre-match prediction, result comparison, and separate official vs AM4 MOTM metadata.
2. COLUMN / 20 Seasons reading flow: heading hierarchy, clickable contents, published-only previous/next/series links, separately tracked read state, and clearly separated latest/editorial/popular concepts.
3. Search / sharing: article-specific initial HTML, canonical/OGP/sitemap/structured-data design while preserving URLs and handling unavailable content correctly.
4. Scale and trust: paged article retrieval with independent editorial/live caches, then editorial policy/corrections/contact routes only from verified operator information.

## Release requirements

- Obtain actual browser-zoom (200%) and iPhone Safari checks if release acceptance requires them; neither is implied by the Chromium viewport evidence above.
- Review the final diff and receive explicit authorization before any push, merge to `am4-production`, Vercel preview creation requiring external authorization, or production deployment.
- For the generation route, inspect authorized provider/Vercel logs before changing cron schedules, balances, notification destinations, or external configuration.

## Production release and publication-gate follow-up

- `am4-production` was fast-forwarded to `3473bf8` and pushed after the Phase 1/2 release checks. GitHub's Vercel deployment status reported `success` for the Production environment, and `https://am4football.com/` returned the updated navigation and versioned assets.
- Read-only production API checks returned `200` for the public article list and the bounded content-availability route. The home page loaded the current fixture list in Chromium without browser-console errors.
- The first 100 public archive records inspected after release still carried Notion state `自動生成` while their legacy Blob flags said `status: 'published', public: true`. This is a fail-open gap for pre-gate records, not evidence that a generation job is currently failing.
- Follow-up hotfix: a record with a Notion `pageId` is now public only when its mirrored state is `公開準備` or `公開済`. Historical records without Notion provenance retain their existing public rule. This intentionally fails closed when Notion state is stale or unavailable; a later authorized Notion sync can persist the corresponding retractions or republish records that have been editorially advanced.
