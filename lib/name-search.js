// lib/name-search.js
//
// api/player-photo.js・api/player-stats.jsで共有する、選手プロフィール検索の
// 共通ヘルパー(2026-08-04追加)。
//
// 【発見した2つの不具合】自由に選抜モードでMbappé・Yamalの顔写真だけ取得できない
// 現象を実データで調査したところ、原因は別々の2つの問題だった。
//   ① アクセント記号付きの姓(例: "Mbappé")でAPI-Footballの/players/profiles?search=を
//      呼ぶと0件になる。"Mbappe"(アクセント無し)なら正しくヒットする。
//   ② 姓だけの検索(例: "Yamal")だと、同姓の無名選手(このケースでは
//      "Antonio José Casanova Yamal")がヒットしてしまい、目当ての選手
//      (Lamine Yamal)の写真が返らないことがある。フルネーム("Lamine Yamal")で
//      検索すれば正しくヒットする。一方でフルネーム検索を常用すると、逆に
//      "Erling Haaland"のように0件になってしまう選手もいる("Haaland"だけなら
//      ヒットする)ため、姓のみ検索を主、フルネーム検索を補助にする必要がある。
// この2点を実際にapi/standings.js経由ではなく本番エンドポイントへの直接curlで
// 検証した上で、姓のみ検索→(フルネームが分かっていて、結果の名前の頭文字が
// 期待する下の名前の頭文字と一致しない場合のみ)フルネーム検索へフォールバック、
// という二段構えのロジックにした。

// アクセント記号(結合文字)を取り除く。"é"→"e"等。
export function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function fetchProfile(API_KEY, term) {
  const response = await fetch(
    `https://v3.football.api-sports.io/players/profiles?search=${encodeURIComponent(term)}`,
    { headers: { 'x-apisports-key': API_KEY } }
  );
  if (!response.ok) throw new Error(`取得に失敗: ${response.status}`);
  const data = await response.json();
  return data.response?.[0]?.player || null;
}

// search: 姓(または検索語)、fullName: 分かっていればフルネーム(省略可)。
// フルネームが分かっていて、姓検索の結果の名前の頭文字が期待する下の名前の頭文字と
// 一致しない(=同姓の別人を拾った可能性が高い)場合は、フルネームでの再検索を試す。
export async function resolvePlayerProfile(API_KEY, { search, fullName }) {
  const surnameTerm = stripDiacritics(search.trim());
  let profile = await fetchProfile(API_KEY, surnameTerm);

  if (fullName) {
    const fullNameNorm = stripDiacritics(fullName.trim());
    const expectedFirstInitial = fullNameNorm.split(/\s+/)[0]?.[0]?.toLowerCase();
    const gotFirstToken = profile?.name?.trim().split(/\s+/)[0]?.replace(/\./g, '').toLowerCase();
    const mismatch = !profile || (expectedFirstInitial && gotFirstToken && gotFirstToken[0] !== expectedFirstInitial);
    if (mismatch) {
      const fallback = await fetchProfile(API_KEY, fullNameNorm);
      if (fallback) profile = fallback;
    }
  }

  return profile;
}
