const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),cheerio=require('cheerio');
const code=fs.readFileSync('extensions/zlibrary.js','utf8');
const card='<z-bookcard href="/book/abc123/fixture.html" extension="epub" filesize="2 MB" language="English"><div slot="title">Original fixture</div><div slot="author">Fixture author</div><img src="https://images.example/cover.jpg"></z-bookcard>';
const detail='<h1>Original fixture</h1><a href="/author/Fixture">Fixture author</a><a class="dlButton" href="/dl/fresh123">EPUB, 2 MB</a>';
function setup(handler){const requests=[],state={},m={exports:{}};new Function('require','module','exports',code)(id=>id==='cheerio'?cheerio:{fetch:async(url,init)=>{requests.push({url,init});if(new URL(url).pathname.startsWith('/dl/'))throw Error('Unexpected quota-consuming request');return handler(url,init);},storage:{get:k=>state[k],set:(k,v)=>state[k]=v},absolute:(a,b)=>new URL(a,b).href},m,m.exports);return {ext:m.exports,requests,state};}
const response=(value)=>({ok:true,status:200,json:async()=>value,text:async()=>value});
test('domain discovery, search pagination and details never request downloads or persist account state',async()=>{
 const {ext,requests,state}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains')?{domains:[{domain:'z-lib.gd'},{domain:'http://evil.example'},{domain:'bad/path'}]}:url.includes('/book/')?detail:card+'<div class="paginator"><a href="?page=2">2</a></div>'));
 const result=await ext.search({text:'A & B',filters:{format:['epub']}});assert.equal(result.books[0].title,'Original fixture');assert.equal(JSON.parse(result.next).page,2);assert.ok(requests.some(r=>r.url.includes('A%20%26%20B')));
 const d=await ext.details(result.books[0].id);assert.equal(d.files[0].resolve,true);assert.equal(d.files[0].format,'epub');assert.equal(d.files[0].size,2097152);
 const f=await ext.resolveFile(result.books[0].id,'epub');assert.match(f.url,/\/dl\/fresh123$/);assert.equal(requests.filter(r=>r.url.endsWith('/ok')).length,1);assert.notEqual(requests[0].init.credentials,'omit');assert.doesNotMatch(JSON.stringify(state),/evil|bad\/path|fresh123/);
});
test('missing login yields a browser sign-in action and invalid book paths never reach the network',async()=>{
 const {ext,requests}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains')?{domains:[]}: '<h1>Original fixture</h1><a href="/login">Log In</a>'));
 await assert.rejects(ext.details('/book/abc123/fixture.html'),e=>e.type==='authenticationError'&&/\/login$/.test(e.url));
 const before=requests.length;await assert.rejects(ext.details('https://evil.example/'),/Invalid/);assert.equal(requests.length,before);
});
test('unreachable domains fail gracefully and unavailable formats do not produce a download',async()=>{
 const {ext}=setup(()=>{throw Error('offline');});await assert.rejects(ext.search({text:'fixture'}),/No Z-Library domain/);
 const online=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains')?{domains:[]}:detail.replace('EPUB','MOBI'))).ext;
 await assert.rejects(online.details('/book/abc123/fixture.html'),/not an EPUB or PDF/);
});

test('actual extension runtime preserves sign-in errors without receiving passwords or session keys', async () => {
 const vm=require('node:vm');const runtime=fs.readFileSync('../dsreader/assets/vendor/paperback/runtime.pbjs','utf8');
 const messages=[];const context=vm.createContext({URL,URLSearchParams,Response,Request,Headers,TextEncoder,TextDecoder,setTimeout,clearTimeout,cheerio,ReactNativeWebView:{postMessage:s=>messages.push(JSON.parse(s))}});
 vm.runInContext(runtime,context);
 const fixture="module.exports={browse(){return {books:[]}},details(){const e=new Error('Sign in');e.type='authenticationError';e.url='https://fixture.example/login';throw e}}";
 context.__pb.load('load','fixture',fixture,{},'fixture','dsr');await new Promise(r=>setTimeout(r,0));
 context.__pb.invoke('details','fixture','details',['book']);await new Promise(r=>setTimeout(r,0));
 const result=messages.find(m=>m.id==='details');assert.equal(result.ok,false);assert.equal(result.error.type,'authentication');assert.equal(result.error.url,'https://fixture.example/login');
});

test('a healthy API with an unavailable search page fails over without requesting download links',async()=>{
 const {ext,requests}=setup(url=>{
  if(url.endsWith('/ok'))return response({success:1});
  if(url.endsWith('/domains'))return response({domains:[]});
  if(new URL(url).hostname==='z-library.sk')return {ok:false,status:503};
  return response(card);
 });
 const result=await ext.search({text:'fixture'});assert.equal(result.books.length,1);
 assert.deepEqual(requests.filter(r=>new URL(r.url).pathname.startsWith('/s/')).map(r=>new URL(r.url).hostname),['z-library.sk','z-library.ec']);
 await ext.search({text:'another'});
 assert.equal(requests.filter(r=>new URL(r.url).hostname==='z-library.sk'&&new URL(r.url).pathname.startsWith('/s/')).length,1);
});
test('browser challenges stay interactive and are never retried against other domains',async()=>{
 const challenge=Object.assign(new Error('Browser check'),{type:'cloudflareError',resolutionRequest:{url:'https://z-library.sk/'}});
 const {ext,requests}=setup(url=>{
  if(url.endsWith('/ok'))return response({success:1});if(url.endsWith('/domains'))return response({domains:[]});throw challenge;
 });
 await assert.rejects(ext.search({text:'fixture'}),e=>e===challenge);
 assert.equal(requests.filter(r=>new URL(r.url).pathname.startsWith('/s/')).length,1);
});

test('discovery preserves browser checks and reuses native cookies rather than blaming DNS',async()=>{
 const challenge=Object.assign(new Error('Browser check required'),{type:'cloudflareError',resolutionRequest:{url:'https://z-library.ec/'}});
 const {ext,requests}=setup(()=>{throw challenge;});
 await assert.rejects(ext.search({text:'fixture'}),e=>e===challenge);
 assert.ok(requests.every(r=>r.init.credentials!=='omit'));
});
test('HTTP failures in discovery are distinguished from DNS failures',async()=>{
 const {ext}=setup(()=>({ok:false,status:503}));
 await assert.rejects(ext.search({text:'fixture'}),e=>/HTTP 503/.test(e.message)&&!e.message.includes('DNS provider'));
});
test('plain search 503 offers a browser handoff and retries the same domain',async()=>{
 let recovered=false;
 const {ext,requests}=setup(url=>{
  if(url.endsWith('/ok'))return response({success:1});
  if(url.endsWith('/domains'))return response({domains:[]});
  return recovered?response(card):{ok:false,status:503};
 });
 let failure;
 await assert.rejects(ext.search({text:'fixture'}),e=>{failure=e;return e.type==='browserCheckError'&&e.url.includes('/s/fixture?');});
 assert.match(failure.message,/HTTP 503/);
 recovered=true;
 const before=requests.length;
 assert.equal((await ext.search({text:'fixture'})).books.length,1);
 assert.equal(requests[before].url,failure.url);
});
