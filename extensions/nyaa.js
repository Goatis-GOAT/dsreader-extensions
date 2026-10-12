// Release discovery only. The app owns TorBox credentials, submission and importing.
const { fetchReleaseFeed } = require('dsreader');
const { load } = require('cheerio');
const seen = new Map();
const HASH = /^(?:[a-f\d]{40}|[a-z2-7]{32})$/i;
const magnet = (hash, name) => HASH.test(hash || '') ? 'magnet:?xt=urn:btih:' + hash + '&dn=' + encodeURIComponent(name) : undefined;
function parse(xml) {
  if (typeof xml !== 'string' || xml.length > 4000000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Nyaa returned invalid RSS.');
  const $ = load(xml, { xmlMode: true });
  if ($('rss > channel').length !== 1 || !/<\/rss>\s*$/.test(xml)) throw new Error('Nyaa returned a page instead of RSS.');
  const releases = [];
  $('rss > channel > item').each((_, node) => {
    const el = $(node);
    const value = tag => el.children().filter((_, child) => child.name === tag || child.name === 'nyaa:' + tag).first().text().trim();
    const name = value('title');
    const id = /\/view\/(\d+)(?:$|[?#])/.exec(value('guid'))?.[1];
    if (!name || !id) return;
    const hash = value('infoHash') || /^magnet:\?xt=urn:btih:([a-z\d]+)(?:&|$)/i.exec(value('link'))?.[1];
    const infoHash = HASH.test(hash || '') ? hash : undefined;
    const sizeLabel = value('size');
    const size = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)$/i.exec(sizeLabel);
    const date = Date.parse(value('pubDate'));
    const count = tag => /^\d+$/.test(value(tag)) ? Number(value(tag)) : undefined;
    releases.push({ id, name, infoHash, magnet: magnet(infoHash, name), sizeLabel,
      size: size ? Math.round(Number(size[1]) * (size[2].toLowerCase().includes('i') ? 1024 : 1000) ** ['b', 'kb', 'mb', 'gb', 'tb'].indexOf(size[2].toLowerCase().replace('i', ''))) : undefined,
      seeders: count('seeders'), leechers: count('leechers'), uploadedAt: Number.isFinite(date) ? new Date(date).toISOString() : undefined,
      category: value('category'), categoryId: value('categoryId') });
  });
  return releases;
}
function matches(name, type) {
  const audio = /audio[\s_-]*books?|\b(?:m4b|mp3|flac|aac|ogg|opus)\b|朗読|オーディオブック/i.test(name);
  const ebook = /\b(?:epub|pdf|azw3?|mobi|ebooks?)\b/i.test(name);
  const manga = /\b(?:cbz|cbr|manga|comics?)\b|漫画/i.test(name);
  const ln = /\blight[\s_-]*novels?\b|\bLN\b|ライトノベル/i.test(name);
  if (type === 'all') return true;
  if (type === 'audiobook') return audio;
  if (audio && !ebook && !manga) return false;
  return type === 'ebook' ? ebook : type === 'manga' ? manga : type === 'light-novel' ? ln : true;
}
module.exports = {
  async releaseSearch(query) {
    if (query.cursor) throw new Error('Nyaa RSS does not support pagination.');
    const category = query.category || '3_0';
    if (!/^3_[0-3]$/.test(category)) throw new Error('Choose a literature category.');
    const url = 'https://nyaa.si/?page=rss&c=' + category + '&f=0&q=' + encodeURIComponent(String(query.text || '').trim().slice(0, 300)) + '&m=1';
    const all = parse(await fetchReleaseFeed(url, query.connection));
    seen.clear(); all.forEach(r => seen.set(r.id, r));
    const releases = all.filter(r => matches(r.name, query.bookType || 'books'));
    if (query.sort === 'seeders') releases.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
    if (query.sort === 'size') releases.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
    return { releases };
  },
  releaseDetails(id) { if (!seen.has(id)) throw new Error('Search again to retrieve this release.'); return seen.get(id); },
  downloadInfo(release) {
    const link = magnet(release.infoHash, release.name);
    if (!link) throw new Error('This release has no valid info hash.');
    return { transport: 'torrent', magnet: link, infoHash: release.infoHash };
  },
};
