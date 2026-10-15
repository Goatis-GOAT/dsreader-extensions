const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cheerio = require('cheerio');
const script = fs.readFileSync(path.join(__dirname, '../extensions/globalgrey.js'), 'utf8');
const SITE = 'https://www.globalgreyebooks.com';
const card = (id = '/example-ebook.html', title = 'Example &amp; Book') => `<article class="book-card"><a class="book-cover" href="${id}"><img src="/content/book-covers/author_example.jpg"></a><div class="book-meta"><h2 class="book-title"><a href="${id}">${title}</a></h2><p class="book-author">Original Author</p></div></article>`;
const book = (title = 'Original Book', extra = '') => `<html><head><meta name="dc.title" content="${title}"><meta name="dc.creator" content="Original Author"><meta property="og:image" content="/content/book-covers/author_example-large.jpg"><script type="application/ld+json">{"@type":"Book","inLanguage":"en","datePublished":"1901","genre":["Fiction"]}</script></head><body><main><h1>${title}</h1><p class="book-byline"><a href="/original-author-books.html">Original Author</a></p><div class="book-body"><div class="prose"><p>A fixture description.</p></div></div><div class="download-group"><a href="/ebooks/author_example.pdf">PDF</a><a href="/ebooks/author_example.epub">EPUB</a><a href="/ebooks/author_example.azw3">Kindle</a>${extra}</div></main></body></html>`;
const sitemap = paths => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<url><loc>${SITE}${p}</loc></url>`).join('')}</urlset>`;
function setup(handler, state = {}) {
  const requests = [];
  const dsreader = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      const result = await handler(new URL(url).pathname, init);
      return typeof result === 'string' ? { ok: true, status: 200, url, text: async () => result } : result;
    },
    storage: { get: k => state[k], set: (k, v) => { state[k] = v; } },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', script)(name => name === 'cheerio' ? cheerio : name === 'dsreader' ? dsreader : assert.fail(`Unexpected module ${name}`), module, module.exports);
  return { extension: module.exports, requests, state };
}
test('browsing extracts actual cards, omits navigation and duplicates, and follows only the next category page', async () => {
  const { extension, requests } = setup(() => `<main><h1>Fiction</h1>${card()}${card()}${card('https://evil.example/evil-ebook.html')}<nav><a class="page-link" href="/category/ebooks/fiction-page-25.html">25</a><a class="page-link" href="/category/ebooks/fiction-page-2.html">Next</a><a class="page-link" href="https://evil.example/category/ebooks/fiction-page-2.html">Next</a></nav></main>`);
  const result = await extension.browse('/category/ebooks/fiction-page-1.html');
  assert.equal(result.books.length, 1); assert.equal(result.books[0].title, 'Example & Book');
  assert.equal(result.books[0].cover, SITE + '/content/book-covers/author_example.jpg');
  assert.equal(result.next, '/category/ebooks/fiction-page-2.html');
  assert.equal(requests.length, 1);
});
test('root, categories and author directories expose browseable folders, including authors with one book', async () => {
  const { extension } = setup(() => `<main><h1>Categories</h1><article class="cat-card"><h2 class="cat-name">Fiction</h2><div class="cat-links"><a href="/category/ebooks/fiction-page-1.html">All</a><a href="/category/ebooks/fiction-general-page-1.html">General</a></div></article><ul class="author-list"><li><a href="/example-ebook.html">An Author</a></li><li><a href="javascript:alert(1)">Unsafe</a></li></ul></main>`);
  const root = await extension.browse(null); assert.equal(root.folders[0].title, 'Browse categories');
  const categories = await extension.browse('/ebook-categories.html');
  assert.deepEqual(categories.folders.map(f => f.title), ['Fiction', 'Fiction · General', 'An Author']);
});
test('details preserve bibliographic metadata and offer only validated EPUB/PDF files in preferred order', async () => {
  const { extension, requests } = setup(() => book('A Real Title', '<a href="https://evil.example/ebooks/private.epub">Bad</a><a href="javascript:alert(1)">Bad</a><a href="/ebooks/author_example.epub">Duplicate</a>'));
  const result = await extension.details('/book-page/example-ebook.html');
  assert.equal(result.title, 'A Real Title'); assert.equal(result.author, 'Original Author');
  assert.equal(result.description, 'A fixture description.'); assert.equal(result.published, '1901');
  assert.deepEqual(result.tags, ['Fiction']);
  assert.deepEqual(result.files.map(f => f.format), ['epub', 'pdf']);
  assert.ok(result.files.every(f => new URL(f.url).origin === SITE));
  assert.equal(result.related[0].path, '/original-author-books.html');
  await extension.details('/book-page/example-ebook.html'); assert.equal(requests.length, 1);
  assert.ok(requests.every(r => !r.url.includes('/ebooks/')));
});
test('search uses the sitemap and real book metadata, supports author hints, and caches the index', async () => {
  const { extension, requests, state } = setup(p => p === '/sitemap.xml'
    ? sitemap(['/book-page/example-ebook.html', '/online-books-2/original-author_example_complete-text.html', '/example-ebook.html', '/unrelated-ebook.html'])
    : book('Actual Example Title'));
  const result = await extension.search({ text: 'Original Author' });
  assert.equal(result.books.length, 2); assert.equal(result.books[0].title, 'Actual Example Title');
  assert.ok(Object.keys(state).includes('globalgrey.sitemap.v1'));
  await extension.search({ text: 'Example' });
  assert.equal(requests.filter(r => r.url.endsWith('/sitemap.xml')).length, 1);
  assert.ok(requests.every(r => new URL(r.url).origin === SITE && !r.url.includes('/ebooks/')));
});
test('search pagination works through browse, with at most three concurrent metadata requests', async () => {
  let active = 0, maximum = 0;
  const { extension } = setup(async p => {
    if (p === '/sitemap.xml') return sitemap(Array.from({ length: 14 }, (_, i) => `/fixture-${String(i).padStart(2, '0')}-ebook.html`));
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--;
    return book(p);
  });
  const first = await extension.search({ text: 'fixture', sort: 'title' });
  assert.equal(first.books.length, 12); assert.ok(first.next.startsWith('search:')); assert.equal(maximum, 3);
  const second = await extension.browse(first.next); assert.equal(second.books.length, 2); assert.equal(second.next, undefined);
  assert.equal(new Set([...first.books, ...second.books].map(b => b.id)).size, 14);
});
test('empty searches and empty matches stay distinct from network failures and broken indexes', async () => {
  const empty = setup(() => sitemap(['/other-ebook.html']));
  assert.equal((await empty.extension.search({ text: '' })).books.length, 0); assert.equal(empty.requests.length, 0);
  assert.equal((await empty.extension.search({ text: 'absent' })).books.length, 0);
  for (const handler of [() => ({ ok: false, status: 503 }), () => { throw Error('Offline'); }, () => '<html>Not an index</html>', () => '<!DOCTYPE urlset><urlset></urlset>']) {
    await assert.rejects(setup(handler).extension.search({ text: 'fixture' }));
  }
});
test('stale sitemap entries are skipped but transient metadata failures do not silently become empty results', async () => {
  const stale = setup(p => p === '/sitemap.xml' ? sitemap(['/fixture-ebook.html']) : { ok: false, status: 404 });
  assert.equal((await stale.extension.search({ text: 'fixture' })).books.length, 0);
  const failed = setup(p => p === '/sitemap.xml' ? sitemap(['/fixture-ebook.html']) : { ok: false, status: 503 });
  await assert.rejects(failed.extension.search({ text: 'fixture' }), /503/);
});
test('unsafe page paths and malformed search cursors fail before network requests', async () => {
  const { extension, requests } = setup(() => assert.fail('Unexpected request'));
  for (const id of ['https://evil.example/example-ebook.html', '/ebooks/private.epub', '/example-ebook.html?private=yes', '//evil.example/example-ebook.html']) await assert.rejects(extension.details(id));
  await assert.rejects(extension.browse('search:{broken'));
  await assert.rejects(extension.browse('search:{"text":"book","offset":-1}'));
  assert.equal(requests.length, 0);
});
test('the existing DSReader WebView runtime can load and invoke the new extension unchanged', async () => {
  const replies = new Map(); let next = 0, context;
  const sandbox = { URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout, cheerio,
    ReactNativeWebView: { postMessage(value) {
      const message = JSON.parse(value);
      if (message.type === 'host') {
        if (message.method === 'fetch') queueMicrotask(() => context.__pb.hostResult(message.id, true, { status: 200, url: message.args.url, headers: { 'content-type': 'text/html' }, body: Buffer.from(book()).toString('base64'), cookies: [] }));
        else assert.fail(`Unexpected host service ${message.method}`);
      } else if (message.type === 'result') {
        const pending = replies.get(message.id); replies.delete(message.id);
        if (message.ok) pending.resolve(message.value); else pending.reject(Error(message.error.message));
      }
    } } };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../dsreader/assets/vendor/paperback/runtime.pbjs'), 'utf8'), context);
  const call = (method, ...args) => new Promise((resolve, reject) => { const id = String(++next); replies.set(id, { resolve, reject }); context.__pb[method](id, ...args); });
  await call('load', 'fixture:globalgrey', script, {}, 'globalgrey', 'dsr');
  const result = await call('invoke', 'fixture:globalgrey', 'details', ['/example-ebook.html']);
  assert.equal(result.title, 'Original Book'); assert.equal(result.files[0].format, 'epub');
});
