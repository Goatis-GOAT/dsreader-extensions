const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),cheerio=require('cheerio');
const code=fs.readFileSync('extensions/zlibrary.js','utf8');
const card='<z-bookcard href="/book/abc123/fixture.html" extension="epub" filesize="2 MB" language="English"><div slot="title">Original fixture</div><div slot="author">Fixture author</div><img src="https://images.example/cover.jpg"></z-bookcard>';
const detail='<h1>Original fixture</h1><a href="/author/Fixture">Fixture author</a><a class="dlButton" href="/dl/fresh123">EPUB, 2 MB</a>';
function setup(handler){const requests=[],state={},m={exports:{}};new Function('require','module','exports',code)(id=>id==='cheerio'?cheerio:{fetch:async(url,init)=>{requests.push({url,init});if(new URL(url).pathname.startsWith('/dl/'))throw Error('Unexpected quota-consuming request');return handler(url,init);},storage:{get:k=>state[k],set:(k,v)=>state[k]=v},absolute:(a,b)=>new URL(a,b).href},m,m.exports);return {ext:m.exports,requests,state};}
const response=(value)=>({ok:true,status:200,json:async()=>value,text:async()=>value});
test('domain discovery, search pagination and details never request downloads or persist account state',async()=>{
 const {ext,requests,state}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[{domain:'z-lib.gd'},{domain:'http://evil.example'},{domain:'bad/path'}]}:url.includes('/book/')?detail:card+'<div class="paginator"><a href="?page=2">2</a></div>'));
 const result=await ext.search({text:'A & B',filters:{format:['epub']}});assert.equal(result.books[0].title,'Original fixture');assert.equal(JSON.parse(result.next).page,2);assert.ok(requests.some(r=>r.url.includes('A%20%26%20B')));
 const d=await ext.details(result.books[0].id);assert.equal(d.files[0].resolve,true);assert.equal(d.files[0].format,'epub');assert.equal(d.files[0].size,2097152);
 const f=await ext.resolveFile(result.books[0].id,'epub');assert.match(f.url,/\/dl\/fresh123$/);assert.equal(requests.filter(r=>r.url.endsWith('/ok')).length,1);assert.notEqual(requests[0].init.credentials,'omit');assert.doesNotMatch(JSON.stringify(state),/evil|bad\/path|fresh123/);
});
test('missing login yields a browser sign-in action and invalid book paths never reach the network',async()=>{
 const {ext,requests}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[]}: '<h1>Original fixture</h1><a href="/login">Log In</a>'));
 await assert.rejects(ext.details('/book/abc123/fixture.html'),e=>e.type==='authenticationError'&&/\/login$/.test(e.url));
 const before=requests.length;await assert.rejects(ext.details('https://evil.example/'),/Invalid/);assert.equal(requests.length,before);
});
test('unreachable domains fail gracefully and unavailable formats do not produce a download',async()=>{
 const {ext}=setup(()=>{throw Error('offline');});await assert.rejects(ext.search({text:'fixture'}),e=>/could not establish a connection/.test(e.message)&&!e.type);
 const online=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[]}:detail.replace('EPUB','MOBI'))).ext;
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
  if(url.endsWith('/domains/singlelogin'))return response({success:1,domains:[]});
  if(new URL(url).hostname==='en.z-lib.bz')return {ok:false,status:503};
  return response(card);
 });
 const result=await ext.search({text:'fixture'});assert.equal(result.books.length,1);
 assert.deepEqual(requests.filter(r=>new URL(r.url).pathname.startsWith('/s/')).map(r=>new URL(r.url).hostname),['en.z-lib.bz','z-lib.sk']);
 await ext.search({text:'another'});
 assert.equal(requests.filter(r=>new URL(r.url).hostname==='en.z-lib.bz'&&new URL(r.url).pathname.startsWith('/s/')).length,1);
});
test('browser challenges stay interactive and are never retried against other domains',async()=>{
 const challenge=Object.assign(new Error('Browser check'),{type:'cloudflareError',resolutionRequest:{url:'https://z-library.sk/'}});
 const {ext,requests}=setup(url=>{
  if(url.endsWith('/ok'))return response({success:1});if(url.endsWith('/domains/singlelogin'))return response({success:1,domains:[]});throw challenge;
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
test('plain search 503 never claims verification is required',async()=>{
 let recovered=false;
 const {ext,requests}=setup(url=>{
  if(url.endsWith('/ok'))return response({success:1});
  if(url.endsWith('/domains/singlelogin'))return response({success:1,domains:[]});
  return recovered?response(card):{ok:false,status:503};
 });
 let failure;
 await assert.rejects(ext.search({text:'fixture'}),e=>{failure=e;return !e.type;});
 assert.match(failure.message,/HTTP 503/);
 recovered=true;
 const before=requests.length;
 assert.equal((await ext.search({text:'fixture'})).books.length,1);
 assert.equal(requests[before].url,requests[before-1].url);
});
test('failed health checks do not block a working content page or ask for verification',async()=>{
 const {ext,requests}=setup(url=>new URL(url).pathname.startsWith('/s/')?response(card):{ok:false,status:503});
 assert.equal((await ext.search({text:'Austen'})).books.length,1);
 const address=requests.at(-1).url;
 assert.equal(new URL(address).hostname,'en.z-lib.bz');
 assert.equal(new URL(address).pathname,'/s/Austen');
 const before=requests.length;
 assert.equal((await ext.search({text:'Austen'})).books.length,1);
 assert.equal(requests[before].url,address);
 assert.equal(requests.length,before+1);
});
test('health endpoint challenges open content instead of an unreadable JSON browser page',async()=>{
 const challenge=Object.assign(new Error('Browser check'),{type:'cloudflareError',resolutionRequest:{url:'https://z-library.ec/eapi/info/ok'}});
 const {ext}=setup(()=>{throw challenge;});
 await assert.rejects(ext.search({text:'Austen'}),e=>e===challenge&&new URL(e.resolutionRequest.url).pathname==='/s/Austen');
});
test('homepage recommendations and profile allowance load without consuming downloads', async()=>{
 const mosaic='<z-masonry><a href="/book/abc123/fixture.html"><img alt="Fixture author — Original fixture" src="https://images.example/fixture.jpg"></a><a href="/book/abc123/fixture.html"><img alt="Duplicate" src="https://images.example/fixture.jpg"></a></z-masonry>';
 const quota='<div class="caret-scroll__tile"><div class="caret-scroll__title">3 / 25</div><div class="caret-scroll__desc">Daily limit</div></div>';
 const {ext,requests}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[]}:mosaic+quota));
 const [books,account]=await Promise.all([ext.browse('popular'),ext.accountStatus()]);
 assert.equal(books.books.length,1);assert.equal(books.books[0].title,'Original fixture');assert.equal(books.books[0].author,'Fixture author');assert.match(books.books[0].cover,/fixture.jpg/);
 assert.deepEqual(account,{provider:'zlibrary',signedIn:true,used:3,limit:25,remaining:22,signInUrl:'https://en.z-lib.bz/login'});
 assert.equal(requests.filter(r=>new URL(r.url).pathname==='/').length,1);
 assert.equal(requests.filter(r=>new URL(r.url).pathname==='/profile').length,1);
});
test('missing account allowance stays unknown, while expired login reports sign-in without credentials',async()=>{
 const guest=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[]}:card+'<a href="/login">Sign in</a>')).ext;
 const status=await guest.accountStatus();assert.equal(status.signedIn,false);assert.equal(status.remaining,undefined);
 const unknown=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[]}:card)).ext;
 assert.equal((await unknown.accountStatus()).remaining,undefined);
});
test('desktop pool prefers its active host and refreshes through singlelogin without Tor or article fallbacks',async()=>{
 const {ext,requests,state}=setup(url=>response(url.endsWith('/ok')?{success:1}:url.endsWith('/domains/singlelogin')?{success:1,domains:[{domain:'new-books.example'},{domain:'unsafe.onion'},{domain:'articles.sk'},{domain:'http://bad.example'},{domain:'https://user:secret@bad.example'}]}:card));
 await ext.search({text:'fixture'});
 assert.equal(new URL(requests[0].url).hostname,'en.z-lib.bz');
 assert.ok(requests.some(r=>r.url.endsWith('/eapi/info/domains/singlelogin')&&r.init.credentials==='omit'));
 const cached=state['zlibrary.domains.desktop.v2'];
 assert.equal(cached.last,'https://en.z-lib.bz');
 assert.ok(cached.domains.includes('https://new-books.example'));
 assert.ok(cached.domains.includes('https://z-library.im'));
 assert.doesNotMatch(JSON.stringify(cached),/onion|articles\.sk|bad\.example|secret/);
});
