// Whole-book catalogue. Uses only the existing dsreader/cheerio extension APIs.
const { fetch, storage } = require('dsreader');
const { load } = require('cheerio');
const SITE = 'https://www.globalgreyebooks.com';
const INDEX_KEY = 'globalgrey.sitemap.v1';
const DAY = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 12;
const BOOK = /^\/(?:book-page\/)?[a-z0-9][a-z0-9_-]*-ebook\.html$/i;
const LIST = /^\/(?:recently-added|ebook-categories|authors|[a-z0-9][a-z0-9_-]*-books|category\/ebooks\/[a-z0-9-]+-page-\d+)\.html$/i;
const cache = new Map();
let indexPending;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const normal = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function url(value, base = SITE) {
  const u = new URL(value, base);
  if (u.origin !== SITE || u.username || u.password || u.search) throw new Error('Invalid Global Grey address.');
  u.hash = '';
  return u;
}
function pathOf(value, kind) {
  const u = url(value);
  if (!(kind === 'book' ? BOOK : LIST).test(u.pathname)) throw new Error('Unsupported Global Grey page.');
  return u.pathname;
}
function image(value) {
  try { const u = url(value); return /^\/content\/book-covers(?:-\d+)?\/.+\.(?:jpe?g|png|webp)$/i.test(u.pathname) ? u.href : undefined; } catch { return; }
}
async function text(path, xml = false) {
  const address = url(path).href;
  const response = await fetch(address, { timeout: 12000, credentials: 'omit', headers: { Accept: xml ? 'application/xml, text/xml' : 'text/html' } });
  if (!response.ok) {
    const error = new Error(`Global Grey returned HTTP ${response.status}. Please try again later.`);
    error.status = response.status;
    throw error;
  }
  if (response.url) url(response.url); // Reject an unexpected off-site response.
  const body = await response.text();
  if (typeof body !== 'string' || body.length > 4_000_000) throw new Error('Global Grey returned an oversized response.');
  if (!xml && !/<main\b/i.test(body)) throw new Error('Global Grey returned an unexpected page.');
  return body;
}
function folders($) {
  const out = [], seen = new Set();
  $('main .cat-links a, main .author-list a').each((_, node) => {
    const a = $(node), label = clean(a.text());
    let path;
    try { path = url(a.attr('href')).pathname; } catch { return; }
    if (!label || seen.has(path) || (!LIST.test(path) && !BOOK.test(path))) return;
    const category = clean(a.closest('.cat-card').find('.cat-name').text());
    const title = category ? label === 'All' ? category : `${category} · ${label}` : label;
    seen.add(path); out.push({ path, title });
  });
  return out;
}
function cards($) {
  const out = [], seen = new Set();
  $('main .book-card').each((_, node) => {
    const card = $(node), a = card.find('.book-title a').first();
    let id;
    try { id = pathOf(a.attr('href'), 'book'); } catch { return; }
    const title = clean(a.text());
    if (!title || seen.has(id)) return;
    seen.add(id);
    const img = card.find('.book-cover img').first();
    out.push({ id, title, author: clean(card.find('.book-author').text()) || undefined, cover: image(img.attr('data-src') || img.attr('src')) });
  });
  return out;
}
function nextPage($, current) {
  const here = /^(.*-page-)(\d+)\.html$/.exec(current);
  if (!here) return;
  let next;
  $('main a.page-link, main a[rel="next"]').each((_, node) => {
    let candidate;
    try { candidate = pathOf($(node).attr('href'), 'list'); } catch { return; }
    const match = /^(.*-page-)(\d+)\.html$/.exec(candidate);
    if (match && match[1] === here[1] && Number(match[2]) === Number(here[2]) + 1) next = candidate;
  });
  return next;
}
function structuredBook($) {
  const queue = [];
  $('script[type="application/ld+json"]').each((_, node) => {
    try { const value = JSON.parse($(node).text()); queue.push(...(Array.isArray(value) ? value : [value])); } catch { /* HTML metadata remains available. */ }
  });
  for (let i = 0; i < queue.length && i < 100; i++) {
    const value = queue[i];
    if (!value || typeof value !== 'object') continue;
    if (value['@type'] === 'Book' || (Array.isArray(value['@type']) && value['@type'].includes('Book'))) return value;
    if (Array.isArray(value['@graph'])) queue.push(...value['@graph']);
  }
  return {};
}
async function details(value) {
  const id = pathOf(value, 'book'), cached = cache.get(id);
  if (cached && Date.now() - cached.time < 15 * 60 * 1000) return cached.book;
  const $ = load(await text(id)), data = structuredBook($);
  const title = clean($('meta[name="dc.title"]').attr('content') || $('#book-title, main h1').first().text() || data.name);
  const authors = (Array.isArray(data.author) ? data.author : [data.author]).map(a => typeof a === 'string' ? a : a?.name).filter(Boolean);
  const author = clean($('meta[name="dc.creator"]').attr('content') || $('.book-byline a').text() || authors.join(', '));
  if (!title) throw new Error('This Global Grey book has no readable title.');
  const files = [], seen = new Set();
  $('.download-group a[href], .download-area a[href]').each((_, node) => {
    let target;
    try { target = url($(node).attr('href')); } catch { return; }
    const format = /^\/ebooks(?:-\d+)?\/.+\.(epub|pdf)$/i.exec(target.pathname)?.[1]?.toLowerCase();
    if (!format || seen.has(target.href)) return;
    seen.add(target.href); files.push({ label: format.toUpperCase(), format, url: target.href });
  });
  files.sort((a, b) => (a.format === 'epub' ? 0 : 1) - (b.format === 'epub' ? 0 : 1));
  if (!files.length) throw new Error('This book has no supported EPUB or PDF download on Global Grey.');
  const related = [], used = new Set();
  $('.book-byline a, main .crumbs a').each((_, node) => {
    let path;
    try { path = pathOf($(node).attr('href'), 'list'); } catch { return; }
    if (used.has(path)) return;
    used.add(path); related.push({ path, title: clean($(node).text()) });
  });
  const book = { id, title, author: author || undefined,
    cover: image($('meta[property="og:image"]').attr('content') || $('.book-cover img').first().attr('src') || (typeof data.image === 'string' ? data.image : data.image?.url)),
    description: clean($('.book-body .prose').text() || data.description || $('meta[name="description"]').attr('content')),
    language: clean(data.inLanguage || $('meta[name="dc.language"]').attr('content')) || 'en',
    published: data.datePublished == null ? undefined : clean(data.datePublished),
    tags: (Array.isArray(data.genre) ? data.genre : data.genre ? [data.genre] : []).filter(v => typeof v === 'string'),
    webUrl: SITE + id, files, related,
    attribution: 'Global Grey ebooks · globalgreyebooks.com · Please consider supporting the original site.' };
  cache.delete(id); cache.set(id, { time: Date.now(), book });
  while (cache.size > 48) cache.delete(cache.keys().next().value);
  return book;
}
async function sitemap() {
  const saved = await storage.get(INDEX_KEY);
  if (saved && Date.now() >= saved.time && Date.now() - saved.time < DAY && Array.isArray(saved.books) && saved.books.every(b => b && typeof b.id === 'string' && BOOK.test(b.id) && typeof b.terms === 'string')) return saved.books;
  if (indexPending) return indexPending;
  indexPending = (async () => {
    const xml = await text('/sitemap.xml', true);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || !/<urlset\b/i.test(xml) || !/<\/urlset>\s*$/.test(xml)) throw new Error('Global Grey returned an invalid search index.');
    const $ = load(xml, { xmlMode: true }), paths = [], hints = new Map();
    $('url > loc').each((_, node) => {
      let path;
      try { path = url($(node).text().trim()).pathname; } catch { return; }
      if (BOOK.test(path)) paths.push(path);
      const online = /^\/online-(?:ebooks|books)(?:-\d+)?\/([^/]+)_complete-text\.html$/i.exec(path)?.[1];
      if (online && online.includes('_')) {
        hints.set(normal(online.slice(online.indexOf('_') + 1)), normal(online));
        hints.set(normal(online), normal(online));
      }
    });
    const books = [...new Set(paths)].map(id => {
      const title = normal(id.split('/').pop().replace(/-ebook\.html$/i, ''));
      return { id, terms: hints.get(title) || title };
    });
    if (!books.length) throw new Error('Global Grey search index contains no book pages.');
    await storage.set(INDEX_KEY, { time: Date.now(), books });
    return books;
  })();
  try { return await indexPending; } finally { indexPending = undefined; }
}
async function search(query = {}) {
  const input = clean(query.text).slice(0, 300), words = normal(input).split(' ').filter(Boolean);
  if (!words.length) return { title: 'Search Global Grey', books: [] };
  const offset = query.offset === undefined ? 0 : query.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || (query.sort && !['relevance', 'title'].includes(query.sort))) throw new Error('Invalid Global Grey search page.');
  const matches = (await sitemap()).filter(b => words.every(w => b.terms.includes(w)));
  matches.sort((a, b) => {
    if (query.sort !== 'title') {
      const phrase = normal(input), score = b => normal(b.id).includes(phrase) ? 1 : 0;
      const difference = score(b) - score(a); if (difference) return difference;
    }
    return a.id.split('/').pop().localeCompare(b.id.split('/').pop());
  });
  const selected = matches.slice(offset, offset + PAGE_SIZE), books = new Array(selected.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      try { const book = await details(selected[index].id); books[index] = { id: book.id, title: book.title, author: book.author, cover: book.cover }; }
      catch (error) { if (error.status !== 404) throw error; } // A removed sitemap entry is not a connection failure.
    }
  }));
  return { title: `Search: ${input}`, books: books.filter(Boolean),
    next: offset + PAGE_SIZE < matches.length ? 'search:' + JSON.stringify({ text: input, sort: query.sort || 'relevance', offset: offset + PAGE_SIZE }) : undefined };
}
module.exports = {
  site: SITE,
  featured: () => [
    { title: 'Recently added', path: '/recently-added.html' },
    { title: 'Fiction', path: '/category/ebooks/fiction-page-1.html' },
    { title: 'Non-fiction', path: '/category/ebooks/non-fiction-page-1.html' },
  ],
  async browse(path) {
    if (typeof path === 'string' && path.startsWith('search:')) return search(JSON.parse(path.slice(7)));
    if (path && BOOK.test(path)) return { books: [await details(path)] };
    const current = path ? pathOf(path, 'list') : '/recently-added.html';
    const $ = load(await text(current));
    const result = { title: clean($('main h1').first().text()) || 'Global Grey', books: cards($), folders: folders($), next: nextPage($, current) };
    if (!path) result.folders.unshift({ path: '/ebook-categories.html', title: 'Browse categories' }, { path: '/authors.html', title: 'Browse authors' });
    return result;
  },
  search,
  searchOptions: () => ({ sorts: [{ id: 'relevance', label: 'Relevance' }, { id: 'title', label: 'Title' }], filters: [] }),
  details,
};
