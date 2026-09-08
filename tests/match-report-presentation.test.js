const test = require('node:test');
const assert = require('node:assert/strict');
const {selectedMotm,hasAwardStatement,editorialAm4Motm,dataAm4Motm,withoutMotmAbstention} = require('../match-report-presentation');

test('explicit editorial MOTM resolves accents and abbreviated fixture names to the provider ID', () => {
  const value = 'Man of the Match：Martin Ødegaard（Sports Mole選出）。決勝点に加えて4度のチャンス創出。Havertzも活躍。';
  const winner = selectedMotm(value, [{id:37127,name:'M. Odegaard'}, {player:{id:37127,name:'M. Odegaard'}}, {id:2,name:'K. Havertz'}]);
  assert.equal(winner.name, 'Martin Ødegaard');
  assert.equal(winner.player.id, 37127);
  assert.match(value, /Sports Mole選出/);
});

test('missing and ambiguous identities keep the editorial name without inventing a portrait', () => {
  assert.equal(selectedMotm('MOTM：Martin Ødegaard（AM4選出）', []).player, null);
  assert.equal(selectedMotm('MOTM：Martin Ødegaard', [{id:1,name:'M. Odegaard'},{id:2,name:'M. Odegaard'}]).player, null);
  assert.equal(selectedMotm('MOTM：Martin Ødegaard', [{id:1,name:'Marcus Odegaard'}]).player, null);
  assert.equal(selectedMotm('MOTM：Martin Ødegaard', [{id:'invalid',name:'Martin Ødegaard'}]).player, null);
});

test('ordinary analysis, absence of a selection and unsafe text cannot become an award', () => {
  for (const value of ['Havertzが活躍。MOTM候補だった。','MOTM：未確認','MOTM：該当なし','MOTM：Not announced','MOTM：未発表のためMartin Ødegaard','MOTM：<img src=x onerror=alert(1)>','']) {
    assert.equal(selectedMotm(value), null, value);
  }
});

test('media prefixes, later paragraphs and explicit AM4 selections are recognized without inventing an award', () => {
  assert.equal(selectedMotm('Sofascore Player of the Match：Tyrick Mitchell（8.7）。2得点。').name,'Tyrick Mitchell');
  assert.equal(selectedMotm('Samardžićが決勝点。\n\nSofascore Player of the Match：Marco Carnesecchi（8.3）。3セーブ。').name,'Marco Carnesecchi');
  assert.equal(selectedMotm('AM4 MOTM：Cole Palmer。1得点1アシスト。').authority,'AM4');
  assert.equal(selectedMotm('MOTM：Cole Palmer。1得点1アシスト。').authority,'AM4');
  assert.equal(selectedMotm('公式の発表は未確認。AM4 MOTM：Cole Palmer。1得点1アシスト。').name,'Cole Palmer');
  assert.equal(selectedMotm('Antonio Sivera（Alavés）：Sofascoreの試合記事ではMVPとして扱われ、6セーブ。').name,'Antonio Sivera');
  assert.equal(selectedMotm('MOTM：Player One\nMOTM：Player Two'),null);
  assert.equal(hasAwardStatement('MOTM：Player One\nMOTM：Player Two'),true);
  assert.equal(hasAwardStatement('公式MOTM/POTM：確認できず。推測では設定しない。'),false);
  assert.equal(selectedMotm('最高評価はPlayer One。'),null);
});

test('reviewed AM4 choices are exact-article-scoped and yield to a later explicit award', () => {
  const id='notion-match_report-3d4b49a367ef8168af08e431e12b12e9';
  const choice=editorialAm4Motm(id,'Carl Starfeltが同点ゴール。',[{id:7,name:'C. Starfelt'}]);
  assert.equal(choice.name,'Carl Starfelt');assert.equal(choice.player.id,7);assert.equal(choice.authority,'AM4');
  assert.equal(editorialAm4Motm('another-match','Carl Starfeltが同点ゴール。'),null);
  assert.equal(editorialAm4Motm(id,'MOTM：Martín Satriano'),null);
  assert.equal(editorialAm4Motm(id,'Satrianoは公式MOTMに選出。'),null);
});

const finished={status:'FT',home:{id:1},away:{id:2}};
const players=Array.from({length:22},(_,i)=>({id:i+1,teamId:i<11?1:2,name:`Player ${String.fromCharCode(65+i)}`,minutes:90,rating:i===15?8.4:6.1,goals:0,assists:0}));

test('AM4 data selection evaluates both teams and cannot override editorial awards', () => {
  const chosen=dataAm4Motm(finished,players);
  assert.equal(chosen.player.id,16);assert.equal(chosen.authority,'AM4');assert.equal(chosen.basis,'data');
  assert.match(chosen.reason,/8\.4/);
  assert.equal(dataAm4Motm(finished,players,'MOTM：Player A'),null);
  assert.equal(dataAm4Motm({...finished,status:'2H'},players),null);
  assert.equal(dataAm4Motm({...finished,status:'NS'},players),null);
  assert.equal(dataAm4Motm(finished,players.slice(0,11)),null);
  assert.equal(dataAm4Motm(finished,players.map(p=>({...p,rating:null}))),null);
  assert.equal(dataAm4Motm(finished,players.map(p=>({...p,minutes:0}))),null);
});

test('equal ratings use contributions then minutes, with no arbitrary identity tiebreak', () => {
  const tied=players.map(p=>({...p,rating:7}));
  assert.equal(dataAm4Motm(finished,tied),null);
  tied[0].assists=1;
  assert.equal(dataAm4Motm(finished,tied).player.id,1);
  tied[1].goals=1;tied[1].minutes=95;
  assert.equal(dataAm4Motm(finished,tied).player.id,2);
  assert.equal(players[0].rating,6.1);
});

test('obsolete abstention is removed only for display while adjacent analysis survives', () => {
  for(const prefix of ['公式・大会選出のMOTM／POTMは確認できず、推測では設定しない。','公式MOTM/POTM：確認できず。推測では設定しない。','公式MOTM／POTMは確認できなかったため記載しない。','この試合で公式MOTM／POTMとして統一して確認できる選出は見つからなかったため、AM4独自のMOTMは設定しない。']) {
    assert.equal(withoutMotmAbstention(prefix+'最大の活躍はOchieng。1得点2アシスト。'),'最大の活躍はOchieng。1得点2アシスト。');
  }
  assert.equal(withoutMotmAbstention('Player OneはMOTMに選出。決勝点を記録。'),'Player OneはMOTMに選出。決勝点を記録。');
  assert.equal(withoutMotmAbstention('Lamine Yamalは2得点。公式MOTM/POTMとして統一確認できる一次情報は見つからないため、独自MOTM選出は行わない。Raphinhaも2得点。'),'Lamine Yamalは2得点。Raphinhaも2得点。');
});
