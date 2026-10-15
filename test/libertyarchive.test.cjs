const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const cheerio = require('cheerio');
const { load, torrent, encode, catalogue, code, SITE } = require('./libertyarchive-fixture.cjs');
const fixture = torrent();
function setup() { return load(p => p === '/torrents/' ? catalogue : p.includes('journals') ? torrent(['Journal/Issue.pdf']).bytes : p.includes('media') ? torrent(['Lectures/Lecture.mp3']).bytes : fixture.bytes); }
test('default discovery returns an EPUB-containing book collection and hashes the original info bytes', async () => {
  const { extension, requests } = setup();
  const result = await extension.releaseSearch({ text: '' });
  assert.equal(result.releases.length, 1);
  const release = result.releases[0];
  assert.equal(release.infoHash, fixture.hash); assert.equal(release.id, fixture.hash);
  assert.equal(release.size, 2048); assert.match(release.name, /collection \(1 EPUB, 1 PDF\)/);
  assert.equal(release.uploadedAt, new Date(1400000000000).toISOString());
  assert.equal(release.seeders, undefined); assert.equal(release.leechers, undefined);
  assert.equal(release.categoryId, 'books');
  assert.equal(extension.releaseDetails(release.id), release);
  assert.match(extension.downloadInfo(release).magnet, new RegExp('urn:btih:' + fixture.hash));
  assert.equal(requests.length, 2); assert.ok(requests.every(r => r.init.credentials === 'omit'));
  assert.ok(requests.every(r => r.url === SITE + '/torrents/' || r.url.endsWith('.torrent')));
});
test('filename search returns the collection containing a book without presenting it as an individual release', async () => {
  const { extension, requests } = setup();
  assert.equal((await extension.releaseSearch({ text: 'Human Action Mises' })).releases.length, 1);
  assert.equal((await extension.releaseSearch({ text: 'Unrelated title' })).releases.length, 0);
  assert.equal((await extension.releaseSearch({ text: 'Books' })).releases.length, 1);
  assert.equal(requests.length, 2, 'catalogue and torrent metadata are cached');
});
test('PDF journals are readable and audio-only collections require the all-formats filter', async () => {
  const { extension } = setup();
  assert.equal((await extension.releaseSearch({ category: 'all' })).releases.length, 2);
  assert.equal((await extension.releaseSearch({ category: 'journals' })).releases[0].categoryId, 'journals');
  const all = await extension.releaseSearch({ category: 'all', bookType: 'all', sort: 'size' });
  assert.equal(all.releases.length, 3);
  assert.ok(all.releases.some(r => r.categoryId === 'journals'));
  assert.ok(all.releases.some(r => r.categoryId === 'media'));
});
test('unsupported relay, pagination and category requests fail before any network access', async () => {
  const { extension, requests } = setup();
  for (const query of [{ connection: 'relay' }, { cursor: '2' }, { category: 'other' }, { bookType: 'other' }]) await assert.rejects(extension.releaseSearch(query));
  assert.equal(requests.length, 0);
});
test('download information cannot submit a forged hash or arbitrary magnet', async () => {
  const { extension, requests } = setup();
  assert.throws(() => extension.downloadInfo({ id: fixture.hash, infoHash: fixture.hash }));
  const release = (await extension.releaseSearch({})).releases[0];
  assert.throws(() => extension.downloadInfo({ ...release, infoHash: 'f'.repeat(40) }));
  const result = extension.downloadInfo({ ...release, magnet: 'magnet:?xt=urn:btih:' + 'f'.repeat(40) });
  assert.match(result.magnet, new RegExp(fixture.hash)); assert.equal(requests.length, 2);
});
test('parser rejects malformed, truncated, oversized and inconsistent torrents', () => {
  const { extension } = load(() => null, '\nmodule.exports.parse = parseTorrent;');
  const badInfo = { ...fixture.info, pieces: Buffer.alloc(19) };
  for (const bytes of [Buffer.from('<html>Blocked</html>'), fixture.bytes.subarray(0, -1), Buffer.concat([fixture.bytes, Buffer.from('x')]), Buffer.from('d4:infoi01ee'), encode({ info: badInfo }), encode({ info: { ...fixture.info, files: [{ length: -1, path: ['bad'] }] } }), Buffer.alloc(4000001)]) assert.throws(() => extension.parse(bytes));
  assert.equal(extension.parse(fixture.bytes).infoHash, fixture.hash);
});
test('bundled SHA-1 matches Node crypto across block boundaries and binary piece data', () => {
  const { extension } = load(() => null, '\nmodule.exports.hash = sha1;');
  for (const size of [0, 1, 55, 56, 63, 64, 65, 127, 512, 4096, 281600]) {
    const bytes = Buffer.alloc(size); for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 255) % 256;
    assert.equal(extension.hash(bytes), crypto.createHash('sha1').update(bytes).digest('hex'));
  }
});
test('unsafe torrent links are ignored and server failures are never reported as empty results', async () => {
  const unsafe = catalogue.replace('/torrents/files/books.torrent', 'https://evil.example/evil.torrent');
  const empty = load(() => unsafe);
  assert.equal((await empty.extension.releaseSearch({})).releases.length, 0); assert.equal(empty.requests.length, 1);
  const blocked = load(() => ({ ok: false, status: 503 }));
  await assert.rejects(blocked.extension.releaseSearch({}), /503/);
  await assert.rejects(blocked.extension.releaseSearch({}), /503/);
  assert.equal(blocked.requests.length, 2, 'failed catalogue fetches are not cached');
  const malformed = load(p => p === '/torrents/' ? catalogue : Buffer.from('<html>Blocked</html>'));
  await assert.rejects(malformed.extension.releaseSearch({}), /invalid torrent/);
});
test('the existing DSReader runtime supports binary metadata and release methods without app changes', async () => {
  let context, next = 0; const replies = new Map();
  const sandbox = { URL, URLSearchParams, Response, Request, Headers, TextEncoder, TextDecoder, setTimeout, clearTimeout, cheerio,
    ReactNativeWebView: { postMessage(value) {
      const message = JSON.parse(value);
      if (message.type === 'host') {
        assert.equal(message.method, 'fetch');
        const bytes = message.args.url.endsWith('.torrent') ? fixture.bytes : Buffer.from(catalogue);
        queueMicrotask(() => context.__pb.hostResult(message.id, true, { status: 200, url: message.args.url, headers: {}, cookies: [], body: bytes.toString('base64') }));
      } else if (message.type === 'result') {
        const pending = replies.get(message.id); replies.delete(message.id);
        message.ok ? pending.resolve(message.value) : pending.reject(Error(message.error.message));
      }
    } } };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../dsreader/assets/vendor/paperback/runtime.pbjs'), 'utf8'), context);
  const call = (method, ...args) => new Promise((resolve, reject) => { const id = String(++next); replies.set(id, { resolve, reject }); context.__pb[method](id, ...args); });
  await call('load', 'fixture:libertyarchive', code, {}, 'libertyarchive', 'dsr');
  const result = await call('invoke', 'fixture:libertyarchive', 'releaseSearch', [{ text: 'Human Action' }]);
  assert.equal(result.releases[0].infoHash, fixture.hash);
  const download = await call('invoke', 'fixture:libertyarchive', 'downloadInfo', [result.releases[0]]);
  assert.equal(download.transport, 'torrent'); assert.equal(download.infoHash, fixture.hash);
});
