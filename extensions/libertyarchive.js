// Collection torrent discovery only. No torrent submission or payload downloads.
const { fetch } = require('dsreader');
const { load } = require('cheerio');
const SITE = 'https://freecapitalists.org';
const MAX_BYTES = 4_000_000;
const TTL = 15 * 60 * 1000;
const decoder = new TextDecoder('utf-8');
const metadata = new Map(), seen = new Map();
let catalogue;
const clean = value => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
const normal = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function torrentUrl(value) {
  const url = new URL(value, SITE);
  if (url.origin !== SITE || url.username || url.password || url.search || url.hash || !/^\/torrents\/files\/[^/]+\.torrent$/i.test(url.pathname)) throw new Error('Unsupported Liberty Archive torrent address.');
  return url.href;
}
async function request(url, binary) {
  const response = await fetch(url, { credentials: 'omit', timeout: 20000, headers: { Accept: binary ? 'application/x-bittorrent' : 'text/html' } });
  if (!response.ok) throw new Error(`The Liberty Archive returned HTTP ${response.status}. Please try again later.`);
  if (response.url) {
    if (binary) torrentUrl(response.url);
    else if (new URL(response.url).origin !== SITE) throw new Error('The Liberty Archive redirected to an unexpected site.');
  }
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_BYTES) throw new Error('The Liberty Archive metadata response is too large.');
  const value = binary ? new Uint8Array(await response.arrayBuffer()) : await response.text();
  if (value.length > MAX_BYTES) throw new Error('The Liberty Archive metadata response is too large.');
  return value;
}
// Hash the ORIGINAL bencoded info bytes, never a decoded/re-encoded dictionary.
// A small SHA-1 implementation keeps this module independent of native crypto APIs.
function sha1(bytes) {
  const size = Math.ceil((bytes.length + 9) / 64) * 64, padded = new Uint8Array(size);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(size - 4, (bytes.length * 8) >>> 0);
  const rotate = (n, b) => (n << b) | (n >>> (32 - b));
  const words = new Int32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotate(a, 5) + f + e + k + words[i]) | 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
function parseTorrent(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid Liberty Archive torrent metadata.');
  let offset = 0, nodes = 0, infoStart, infoEnd;
  const fail = () => { throw new Error('The Liberty Archive returned invalid torrent metadata.'); };
  function string() {
    const start = offset;
    while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset++;
    const digits = decoder.decode(bytes.subarray(start, offset));
    if (!/^(?:0|[1-9]\d*)$/.test(digits) || bytes[offset++] !== 58) return fail();
    const size = Number(digits);
    if (!Number.isSafeInteger(size) || size > bytes.length - offset) return fail();
    const value = bytes.subarray(offset, offset + size); offset += size;
    return value;
  }
  function value(depth) {
    if (++nodes > 200000 || depth > 32 || offset >= bytes.length) return fail();
    const token = bytes[offset];
    if (token >= 48 && token <= 57) return string();
    offset++;
    if (token === 105) {
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 101) offset++;
      const digits = decoder.decode(bytes.subarray(start, offset));
      if (offset >= bytes.length || !/^(?:0|-?[1-9]\d*)$/.test(digits)) return fail();
      offset++;
      const number = Number(digits); if (!Number.isSafeInteger(number)) return fail();
      return number;
    }
    if (token !== 100 && token !== 108) return fail();
    const result = token === 100 ? Object.create(null) : [];
    while (offset < bytes.length && bytes[offset] !== 101) {
      if (token === 108) result.push(value(depth + 1));
      else {
        const key = decoder.decode(string()); if (Object.hasOwn(result, key)) return fail();
        const start = offset; result[key] = value(depth + 1);
        if (depth === 0 && key === 'info') { infoStart = start; infoEnd = offset; }
      }
    }
    if (bytes[offset++] !== 101) return fail();
    return result;
  }
  const root = value(0), info = root?.info;
  if (offset !== bytes.length || infoStart === undefined || !info || Array.isArray(info) || info instanceof Uint8Array) return fail();
  if (!Number.isSafeInteger(info['piece length']) || info['piece length'] <= 0 || !(info.pieces instanceof Uint8Array) || !info.pieces.length || info.pieces.length % 20 !== 0) return fail();
  const title = info['name.utf-8'] || info.name;
  if (!(title instanceof Uint8Array) || !title.length || title.length > 2048) return fail();
  const files = Array.isArray(info.files) ? info.files : [{ length: info.length, path: [title] }];
  if (!files.length || files.length > 20000) return fail();
  let size = 0;
  const names = files.map(file => {
    const parts = file?.['path.utf-8'] || file?.path;
    if (!Number.isSafeInteger(file?.length) || file.length < 0 || !Array.isArray(parts) || !parts.length || parts.some(p => !(p instanceof Uint8Array))) return fail();
    size += file.length; if (!Number.isSafeInteger(size)) return fail();
    return clean(parts.map(p => decoder.decode(p)).join('/'));
  });
  if (Math.ceil(size / info['piece length']) !== info.pieces.length / 20) return fail();
  const infoHash = sha1(bytes.subarray(infoStart, infoEnd));
  const date = Number.isSafeInteger(root['creation date']) && root['creation date'] > 0 ? new Date(root['creation date'] * 1000) : undefined;
  return { infoHash, size, files: names, name: clean(decoder.decode(title)), uploadedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined };
}
async function collections() {
  if (catalogue && Date.now() - catalogue.time < TTL) return catalogue.promise;
  const promise = (async () => {
    const $ = load(await request(SITE + '/torrents/', false)), result = [], used = new Set();
    $('main .torrent-group a[href]').each((_, node) => {
      const a = $(node); let url;
      try { url = torrentUrl(a.attr('href')); } catch { return; }
      if (used.has(url) || result.length >= 16) return;
      used.add(url);
      const category = clean(a.closest('.torrent-group').find('h3').first().text());
      const label = clean(a.find('span').first().text()) || category;
      if (label) result.push({ url, label, category, categoryId: normal(category).replace(/ /g, '-') });
    });
    if (!result.length) throw new Error('The Liberty Archive torrent catalogue contains no supported collection links.');
    return result;
  })();
  catalogue = { time: Date.now(), promise };
  try { return await promise; } catch (error) { catalogue = undefined; throw error; }
}
async function collection(entry) {
  const cached = metadata.get(entry.url);
  if (cached && Date.now() - cached.time < TTL) return cached.promise;
  const promise = (async () => {
    const data = parseTorrent(await request(entry.url, true));
    const epub = data.files.filter(f => /\.epub$/i.test(f)).length, cbz = data.files.filter(f => /\.cbz$/i.test(f)).length;
    const pdf = data.files.filter(f => /\.pdf$/i.test(f)).length;
    const formats = [epub ? `${epub} EPUB` : '', cbz ? `${cbz} CBZ` : '', pdf ? `${pdf} PDF` : ''].filter(Boolean);
    const name = `${entry.label} — collection (${formats.length ? formats.join(', ') : data.files.length + ' files'})`;
    const release = { id: data.infoHash, name, infoHash: data.infoHash,
      magnet: `magnet:?xt=urn:btih:${data.infoHash}&dn=${encodeURIComponent(name)}`,
      size: data.size, sizeLabel: (data.size / 1024 ** 3).toFixed(2) + ' GiB', uploadedAt: data.uploadedAt,
      category: entry.category, categoryId: entry.categoryId };
    seen.set(release.id, release);
    return { release, names: data.files.map(normal), readable: epub + cbz + pdf > 0 };
  })();
  metadata.set(entry.url, { time: Date.now(), promise });
  try { return await promise; } catch (error) { metadata.delete(entry.url); throw error; }
}
module.exports = {
  async releaseSearch(query = {}) {
    if (query.cursor) throw new Error('The Liberty Archive publishes collection torrents without pagination.');
    if (query.connection && query.connection !== 'direct') throw new Error('The Liberty Archive extension uses direct connections; the RSS relay is not supported.');
    const category = query.category || 'books', type = query.bookType || 'readable';
    if (!['books', 'journals', 'all'].includes(category) || !['readable', 'all'].includes(type)) throw new Error('Choose a supported Liberty Archive collection filter.');
    const words = normal(String(query.text || '').slice(0, 300)).split(' ').filter(Boolean);
    const entries = (await collections()).filter(e => category === 'all' || e.categoryId === category);
    const result = [];
    // Only small torrent metadata is retrieved. Payloads are never requested by this module.
    for (const entry of entries) {
      const data = await collection(entry);
      if (type === 'readable' && !data.readable) continue;
      const label = normal(data.release.name);
      if (!words.length || words.every(w => label.includes(w)) || data.names.some(name => words.every(w => name.includes(w)))) result.push(data.release);
    }
    if (query.sort === 'size') result.sort((a, b) => b.size - a.size);
    else if (query.sort !== 'seeders') result.sort((a, b) => Date.parse(b.uploadedAt || '') - Date.parse(a.uploadedAt || '') || a.name.localeCompare(b.name));
    return { releases: result };
  },
  releaseDetails(id) {
    const release = seen.get(id);
    if (!release) throw new Error('Search again to retrieve this archive collection.');
    return release;
  },
  downloadInfo(value) {
    const release = value && seen.get(value.id);
    if (!release || release.infoHash !== value.infoHash) throw new Error('Search again to verify this archive collection.');
    return { transport: 'torrent', infoHash: release.infoHash, magnet: release.magnet };
  },
};
