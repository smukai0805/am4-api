const test = require('node:test');
const assert = require('node:assert/strict');
const {selectedMotm} = require('../match-report-presentation');

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
