import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=fs.readFileSync(path.join(root,'match-detail.js'),'utf8');
const css=fs.readFileSync(path.join(root,'brand.css'),'utf8');

test('member details switch between home and away without repeating the starting XI',()=>{
 const card=source.slice(source.indexOf('function lineupCard'),source.indexOf('function renderLineups'));
 assert.doesNotMatch(card,/startXI|Starting XI|スターティングXI/);
 assert.match(card,/node\\('section','lineup-details'\\)/);\n assert.doesNotMatch(card,/node\\('details','lineup-details'\\)|node\\('summary'/);\n assert.match(source,/lineup-team-switch/);
 assert.match(source,/aria-selected/);
 assert.match(source,/ArrowLeft.*ArrowRight.*Home.*End/);
 assert.match(source,/aria-labelledby/);
 assert.match(source,/控え選手と監督|Substitutes and coach/);
 assert.match(source,/layout\.unplaced\.forEach\(player=>list\.append\(playerRow\(player\)\)\)/);
});

test('substitutes and coaches have portrait treatment with a resilient fallback',()=>{
 assert.match(source,/lineup-member-photo/);
 assert.match(source,/football\/\$\{kind\}\/\$\{person\.id\}\.png/);
 assert.match(source,/memberPhoto\(lineup\.coach, "coachs"\)/);
 assert.match(css,/\.lineup-member-photo/);
});
