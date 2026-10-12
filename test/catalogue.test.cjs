const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cheerio = require('cheerio');
const scripts = path.join(__dirname, '../extensions');
function load(name, api) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(path.join(scripts, name + '.js'), 'utf8'))(id => id === 'dsreader' ? api : id === 'cheerio' ? cheerio : null, module, module.exports);
  return module.exports;
}
const db = () => { const data = {}; return { get: k => data[k], set: (k, v) => { data[k] = v; }, delete: k => { delete data[k]; }, getAllKeys: () => Object.keys(data) }; };
const originalBook = { id: 12, title: 'Original fixture volume 1', lang: 'en', image: { filename: 'fixture.jpg' }, description: 'Original fixture description', c_release_dates: { en: 20261012 }, editions: [{ staff: [{ role_type: 'author', name: 'Original Author' }] }], titles: [{ title: 'Alternate English Title', lang: 'en' }], series: { id: 2, title: 'Fixture series', tags: [{ name: 'Fantasy' }] } };
test('RanobeDB uses digital editions, encoded search, pagination and a bounded metadata cache', async () => {
  const urls = [];
  const extension = load('ranobedb', { storage: db(), fetchJson: async url => { urls.push(url); return { books: [originalBook], currentPage: 1, totalPages: 2 }; } });
  const query = { text: 'A & B', filters: { language: ['en'] } };
  const result = await extension.search(query);
  assert.equal(result.books[0].id, '12');
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get('q'), 'A & B');
  assert.equal(url.searchParams.get('rf'), 'digital');
  assert.equal(url.searchParams.get('rl'), 'en');
  assert.equal(JSON.parse(result.next).page, 2);
  await extension.search(query);
  assert.equal(urls.length, 1);
});
test('catalogue details delegate downloads and retain book metadata without manufacturing files', async () => {
  const extension = load('ranobedb', { storage: db(), fetchJson: async () => ({ book: originalBook }) });
  const result = await extension.details('12');
  assert.deepEqual(result.files, []);
  assert.equal(result.author, 'Original Author');
  assert.equal(result.published, '2026-10-12');
  assert.equal(result.cover, 'https://images.ranobedb.org/fixture.jpg');
  assert.equal(result.downloadSearch.extensionId, 'nyaa');
  assert.equal(result.downloadSearch.category, '3_1');
  assert.equal(result.downloadSearch.bookType, 'books');
  assert.deepEqual(result.downloadSearch.queries, ['Original fixture volume 1', 'Alternate English Title', 'Fixture series']);
  assert.match(result.attribution, /RanobeDB/);
  await assert.rejects(() => extension.details('../oops'), /Invalid/);
});
test('series use edition language and explicit order; empty and network failure stay distinct', async () => {
  const extension = load('ranobedb', { storage: db(), fetchJson: async () => ({ series: { title: 'Fixture', books: [{ ...originalBook, id: 3, sort_order: 2 }, { ...originalBook, id: 1, sort_order: 1 }, { ...originalBook, id: 4, lang: 'ja', sort_order: 0 }] } }) });
  const result = await extension.browse(JSON.stringify({ series: 2, language: 'en' }));
  assert.deepEqual(result.books.map(b => b.id), ['1', '3']);
  const empty = load('ranobedb', { storage: db(), fetchJson: async () => ({ books: [], currentPage: 1, totalPages: 1 }) });
  assert.deepEqual((await empty.search({ text: 'missing' })).books, []);
  const offline = load('ranobedb', { storage: db(), fetchJson: async () => { throw new Error('internal provider details'); } });
  await assert.rejects(() => offline.search({ text: 'anything' }), /Could not load RanobeDB/);
});
const hash = '0123456789abcdef0123456789abcdef01234567';
const feed = items => `<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${items}</channel></rss>`;
const item = (id, title, seeders = 10) => `<item><title>${title}</title><guid>https://nyaa.si/view/${id}</guid><nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:size>1.5 GiB</nyaa:size><nyaa:seeders>${seeders}</nyaa:seeders><nyaa:leechers>2</nyaa:leechers><nyaa:categoryId>3_1</nyaa:categoryId><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>`;
test('Nyaa DSReader release extension preserves RSS metadata, filters audio and resolves magnets', async () => {
  let request;
  const extension = load('nyaa', { fetchReleaseFeed: async (url, connection) => { request = { url, connection }; return feed(item(1, '[EPUB] Original &amp; fixture') + item(2, '[MP3] Audiobook', 99) + item(3, 'Unlabelled', 20)); } });
  const result = await extension.releaseSearch({ text: 'A & B', category: '3_1', sort: 'seeders', connection: 'relay', bookType: 'books' });
  assert.deepEqual(result.releases.map(r => r.id), ['3', '1']);
  const release = result.releases[1];
  assert.equal(release.name, '[EPUB] Original & fixture');
  assert.equal(release.size, 1.5 * 1024 ** 3);
  assert.equal(release.seeders, 10);
  assert.equal(release.leechers, 2);
  assert.equal(release.categoryId, '3_1');
  assert.equal(release.uploadedAt, '2026-10-12T10:00:00.000Z');
  assert.equal(request.connection, 'relay');
  assert.equal(new URL(request.url).searchParams.get('q'), 'A & B');
  assert.equal(extension.releaseDetails('1'), release);
  assert.match(extension.downloadInfo(release).magnet, /urn:btih:/);
  assert.throws(() => extension.downloadInfo({ infoHash: 'bad', name: 'fixture' }), /valid info hash/);
  await assert.rejects(() => extension.releaseSearch({ cursor: 'next' }), /pagination/);
  await assert.rejects(() => extension.releaseSearch({ category: '1_0' }), /literature/);
});
test('Nyaa handles empty feeds and rejects HTML, entities and truncated feeds', async () => {
  for (const xml of ['<html>Blocked</html>', '<!DOCTYPE rss><rss><channel/></rss>', '<rss><channel>']) {
    const extension = load('nyaa', { fetchReleaseFeed: async () => xml });
    await assert.rejects(() => extension.releaseSearch({ text: '' }), /RSS/);
  }
  const extension = load('nyaa', { fetchReleaseFeed: async () => feed('') });
  assert.deepEqual((await extension.releaseSearch({ text: '' })).releases, []);
});
test('actual WebView runtime loads release-only DSReader scripts and routes RSS through the host', async () => {
  const pending = new Map(); let number = 0; let context; let feedCalls = 0;
  const sandbox = { URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout, cheerio,
    ReactNativeWebView: { postMessage(json) {
      const msg = JSON.parse(json);
      if (msg.type === 'host') {
        assert.equal(msg.method, 'releaseFeed');
        assert.equal(msg.args.connection, 'relay');
        assert.equal(msg.args.url.includes('api-key'), false);
        feedCalls++;
        queueMicrotask(() => context.__pb.hostResult(msg.id, true, feed(item(1, 'Original fixture'))));
      } else if (msg.type === 'result') {
        const waiter = pending.get(msg.id); pending.delete(msg.id);
        msg.ok ? waiter.resolve(msg.value) : waiter.reject(new Error(msg.error.message));
      }
    } } };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../dsreader/assets/vendor/paperback/runtime.pbjs'), 'utf8'), context);
  const call = (fn, ...args) => new Promise((resolve, reject) => { const id = String(++number); pending.set(id, { resolve, reject }); context.__pb[fn](id, ...args); });
  await call('load', 'fixture:nyaa', fs.readFileSync(path.join(scripts, 'nyaa.js'), 'utf8'), {}, 'nyaa', 'dsr');
  const result = await call('invoke', 'fixture:nyaa', 'releaseSearch', [{ text: 'original', category: '3_1', connection: 'relay' }]);
  assert.equal(result.releases.length, 1);
  assert.equal(feedCalls, 1);
  assert.equal((await call('invoke', 'fixture:nyaa', 'downloadInfo', [result.releases[0]])).transport, 'torrent');
});
