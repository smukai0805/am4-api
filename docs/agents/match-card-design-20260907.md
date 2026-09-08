# Match card design proposal — 2026-09-07

Based on the user's attached AM4 card reference and production source `945aa6ff215c44d6a5afe101985c720f61c3f036`.

- Club crests: 60 px on desktop, 48 px on mobile, 44 px on narrow mobile. Mobile names sit below crests and wrap.
- Score concealment: blur only the two digit elements, leaving the separator clear. Use identical neutral silhouettes so actual digit shape and score length cannot disclose results. Hidden scores stay out of assistive labels and team-score text.
- The existing visibility preference now covers live and completed scores in the match list, matching the reference. Upcoming kickoff times and the match phase remain readable. Match-detail behavior is separate.
- Editorial badges: larger blue outlined labels in the card's upper right, populated by the existing availability lookup. Both badges may wrap when space is limited.
- League identity: larger readable name, original logo on a light tile, and restrained league-specific left accents. Favorites retain individual competition labels.

## Verification

- 49 relevant tests pass across match-centre, football-data, navigation-state and home-motion-safety.
- JavaScript syntax checks, index inline-script parsing and `git diff --check` pass.
- One independent static review found no P1/P2 issues in the card diff; the subsequent live-score and phase-label additions are also reviewed before saving.
- Browser verification was not performed: the active Sites skill limits browser QA to an explicit user request. Layout conclusions are based on source review, not screenshots. Preview should be checked at narrow mobile and desktop sizes before production release.
- This is a proposal on a separate branch. No production branch update or production release is included.
