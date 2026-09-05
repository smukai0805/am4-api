import { defineConfig } from 'vite';
import { detail, insights } from './tests/ui/fixtures.mjs';
export default defineConfig({
 server:{host:'0.0.0.0',allowedHosts:['terminal.local'],proxy:{'/api':{target:'https://am4-api.vercel.app',changeOrigin:true}}},
 plugins:[{name:'am4-local-routes',configureServer(server){server.middlewares.use((req,res,next)=>{
  const url=new URL(req.url,'http://local');
  if(url.pathname==='/column/20-seasons')req.url='/column-20-seasons.html';
  const id=Number(url.searchParams.get('detail') || url.searchParams.get('liveDetail') || url.searchParams.get('lineupInsights') || url.searchParams.get('fixtureId'));
  if(id>=900001&&id<=900005&&url.pathname.startsWith('/api/')){
   const data=url.pathname==='/api/articles'?{prediction:null,report:null,errors:{}}:url.searchParams.has('lineupInsights')?insights(id):detail(id);
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
  }
  next();
 });}}]
});
