# AM4 light ribbons · 2026-09-08 JST

Base: `am4-production` at `c839cb8`.

The existing night-stage theme had faint straight accents but lacked the defined luminous curves and deep blue gradient requested in the user's reference. The shared theme now adds an original five-line SVG accent in blue, cyan and violet, stronger navy/ultramarine backgrounds, and lighter existing display-font weights on MATCH CENTRE and the 20 Seasons hero. The four affected HTML entrypoints use a new stylesheet version.

Scope: home, match detail, article framing and 20 Seasons. Match-card dimensions, score concealment, editorial badges, APIs, page content, control markup and JavaScript are unchanged. Static decorations occupy background or non-interactive pseudo-element layers. Home overflow remains visible so date controls can stay sticky. Small-screen overrides crop and dim the ribbons. No new fonts, dependencies, animation or image-generation assets are required.

Validation:

- 44 existing tests passed for match-card controls, score reveal/concealment, competition grouping, editorial availability, favourites, navigation state, motion safety and the series collection.
- PostCSS parsed the stylesheet, XML parsing validated the SVG, and all four updated stylesheet references were checked.
- `git diff --check` passed.
- Independent source review passed with no P1/P2 findings. The review checked background stacking, sticky dates, mobile rules, loaded font weights, focus/tap targets and score concealment.

Browser verification was not run: the active Sites workflow permits browser/visual QA only when the user explicitly requests it. Source checks cannot confirm the final rendered appearance; provide the Vercel preview for visual review. Production release is not part of this change.
