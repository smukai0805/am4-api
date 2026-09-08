# Safe reading improvements · 2026-09-08

User-approved goal: improve AM4's reading/navigation experience without making
existing articles inaccessible. Base: `3f4e61806a0d8fe82d7c01fa995b5a40518c487c`.

## Invariants

- Do not change Notion originals, article IDs, existing URLs, API contracts,
  publication filters, fixture matching, caches, spoiler protection or storage keys.
- Reading enhancements must be optional: their failure must not replace a
  successfully loaded article with an error screen.
- Preserve body prose, sources, tables, quotes, recommendations and save actions.
- No fabricated summaries, MOTM selections, publication status or reading progress.
- No production promotion until tests, independent review and browser QA pass.

## This release

1. Stabilize same-page navigation after opening Saved, including keyboard/history.
2. Suppress flattened table-of-contents excerpts on cards; keep ordinary prose.
3. Link HTTP(S) source URLs safely and build a collapsible TOC from actual headings.
4. Add a series return and previous/next *published* story links, plus season jumps.
5. Remove only the observed obsolete MOTM writer instruction in reader displays.
6. Make long match summaries expandable without losing any of their text.
7. Compact the static transfer placeholder; preserve existing favourites.

## Deferred for separate, explicit verification

Permanent fixture-ID migration, server-rendered per-article SEO/routing, automatic
content generation, notifications and new persistent reading-history storage.
These cross the data/routing boundary or require a product/privacy decision and
are not mixed into the article-safety release.

## Baseline and release checks

- Baseline: 206 tests pass; clean production worktree.
- Article routes: Leicester `notion-am4_story-3d2b49a367ef818aad4de9433ebb3cdc`,
  Kaka `notion-am4_story-3d0b49a367ef813ebcc6e440037c2026`.
- Match: Getafe/Celta `1570368`; predictions `1635609`, `1635643`, `1635686`.
- Test valid/invalid URLs, repeated headings, optional enhancement/list failure,
  tables/quotes/body preservation, unavailable/missing/retry and save behaviour.
- Verify home Saved → COLUMN, article TOC/source links, series navigation, match
  expansion, existing score hiding and absence of horizontal overflow.

Release results are appended after verification.
