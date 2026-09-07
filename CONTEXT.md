# AM4 domain context

AM4 is a Japanese-language football media site covering Europe's top five leagues. Its editorial promise is to help readers discover player and club stories, supported by match and performance data.

- **看板記事**: the primary editorial story for first-time visitors.
- **For You**: returning-visitor content derived from locally saved clubs, players, and articles.
- **AM4予想**: an editorial predicted lineup based on provider data, with changes and reasoning disclosed.
- **試合予想・試合解説の対象**: 国内リーグは欧州5大リーグを基本対象とする。UEFA Champions LeagueとUEFA Europa Leagueは例外で、所属国内リーグに関係なく、大会に出場する男子トップチームの全カードを両方の編集対象にする。ELを任意扱いにしない。
- **AM4注目度**: upcoming-match ranking led by picked-club matchups, then editorial boosts for major rivalries, Champions League and top-five domestic league fixtures, and Japan-friendly kickoff times; proximity breaks otherwise equal scores.
- **今日の試合**: the Japan-time daily schedule across every competition returned by the provider, including club friendlies. Favorite clubs/leagues, the five major leagues, CL/EL/Conference League and the five countries' domestic cups appear first. Other competitions are grouped under a closed-by-default 「その他の大会を開く」 disclosure. Opening it reveals the full remaining competition directory; favorites move outside it without duplicate fixtures. Open/closed state is retained for the current date/filter and match-detail return.
- **TOP CLUB**: AM4's fixed 15-club visual spotlight: the Premier League Big 6, Barcelona, Real Madrid, Atlético Madrid, Bayern Munich, Borussia Dortmund, Inter, Juventus, AC Milan, and Paris Saint-Germain. A fixture with one listed club receives a restrained club-colour glow; a fixture between two listed clubs is a gold-accented **BIG MATCH**. Chronological order remains primary, with prestige used only to order identical kickoff times.
- **結果を隠す**: the default spoiler-safe state in the match list for live and completed matches (updated to match the user's card reference on 2026-09-07). Only the score digits appear blurred; the separator, match phase, club logos and editorial badges remain clear. Both concealed digits use the same neutral silhouette so digit shape or score length cannot disclose the result. The visitor's existing result-visibility preference controls live and completed scores together. Match-detail result handling is separate.
- **サンプル代替**: clearly labelled static data shown only when a live provider response is unavailable.
