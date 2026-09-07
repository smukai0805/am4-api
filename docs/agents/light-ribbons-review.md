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

## Preview revision 2

The user requested a slightly thicker line, purple → red → yellow → blue bands within it, and a modest left accent to break the repeated right-only composition. The main ribbon now has 2.1–2.6-unit colour strokes with a soft halo and an end fade. A separate three-line left sweep uses a different bend, size and vertical placement. Desktop and mobile backgrounds use both assets; left-side colour is dimmer and masked away from central text. The home pseudo-element resets the old circle's border, radius, shadow and offscreen geometry without changing the sticky container.

Verification: seven existing control/motion tests passed, PostCSS parsed the updated stylesheet, both SVG assets parsed as XML, four cache-version references matched, and `git diff --check` passed. Independent source review found no P1/P2. The review identified a colour-direction ambiguity on the left curve; its four offsets were reversed so both bends run from purple on their inside through red and yellow to blue outside. Browser appearance remains for user preview review.

## Preview revision 3

The user's screenshot showed the same ribbon bend repeated on the COLUMN section and its nested 20 Seasons feature card. The card now uses an opaque navy gradient, a soft light from its lower-left corner and the existing large translucent 20. The section keeps the prismatic ribbons. Opaque default and hover surfaces prevent the section motif from showing through the card; the obsolete mobile ribbon override is removed. Card geometry, typography, text and links stay intact. Avoid repeating a section's decorative motif inside its nested feature card.

Verification: six existing series/motion tests passed; PostCSS parsing and `git diff --check` passed. Independent source review found no P1/P2 and confirmed opaque default/hover surfaces, removal of mobile ribbon overrides, safe stacking and unchanged layout/interaction. Browser appearance remains for user preview review.
