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
- A first runtime hotfix that applied the state gate at every public read was immediately withdrawn: the observed legacy state would have hidden the active article archive. The durable guard instead keeps `自動生成` non-publishable for **new** synchronizer imports while preserving an already published legacy archive record; explicit review/non-public states still retract existing mirrors. A canonical editorial publication field and authorized Notion migration remain required before this legacy exception can be removed.

## 2026-09-07 match editorial display hotfix

- **Reproduced in production:** `GET /api/articles?matchContent=1&fixtureId=1570368` for Getafe v Celta Vigo returned `200` with both `prediction` and `report` empty and no source error, matching the reported detail-page placeholder.
- **Root cause:** the live Notion detail lookup correctly excludes raw `自動生成` pages, but its successful empty result did not trigger the existing public Blob archive fallback. The matching prediction exists in the public archive with `status: 'published'` and `public: true`.
- **Fixed locally, release pending:** `match-detail.js` now falls back for every missing editorial type, not only an explicit live-source error. The fallback still accepts only a public archive record with a matching fixture ID or canonical Match Key; it cannot expose a draft or unrelated article. The modified detail script receives a new versioned URL so cached clients load the fix.
- **Regression coverage:** `tests/match-editorial-fallback.test.js` covers a successful empty live result, preserving live content, a truly absent archive item, transient archive retrieval failure, and a total archive-list failure that remains retryable.
- **Validation:** targeted tests passed (24); full `npm test` passed (**123 passed, 0 failed**); `node --check` and `git diff --check` passed. The local browser surface could not connect to the localhost Vite server in this environment, so visual confirmation remains pending a permitted preview or production deployment.
- **Required approval:** commit, fast-forward/push to `am4-production`, and production deployment verification. No Notion content, Blob data, cron configuration, or paid-generation job is changed by this patch.

## 2026-09-07 archived-match recovery and editorial-numbering follow-up

### Start state and scope

- Current production branch and base verified before this follow-up: `am4-production` at `cb182d70ec59c53b47abc0805350dc14f0dd2fbc` (`Restore published match editorials`). The older audit commit `5e398f58c4313ed658407b91d49d4e458c88e334` was not restored or checked out.
- Work branch: `codex/archive-match-recovery-and-list-numbering-20260907` in a separate worktree. No existing user change was reset, deleted, or overwritten.
- Scope is limited to public match-editorial recovery and stale editorial-list numbering. No Notion source data, Blob data, environment variable, cron configuration, paid generation, or publishing status was changed.

### Findings and fixes

| Issue | Root cause and reproducing condition | Status |
| --- | --- | --- |
| Past public editorial disappears with an expired provider fixture | The detail page began with the current fixture API. When that API no longer returned a fixture, it exited before its existing public editorial path could run. Production data for Ipswich Town v Liverpool on 2026-09-04 still has a public/published match report keyed as `Premier League|2026-09-04|Ipswich Town|Liverpool`, while the current date fixture API does not return that fixture. | Fixed in code; production verification pending this release. |
| Unsafe archive recovery risk | Fixture names and legacy IDs alone can collide across seasons or be stale. | Fixed: provider fixture remains first; fallbacks use a saved fixture ID identity, an exact canonical Match Key (competition/date/home/away with explicit aliases), then a public article anchor. Only `published` and public match prediction/report records are eligible. Ambiguous, draft, private, non-editorial, missing, and temporarily unavailable archive states stay distinct. |
| `35`, `36`, `35.36` style values in editorial UI | `lib/notion-content-sync.js` generated numbered-list Markdown from the Notion page-wide block index (`index + 1`). A list after 34 unrelated blocks became `35.`, `36.` etc.; a following numerical sentence could visually read as `35.36`. | Fixed: synchronizer numbers each contiguous Notion ordered-list run locally from 1. A renderer also normalizes already-published legacy, non-one consecutive ordinal runs into semantic ordered-list DOM, while preserving meaningful minutes, scores, dates, and percentages as prose. |

### Changed files

- `match-archive.js`, `match-detail-loader.js`, `match-detail.js`, `match.html`: public archive resolution, provider-first loading, honest unavailable/absent states, article/archive entry route, and archive-only overview.
- `api/articles.js`, `lib/article-store.js`, `football-data.js`, `article-page.js`, `article.html`: bounded public Match Key lookup and a durable article-to-match archive link. Alias/canonical-key logic is shared so API and client cannot drift.
- `lib/notion-content-sync.js`, `editorial-list.js`, `brand.css`: local ordered-list numbering at sync time and semantic legacy-list rendering without rendering stale ordinal text.
- `tests/article-store.test.js`, `tests/football-data.test.js`, `tests/match-archive.test.js`, `tests/match-detail-loader.test.js`, `tests/notion-content-sync.test.js`, `tests/editorial-list.test.js`: archive and numbering regression coverage.

### Validation before production

- Regression tests cover: provider fixture present; provider fixture absent; saved fixture-ID lookup; Match Key recovery; public article-anchor-only recovery; Ipswich aliases; published vs draft/private/non-editorial candidates; no matching article; partial and complete archive outage; stale list ordinals; meaningful numerical prose; surrounding intro/outro prose.
- `npm test` — **140 passed, 0 failed**.
- `node --check match-detail.js match-detail-loader.js match-archive.js editorial-list.js lib/article-store.js lib/notion-content-sync.js api/articles.js` — passed.
- `git diff --check` — passed.
- Independent code review passed after correcting the archive description to say that current match data is unavailable, rather than assuming every case is outside the provider date window.
- Local Chromium viewport check at `390×844` against the public Ipswich archive article route confirmed the archive header, both published editorial sections, and semantic list rendering. Screenshot: `docs/screenshots/am4-local-ipswich-archive-390.png`. This is Chromium viewport evidence, not iPhone Safari verification.

### Release state

- Commits prepared: `959ba5d Restore public archived match editorials`; `337399c Normalize editorial list numbering`.
- Production fast-forward/deployment and post-deploy browser confirmation remain pending at the time of this entry.

### Production release verification

- `am4-production` was fast-forwarded from `cb182d7` to `1a2d079` and pushed to `origin/am4-production`. The Vercel commit status for `1a2d079` completed with `success` in the Production environment.
- Production `match.html` now references the cache-busting `20260907-archive-match-v2` and `20260907-editorial-list-v2` assets.
- Read-only production API checks:
  - `GET /api/fixtures?date=2026-09-04` returned 215 current fixtures and zero Ipswich–Liverpool matches.
  - Public Match Key lookup returned exactly one `published` / `public: true` Ipswich Town v Liverpool prediction and exactly one `published` / `public: true` report, despite that missing fixture response.
- Chromium production viewport checks, with screenshots opened and inspected:
  - `390×844`: Getafe v Celta Vigo rendered its normal provider fixture and the existing AM4 prediction; Ipswich Town v Liverpool rendered `AM4 ARCHIVE` with its prediction and report.
  - `390×4000`: the Ipswich report's affected legacy lists rendered as semantic local sequences (`1.`, `2.`), not stale `35.`, `36.`, or concatenated `35.36` values.
  - `1440×1100`: the Ipswich archive card, archive-only navigation, and editorial layout rendered without a desktop regression.
  - Screenshots: `docs/screenshots/am4-production-getafe-celta-390.png`, `docs/screenshots/am4-production-ipswich-archive-390.png`, `docs/screenshots/am4-production-ipswich-archive-full.png`, `docs/screenshots/am4-production-ipswich-archive-1440.png`.
- This confirms Chrome/Chromium rendering only; it is not an iPhone Safari or physical-device claim.
- Known safe limit: a historic bare `match.html?id=…` URL cannot be reconstructed if neither the public archive record carries that fixture ID nor the URL/device cache carries a Match Key. The implementation deliberately does not guess a fixture from club names alone. Public match article pages now provide a durable article-plus-Match-Key route; migrating any already-distributed unanchored numeric URLs would require an explicit historic fixture-ID mapping as separate data work.

## 2026-09-07 normal-fixture Match Key follow-up

- **Reproduced from the user-reported normal match page:** fixture `1557393` (Ipswich v Liverpool) still returns a provider detail and score, so it does not enter the provider-missing archive page. Its live Notion lookup and fixture-ID archive lookup are empty. The public date lookup returns six reports including Ipswich–Liverpool, and an exact Match Key lookup returns the one public report.
- **Root cause:** the normal detail-page fallback still used a local, non-aliased name comparator and date-wide list query. Provider `Ipswich` therefore did not equal archive `Ipswich Town`, despite the shared archive fallback already knowing that explicit alias.
- **Fixed:** `match-archive.js` now supplies the normal page with an ordered fixture-ID plus canonical Match Key query set and one strict public identity matcher. `match-detail.js` uses that shared matcher both before and after full-article retrieval. A record with a different explicit fixture ID remains rejected; draft/private/non-editorial entries remain ineligible.
- **Regression test:** `tests/match-archive.test.js` adds the real fixture `1557393` case, asserting the canonical `premierleague|2026-09-04|ipswichtown|liverpool` query plus public prediction/report recovery and draft rejection. The test was first run red before the shared helper existed, then passed with the fix.
- **Validation before release:** `npm test` — **141 passed, 0 failed**; `node --check match-archive.js match-detail.js`; `git diff --check` — passed. Independent review passed; it found no blocker.
- **Local Chromium confirmation:** normal route `match.html?id=1557393` displayed the completed provider fixture plus `AM4 MATCH SUMMARY` body, instead of the report-preparing placeholder. Getafe v Celta Vigo still displayed `AM4 PREDICTION`. Production verification is recorded below.
- **Production release:** `am4-production` was fast-forwarded from `d537e3e` to `b0221f2` (`Restore archive editorials on normal fixtures`) and pushed to `origin/am4-production`. Vercel reported `success` for that commit.
- **Production browser confirmation:** at a measured `390×844` viewport, `match.html?id=1557393#overview` rendered the normal Ipswich v Liverpool fixture and its `AM4 MATCH SUMMARY` body, including the match-summary lead and “試合を分けたポイント”; the report-preparing placeholder was absent and there were no captured console errors. The existing Getafe v Celta Vigo route still rendered its `AM4 PREDICTION` body without its placeholder or console errors.
- **Production screenshots opened and inspected:** `docs/screenshots/am4-production-normal-ipswich-summary-390.png`, `docs/screenshots/am4-production-normal-getafe-preview-390.png`. This is browser viewport evidence, not iPhone Safari or physical-device verification.

## 2026-09-07 completion pass — evidence gate and motion-safe content

### Start state and safety record

- Working branch: `codex/normal-fixture-match-key-fallback-20260907`; base and production head before this pass: `4f1b52b` (`Document normal fixture editorial verification`). The supplied historical audit commit was not restored, checked out, or used as a reset point.
- The worktree was clean before this pass. No Notion page, Blob data, environment value, cron configuration, provider balance, or paid generation request was changed.
- A read-only production runtime review found current failed generation attempts caused by the external AI provider's insufficient credit balance. The active paths include transfer research, match-report research/write, and academy research/write. This was not inferred from old audit text; it was observed in current runtime errors.
- Current cron configuration remains unchanged: academy twice daily, match reports three times daily, transfer monitoring four times daily, Notion sync three times daily, and trending once daily. The former daily-digest / AI-column schedules are not active.

### Completed code changes

| Item | Status | Change |
| --- | --- | --- |
| 4-8 Automatic generation safety | Fixed in code; provider balance needs external action | `match-report` and `academy` now stop before the writer when research gets a 5xx, network interruption, timeout, empty response, text-only response, source-only response, or unsafe source URL. A valid non-empty research note and at least one structured `http(s)` source are both required. The existing transfer-publication research gate remains in place. Match and academy outputs were already drafts only; this eliminates source-less draft creation and redundant paid writer attempts too. |
| 5-5 Motion resilience | Fixed in code | Homepage and 20 Seasons content no longer starts hidden behind an optional IntersectionObserver reveal. Removing this decorative dependency guarantees that a script error or disabled motion cannot leave real content transparent. The 20 Seasons CSS and script URLs have new cache keys together. |

### Regression coverage and verification before release

- `tests/generation-research-gate.test.js`: both match-report and academy paths require research before writing. Covers 5xx, network interruption, timeout, empty, text-only, source-only, and `javascript:` source cases; successful research calls `research → write` and returns only the safe structured source.
- `tests/home-motion-safety.test.js`: homepage and 20 Seasons do not emit hiding reveal classes/observers; reduced-motion styling remains explicit.
- Red/green sequence completed: research-failure and incomplete-research cases initially showed an unwanted writer call, then passed after the gate was added.
- `npm test` — **160 passed, 0 failed**. Existing Node module-type warnings were retained; no package configuration was changed.
- `node --check lib/match-report-core.js lib/academy-core.js column-series-page.js` — passed.
- `git diff --check` — passed.
- Independent code review found and required the empty/text-only/source-only/unsafe-URL research guard; the corrected diff was re-reviewed with no blocker.

### Commits and production verification

- `3532d7b Gate draft generation on research evidence`
- `3e09fff Keep homepage content visible without reveal scripts`
- Production: `am4-production` was fast-forwarded from `4f1b52b` to `3e09fff` and pushed. Vercel production deployment `dpl_EXt6WyMu78nBNTYfjpavVzW3yPnL` reported `READY` for commit `3e09fff` with the `am4football.com` alias.
- Production browser checks, screenshots opened and inspected:
  - At a measured `390×844` viewport, the home page had no `.reveal` / `.column-stagger` nodes, no horizontal overflow, and no transparent transfer, match, player, or COLUMN cards after data load. The top navigation, favourite controls, date controls, and results control remained exposed through the accessibility tree. Screenshot: `docs/screenshots/am4-production-home-motion-safe-390.jpg`.
  - At the same measured viewport, 20 Seasons loaded all 20 cards (11 published), with zero transparent cards and no console errors. Published card screenshots: `docs/screenshots/am4-production-20-seasons-cards-motion-safe-390.jpg`.
  - Responsive viewport checks at `360`, `375`, `390`, `430`, `1280`, and `1440` CSS pixels each found no reveal nodes, transparent target content, or horizontal overflow. These are browser viewport overrides, not physical-device validation.
  - Keyboard focus was exercised through the accessible match controls. Browser zoom could not be changed in this in-app browser (`Control++` left the viewport unchanged), so an actual 200% browser-zoom check remains unverified. iPhone Safari remains unverified as well.
- External operational finding at that time: restoring the AI provider balance would have been required to resume the then-active scheduled generation. Those schedules were subsequently retired below, so balance recovery is no longer needed for this site behavior. The code remains fail-safe if a protected endpoint is ever invoked manually.

## 2026-09-07 retired automatic AI generation schedules

- The operator confirmed that the automatic match-report, academy-player, and transfer-news generation paths are unused and should not continue to run. This is a scheduled-job stop only; no article, Notion page, Blob record, environment variable, or provider balance was changed.
- `vercel.json` removes all nine associated entries: match reports (three per day), academy-player articles (two per day), and transfer news (four per day). Trending refresh (one per day) and Notion article sync (three per day) remain enabled with their existing schedules.
- `tests/vercel-cron-config.test.js` prevents any of the three retired routes from returning to the Cron configuration and asserts the retained article schedules and expressions exactly.
- Validation: the new test failed before the entries were removed, then passed after the change. Full `npm test` passed with **162 passed, 0 failed**; JSON parsing and `git diff --check` also passed. Independent review found no blocker after the retained Cron expressions were added to the regression assertion.
- Production release: `87e9936 Disable retired AI generation crons` was pushed to `am4-production`. Vercel production deployment `dpl_AXRpC1mJGai5ZE5zWXkvFq2nC6RZ` reached `READY` with the `am4football.com` alias. The production home returned `200`; the targeted runtime-error scan found no new errors in these retired routes after deployment.
- Deliberately out of scope: the protected endpoint files and their generation logic remain in the repository for reversible historical reference, but have no configured scheduled invocation. The user-facing Football Hub “特集記事をリクエスト” feature and `/api/feature` are separate on-demand Anthropic functionality and were not changed by this approval.

## 2026-09-07 public match-editorial restoration completion

### Production starting point and scope

- Work branch: `codex/normal-fixture-match-key-fallback-20260907`. The production branch was at the already-deployed availability hardening commit `daea185`; no historical audit commit was restored, checked out, or used as a reset point.
- Scope: restore access to already-public match predictions/reports and their match-card availability. No Notion page, archive record, environment value, provider balance, or paid generation job was modified.

### Root causes and fixes

| Symptom | Root cause | Fix |
| --- | --- | --- |
| A detail page showed the preparation placeholder although its public archive article existed | Archive-list metadata intentionally omits `notion.pageId`, but the first fallback selector treated that list-shaped record as ineligible before its individual, strict fetch could run. | `fb4b57f` selects only `published`, public, correctly typed list candidates without requiring unavailable list metadata; the individual article fetch still requires the strict Notion identity and full fixture/Match Key verification. |
| Legacy match cards did not show `予想あり` / `解説あり` | Older public archive articles have no stored fixture ID, so fixture-ID-only availability could not find them. | `d5b36ad` adds bounded exact canonical Match Key availability for published/public legacy editorials; `daea185` keeps a malformed Match Key response from erasing otherwise valid fixture-ID badges. |
| The Ipswich v Liverpool card still lacked badges on the Japanese daily list | The daily schedule groups fixtures by Asia/Tokyo date (`2026-09-05`), while the provider/archive Match Key for its `04:00 JST` kickoff uses the UTC fixture date (`2026-09-04`). The same public article could therefore be found on a detail page but not from the daily card. | `e2efb5a` adds `fixtureMatchKey()`: when a valid kickoff instant exists it uses its UTC date for the archive identity, while retaining `fixture.date` as a safe fallback. Detail lookup, availability request, and card response matching now share it. |

### Files and regression coverage

- `match-archive.js`, `football-data.js`, `match-centre.js`: shared kickoff-based archive identity for public editorial lookup and card availability.
- `index.html`, `match.html`, `article.html`: updated versioned asset references so cached clients receive the same identity implementation.
- `tests/match-archive.test.js`, `tests/football-data.test.js`, `tests/match-centre.test.js`: real regression shape for fixture `1557393`, including its Tokyo/UTC date boundary, exact public Match Key, request query, and both badges.
- Full `npm test` — **168 passed, 0 failed**. Focused archive/card suite — **46 passed, 0 failed**. `git diff --check` and JavaScript syntax checks passed. An independent focused review found no P0/P1 issue.

### Production verification

- Production `am4-production` was fast-forwarded from `daea185` to `e2efb5a` (`Align editorial Match Keys with fixture kickoff`). The deployed home page serves the `20260907-editorial-availability-v2` assets.
- Read-only production availability response for the exact Ipswich Match Key returns both `report` and `prediction`; the Getafe Match Key returns `prediction`.
- In-app Chromium browser checks at a measured `390×844` viewport:
  - `match.html?id=1557393#overview` rendered `MATCH SUMMARY` body and did not contain the report-preparing placeholder.
  - `match.html?id=1570368#overview` rendered `MATCH PREVIEW` body and did not contain the prediction-preparing placeholder.
  - `/?matchDate=2026-09-05#fixtures` exposed the Ipswich v Liverpool card with both `解説あり` and `予想あり` in the accessibility tree.
  - No browser-console errors were captured on those three pages.
- Screenshots were opened and inspected through the in-app browser during this verification. They were not persisted as filesystem artifacts, so no new screenshot path is claimed. This is Chromium viewport evidence only, not iPhone Safari or physical-device verification.

### Remaining follow-up

- The broader Phase 1/2/3 roadmap remains separate from this urgent restoration; this entry does not mark the whole AM4 improvement program complete.
- The retired automatic AI generation schedules remain disabled. Re-enabling any generation path, changing provider balance, or modifying Notion publication state requires separate approval.
