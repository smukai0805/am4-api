// api/player-photo.js
// Vercelのサーバーレス関数(Node.js)。
//
// 選手の顔写真URLだけを、名前(姓)から1回のAPI-Football呼び出しで取得する軽量
// エンドポイント。api/player-stats.jsは成績まで含めて1人あたり最大6回のAPI-Football
// リクエスト(プロフィール1回+SEASONS分の成績照会)を行うため、選手一覧・スカッド
// 作成画面のように多数の選手の写真だけをまとめて取得したい場面でそれを使うと、
// レート制限にすぐ達してしまう。
//
// 【2026-08-01発見】football-hub.html側のgetPlayerPhoto()は当初からこのエンドポイントを
// 呼び出す実装になっていたが、このファイル自体がリポジトリに存在しておらず、
// 常に404で失敗し顔写真が一切表示されない状態になっていた(スカッド作成に限らず、
// 選手検索結果等avatarHtml()を使う箇所すべてに影響していた)。今回追加して解消した。
//
// 例: /api/player-photo?search=Haaland
// fullNameを渡すと、姓だけの検索が同姓の別人に当たった場合にフルネームでの再検索へ
// フォールバックする(lib/name-search.js参照。例: search=Mbappé&fullName=Kylian Mbappé)。

import { resolvePlayerProfile } from '../lib/name-search.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const { search, fullName } = req.query;

  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY が設定されていません' });
  }
  if (!search || search.trim().length < 3) {
    return res.status(400).json({ error: 'search パラメータ(選手の姓、3文字以上)が必要です' });
  }

  try {
    const profile = await resolvePlayerProfile(API_KEY, { search, fullName });

    // 写真は選手ごとに滅多に変わらないため、長め(1日)にキャッシュしてAPI-Football側の
    // 呼び出し回数を抑える。
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ photo: profile?.photo || null, name: profile?.name || null });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: '取得に失敗しました', detail: err.message });
  }
}
