# AM4 night stage visual release

Base: `am4-production` at `e76a208afcee9a45f4d00b0525ffceedaae85d0d`.
Work branch: `codex/am4-night-stage-20260906`.

## Changes

- A shared, restrained navy / blue-white visual layer for the home, match centre, column, archive and article header.
- A strong MATCH CENTRE opening and a typographic signature card for the existing 20 Seasons, 20 Stories. route.
- Clear score and active-tab emphasis, striped navy pitch and decorative field markings.
- Existing compact summary/event rows, scorer photos, player placement and data flows retained. No external assets or API calls added.

## Verification

- Existing test suite: 91 passed, zero failed.
- JavaScript syntax, changed HTML inline scripts and `git diff --check`: passed.
- Browser: home and COLUMN at 360 / 390 / 430 / 1280 widths; overview at 390; 4-3-3 pitch at 360; 3-5-2 pitch at 360 / 430 / 1280. Long names remain readable and names do not overlap in the five-player row.
- Browser: overview-to-lineup tab action, sticky tab appearance, COLUMN-to-existing-series navigation.
- Independent UI review: home CSS specificity issue corrected; fallback-font heading can wrap. No unresolved P1/P2 findings.
- The development browser initially retained an earlier stylesheet. A versioned stylesheet URL was advanced to `night-v2`, then the final home padding and single-line controls were visually confirmed.

## Limits

- Match browser fixtures are explicitly labelled synthetic QA data, not real match results.
- Local API proxy requests failed for live fixtures/articles; the error states remained explicit. Real Notion article bodies were not reverified in this visual pass. API/Notion code and routes are unchanged.
- Runtime production deployment state, alias assignment and public asset/API responses are checked separately after publishing.
