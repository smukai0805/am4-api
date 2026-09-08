# Reading and COLUMN navigation

Scope: retain the existing AM4 visual design and all article bodies while making long reports and the article archive easier to use.

- Keep MOTM visible. Put the existing subsequent report blocks inside one native disclosure whose summary names every available section. Preserve open state when switching match tabs; provide a close button at the end.
- Add a sticky top-right Read Later button to articles, synchronize it with the footer, and show storage failures beside the action. Add Read Later to the match editorial heading.
- Rename the home destination to あとで読む, show saved articles first, and keep club/league/player favorites under their own heading. Keep existing storage keys.
- Add `/column`: eight compact rows per page, server-backed search, explicit pagination, current-page navigation, and article return links retaining the query, page, and selected row. Show retrieval failures separately from empty results; ignore stale search responses.
- Keep Notion sync, article identities, body rendering, data APIs and spoiler rules unchanged. Missing optional report-reading code falls back to the full report.

Verification: 247 automated tests pass, including prose preservation, disclosure state/focus, paired bookmarks/storage failure, safe return links, pagination/search races, error/retry, and existing article/data regressions. Independent UI review identified and re-reviewed a fix for saving newly published Notion reports before archive sync: only the same article ID from the public fixture editorial endpoint may fill an archive 404. Both report and prediction are covered.

Browser checks on the initial preview confirmed Getafe–Celta's eight report blocks and Leicester's 63 article blocks retain the same prose; disclosure state survives tab switches, the bottom close restores focus, and search → article → return and save → home → reopen work. Browser QA also found two layout issues: an arriving home hash drifted after async fixture loading, and body overflow created a non-scrolling sticky container. The follow-up aligns an initial hash until reader interaction, gives an existing saved scroll restoration precedence, and uses overflow-x:clip for the article/match/column page shells. Final preview verification is recorded in PR #13. Real iPhone/Safari behavior has not been verified in this environment.

Further UI candidates, requiring separate scope: a small in-article section navigator for long reports, explicit unread/read organization in the reading list, and one consistent return path/current-position indicator across fixtures, articles, and collections. Avoid adding multiple new navigation bars before testing their combined mobile footprint.
