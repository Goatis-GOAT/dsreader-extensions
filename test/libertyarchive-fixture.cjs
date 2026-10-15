const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const cheerio = require('cheerio');
const code = fs.readFileSync(path.join(__dirname, '../extensions/libertyarchive.js'), 'utf8');
const SITE = 'https://freecapitalists.org';
const catalogue = `<main><h1>Torrents</h1><div class="torrent-group"><h3>Books</h3><a href="/torrents/files/books.torrent"><span>Books · 2014</span><span>275 KB</span></a></div><div class="torrent-group"><h3>Journals</h3><a href="/torrents/files/journals.torrent"><span>Journals · 2012</span></a></div><div class="torrent-group"><h3>Media</h3><a href="/torrents/files/media.torrent"><span>Media · 2013</span></a></div></main>`;
function encode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ':'), v]);
  if (typeof v === 'string') return encode(Buffer.from(v));
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(encode), Buffer.from('e')]);
  return Buffer.concat([Buffer.from('d'), ...Object.keys(v).sort().flatMap(k => [encode(k), encode(v[k])]), Buffer.from('e')]);
}
function torrent(files = ['Mises/Human Action.epub', 'Mises/Human Action.pdf'], options = {}) {
  const entries = files.map(name => ({ length: 1024, path: name.split('/') }));
  const info = { files: entries, name: options.name || 'Original fixture collection', 'piece length': 16384,
    pieces: Buffer.alloc(Math.ceil(entries.length * 1024 / 16384) * 20, 0xff) };
  const raw = encode(info), hash = crypto.createHash('sha1').update(raw).digest('hex');
  const bytes = encode({ announce: 'https://tracker.example/announce', 'creation date': 1400000000, info });
  return { bytes, hash, info, raw };
}
function load(handler, append = '') {
  const requests = [], module = { exports: {} };
  const api = { fetch: async (url, init) => {
    requests.push({ url, init }); const value = await handler(new URL(url).pathname, init);
    if (typeof value === 'string') return { ok: true, status: 200, url, headers: new Headers(), text: async () => value };
    if (value instanceof Uint8Array) return { ok: true, status: 200, url, headers: new Headers(), arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) };
    return value;
  } };
  new Function('require', 'module', 'exports', code + append)(name => name === 'dsreader' ? api : name === 'cheerio' ? cheerio : null, module, module.exports);
  return { extension: module.exports, requests };
}
module.exports = { load, torrent, encode, catalogue, code, SITE };
