import test from 'node:test';
import assert from 'node:assert/strict';
import {predictTeam,playerStats,createCachedReader,getLineupInsights} from '../lib/lineup-insights.js';
import display from '../player-display.js';
import formation from '../formation-layout.js';

test('ID registry preserves compound names, aliases, full names and duplicate surnames',()=>{
 const people=[{id:1,name:'Alexis Mac Allister'},{id:2,name:'Alexander Isak'},{id:3,name:'Vinícius José Paixão de Oliveira Júnior'},{id:4,name:'Lucas Hernández'},{id:5,name:'Theo Hernández'},{id:6,name:'Jean Pierre de la Roche'}];
 const r=display.createRegistry(people);
 assert.deepEqual(people.map(p=>r.name(p)),['Mac Allister','Isak','Vinícius Jr.','L. Hernández','T. Hernández','Jean Pierre de la Roche']);
 assert.equal(r.full({id:1}),'Alexis Mac Allister');assert.equal(people[1].name,'Alexander Isak');
});
test('grid follows provider coordinates, reverses away orientation and keeps missing positions separate',()=>{
 for(const f of [[4,3,3],[4,2,3,1],[3,5,2]]){
 const xi=[1,...f].flatMap((n,row)=>Array.from({length:n},(_,i)=>({id:row*10+i,grid:`${row+1}:${i+1}`})));
 const l=formation.rows({startXI:xi.reverse()});assert.deepEqual(l.rows.map(r=>r.players.length),[1,...f]);
 assert.deepEqual(formation.rows({startXI:xi},true).rows.map(r=>r.players.length),[...f].reverse().concat(1));
 assert.equal(l.unplaced.length,0);
 }
 assert.equal(formation.rows({startXI:[{grid:null},{grid:'1:1'},{grid:'1:1'}]}).unplaced.length,2);
});
test('events do not count own goals, missed penalties or substitutions as goals/assists',()=>{
 const events=[{type:'goal',player:{id:1},assist:{id:2}},{type:'own_goal',player:{id:1},assist:{id:2}},{type:'penalty_missed',player:{id:1}},{type:'substitution',player:{id:1},assist:{id:3},minute:"70'"}];
 assert.equal(formation.contributions(1,events).goals,1);assert.equal(formation.contributions(2,events).assists,1);assert.equal(formation.contributions(1,events).changes[0].direction,'OUT');assert.equal(formation.contributions(3,events).changes[0].direction,'IN');
});
test('prediction excludes confirmed missing and departed players while disclosing incomplete evidence',()=>{
 const team={id:42,name:'Test'}, lineup={formation:'4-3-3',startXI:[{player:{id:1,name:'A',pos:'M',grid:'3:1'}},{player:{id:2,name:'B',pos:'M',grid:'3:2'}}],substitutes:[{player:{id:3,name:'C',pos:'M'}}]};
 const p=predictTeam({team,histories:[{id:1,date:'2026-09-01',lineup}],squad:[{team,players:[{id:1},{id:3}]}],injuries:[{team,player:{id:1,type:'Missing Fixture',reason:'Suspended'}}],kickoff:'2026-09-06',updatedAt:'2026-09-05'});
 assert.deepEqual(p.startXI.map(p=>p.id),[3]);assert.equal(p.startXI[0].grid,'3:1');assert.equal(p.predicted,true);assert.equal(p.evidence.suspensionVerification,'provider-fixture-only');
 const partial=predictTeam({team,histories:[{id:1,date:'2026-09-01',lineup}],squad:null,injuries:null,kickoff:'2026-09-06'});assert.equal(partial.startXI.length,2);assert.equal(partial.evidence.roster,'unavailable');assert.equal(partial.evidence.injuries,'unavailable');
});
test('missing or invalid rating stays null, never an invented zero',()=>{
 assert.equal(playerStats([{players:[{player:{id:1},statistics:[{games:{rating:null}}]}]}])[0].rating,null);
 assert.equal(playerStats([{players:[{player:{id:1},statistics:[{games:{rating:'7.4'}}]}]}])[0].rating,7.4);
});
test('provider cache coalesces simultaneous reads and retries failed sections',async()=>{
 let calls=0;const reader=createCachedReader(async()=>{calls++;return {response:[]};},new Map());await Promise.all([reader('/x',{}),reader('/x',{})]);assert.equal(calls,1);
 let retries=0;const failing=createCachedReader(async()=>{retries++;return {errors:{coverage:'missing'},response:[]};},new Map());await assert.rejects(failing('/x',{}));await assert.rejects(failing('/x',{}));assert.equal(retries,2);
});
test('official XI replaces predictions without reading histories or injuries',async()=>{
 const teams=[{id:1},{id:2}];const calls=[];
 const data=await getLineupInsights({id:123,status:'NS',home:teams[0],away:teams[1]},async(path)=>{calls.push(path);return teams.map(team=>({team,startXI:Array.from({length:11},(_,i)=>({player:{id:i+1}}))}));});
 assert.deepEqual(calls,['/fixtures/lineups']);assert.equal(data.lineups.length,2);assert.ok(data.lineups.every(l=>l.predicted===false));
});
test('prediction retains left/right/central grids for selected returning starters',()=>{
 const team={id:1}, lineup={formation:'4-3-3',startXI:[{player:{id:90,name:'Left',pos:'D',grid:'2:1'}},{player:{id:3,name:'Centre',pos:'D',grid:'2:2'}},{player:{id:40,name:'Right',pos:'D',grid:'2:3'}}]};
 const p=predictTeam({team,histories:[{id:1,date:'2026-09-01',lineup}],squad:null,injuries:null,kickoff:'2026-09-06'});
 assert.deepEqual(p.startXI.map(p=>[p.id,p.grid]),[[90,'2:1'],[3,'2:2'],[40,'2:3']]);
});
test('optional player statistics failures are explicit and do not discard official XI',async()=>{
 const d=await getLineupInsights({id:1,status:'FT'},async path=>{if(path==='/fixtures/players')throw Error('quota');return [{team:{id:1},startXI:Array.from({length:11},(_,i)=>({player:{id:i+1}}))}];});
 assert.equal(d.errors.players,true);assert.equal(d.players,null);assert.equal(d.lineups.length,1);
 const empty=await getLineupInsights({id:1,status:'FT'},async()=>[]);assert.equal(empty.errors.players,false);assert.deepEqual(empty.players,[]);
});
