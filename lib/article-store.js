// lib/article-store.js
//
// 選手紹介記事(player_intro)・試合解説記事(match_report)・移籍速報(transfer_news)の
// 永久保存用ストア。「下書きログに1ファイル追記していく」方式(academy-core.js/
// match-report-core.jsの旧saveDraft())から、記事1本ごとに恒久的なレコードとして
// 保存する方式に変更した。
//
// 【自動削除・自動ローテーションはしない(重要・2026-07-31明記)】
// このストアはtypeに関わらず、保存した記事を自動的に削除・ローテーションする仕組みを
// 一切持たない。移籍速報(transfer_news)についても、特集タブ上部のセクションでは
// 表示件数を絞る(direct最新5件+「さらに表示」)UI上の制御をしているだけで、
// データ自体(articles/index.json・articles/{id}.json)は恒久的に保持され続ける。
// 全件は一覧・詳細API(api/articles.js)およびページネーション付きの専用アーカイブ
// ページから引き続き閲覧できる。
//
// 【保存構成】Vercel Blob(プライベートストア、このリポジトリの既存パターンを踏襲)。
//   - articles/index.json : 一覧・ページネーション用の軽量メタデータ配列(新着順)。
//     フル本文は含まない(一覧表示のたびに全記事の本文を読み込まずに済むようにするため)。
//   - articles/{id}.json  : 記事1本ごとの完全なレコード(本文・出典含む)。
// 個別ファイル+インデックスファイルの2層構成にすることで、一覧取得はindex.jsonだけを
// 読めば済み、個別記事の取得もid直読みで済む(全件を読んでからフィルタする必要がない)。
//
// 【レコードの形】
// {
//   id: string,              // スラッグ。例: '2026-05-03-manchester-united-vs-liverpool'
//   type: 'player_intro' | 'match_report' | 'transfer_news',
//   title: string,
//   publishedAt: string,     // ISO8601
//   body: string,             // Markdown本文
//   hasScoreTable: boolean,  // match_reportの場合、採点表つきフル版かどうか
//   sources: Array<{ title: string|null, url: string }>,
//   status: 'draft' | 'published', // 現状は自動公開しないため、常にdraftで保存される
// }

import { put, get } from '@vercel/blob';

const INDEX_PATHNAME = 'articles/index.json';

function articlePathname(id) {
  return `articles/${id}.json`;
}

// タイトル・日付等から、URLやファイル名に使えるスラッグを生成する。
// 英数字以外はハイフンに置き換え、連続ハイフン・前後のハイフンを整理する。
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // アクセント記号除去(é→e等)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function loadIndex() {
  try {
    const result = await get(INDEX_PATHNAME, { access: 'private', useCache: false });
    if (!result || !result.stream) return [];
    const text = await new Response(result.stream).text();
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('article index load error:', err.message);
    return [];
  }
}

async function saveIndex(index) {
  await put(INDEX_PATHNAME, JSON.stringify(index), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

function tokyoDateKey(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return String(value || '').slice(0, 10) || null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// 記事1本を保存する(新規作成/上書き更新の両方に対応、idが既存なら上書き)。
export async function saveArticle(article) {
  if (!article.id) throw new Error('article.id is required');

  await put(articlePathname(article.id), JSON.stringify(article), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });

  const index = await loadIndex();
  const meta = {
    id: article.id,
    type: article.type,
    title: article.title,
    publishedAt: article.publishedAt,
    hasScoreTable: article.hasScoreTable ?? null,
    isHereWeGo: article.isHereWeGo ?? null,
    status: article.status,
    // `public:false` is used for a source article that was moved back to
    // "要確認" in Notion. Older records do not have this field and remain public.
    public: article.public !== false,
    deck: article.deck ?? null,
    summary: article.summary ?? null,
    contentKind: article.contentKind ?? null,
    match: article.match ?? null,
    prediction: article.prediction ?? null,
    story: article.story ?? null,
    notion: article.notion ?? null,
    // subject: 記事の対象(player_introなら選手名)。既存記事の重複生成を避けるための
    // 検索キーとして使う(findArticleBySubject参照)。長文記事の本文は一覧に含めないが、
    // subjectは短い文字列のため常に含めてよい。
    subject: article.subject ?? null,
    // club: player_introの対象選手の所属クラブ。見出しがキャッチコピー形式になり選手名・
    // クラブ名を含まなくなったため、一覧カード・詳細ページのサブ情報として表示する用。
    club: article.club ?? null,
    // scoreboard: match_reportのスコアボード表示用(クラブ名・ロゴ・スコア・節数)。
    // 一覧カードでも個別取得なしに表示できるよう軽量メタデータに含める。
    scoreboard: article.scoreboard ?? null,
    // relatedArticleId: 相互リンク先の記事ID(例: Here we go速報 ⇔ 選手紹介記事)。
    relatedArticleId: article.relatedArticleId ?? null,
    // transfer: 移籍速報(transfer_news)の構造化データ(選手名・移籍元/先クラブ名・
    // 解決済みAPI-FootballチームID)。2026-08-04追加。一覧カードのサムネイル画像
    // (選手写真+クラブロゴ)をAPI個別取得なしで組み立てられるよう、軽量メタデータにも
    // 含める(scoreboardと同じ理由)。
    transfer: article.transfer ?? null,
    // player: player_introの対象選手の構造化データ(playerId・年齢・国籍・所属クラブ
    // ID等)。2026-08-04追加。一覧カードのサムネイル画像(選手写真+クラブロゴ+国籍の
    // 国旗)をAPI個別取得なしで組み立てられるよう、軽量メタデータにも含める
    // (scoreboard/transferと同じ理由)。
    player: article.player ?? null,
    // 短文(移籍速報など、300字以下)の場合のみ一覧メタデータにも本文・出典を含める。
    // 一覧取得だけで表示が完結できるようにするため(試合解説・選手紹介のような
    // 長文記事は個別取得(?id=)側でのみ本文を返す設計を維持し、index.jsonの肥大化を防ぐ)。
    ...(article.body && article.body.length <= 300
      ? { body: article.body, sources: article.sources || [] }
      : {}),
  };
  const filtered = index.filter(e => e.id !== article.id);
  filtered.push(meta);
  filtered.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  await saveIndex(filtered);

  return article;
}

export async function getArticle(id, { includeHidden = false } = {}) {
  try {
    const result = await get(articlePathname(id), { access: 'private', useCache: false });
    if (!result || !result.stream) return null;
    const text = await new Response(result.stream).text();
    const article = JSON.parse(text);
    if (!includeHidden && article.public === false) return null;
    return article;
  } catch (err) {
    console.error(`article load error (${id}):`, err.message);
    return null;
  }
}

// 指定typeの記事の中から、subject(大文字小文字を無視)が一致するものを探す。
// 「同一選手について既に記事があれば新規生成せず更新する」判定に使う
// (index.jsonの軽量メタデータだけで判定でき、全記事の本文を読みに行く必要はない)。
export async function findArticleBySubject(type, subject) {
  const index = await loadIndex();
  const normalized = String(subject || '').trim().toLowerCase();
  if (!normalized) return null;
  return index.find(e => e.type === type && String(e.subject || '').trim().toLowerCase() === normalized) || null;
}

// 一覧・ページネーション用。typeを指定すると絞り込み、指定しなければ全種別混合。
export async function listArticles({ type, matchDate, page = 1, pageSize = 10, includeHidden = false } = {}) {
  const index = await loadIndex();
  const visible = includeHidden ? index : index.filter((entry) => entry.public !== false);
  const requestedMatchDate = matchDate ? tokyoDateKey(matchDate) : null;
  const filtered = visible.filter((entry) => (
    (!type || entry.type === type)
    && (!requestedMatchDate || tokyoDateKey(entry.match?.date) === requestedMatchDate)
  ));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  return { items, page: safePage, pageSize, total, totalPages };
}
