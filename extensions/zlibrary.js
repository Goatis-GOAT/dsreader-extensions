// DSReader catalogue source. Never request /dl/ until the app's explicit download action.
const { fetch, storage, absolute } = require('dsreader');
const { load } = require('cheerio');
const SEEDS = ['z-library.sk', 'z-library.ec', 'z-lib.gd', 'z-lib.gl', 'z-library.hn', 'z-library.la'];
const STATE = 'zlibrary.domains.v1';
let chosen, discovering;
const bookCache = new Map();
const supported = ['epub', 'pdf'];
const unavailable = new Map();
const checkErrors = new Map();
function origin(value) {
  try {
    const u = new URL(value.includes('://') ? value : 'https://' + value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.pathname === '/' && !u.search && !u.hash && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) ? u.origin : undefined;
  } catch { return undefined; }
}
function saved() { const s = storage.get(STATE); return s && typeof s === 'object' ? s : {}; }
async function check(base) {
  try {
    const r = await fetch(base + '/eapi/info/ok', { timeout: 7000 });
    if (!r.ok) { checkErrors.set(base, { message: 'HTTP ' + r.status }); return false; }
    const data = r.ok && await r.json();
    if (!data || data.success !== 1) checkErrors.set(base, { message: 'Invalid health response' });
    return data && data.success === 1;
  } catch (error) {
    checkErrors.set(base, error?.type === 'cloudflareError' ? error : { message: 'Connection or health response failed' });
    return false;
  }
}
async function discover() {
  if (chosen) return chosen;
  if (discovering) return discovering;
  discovering = (async () => {
    const s = saved();
    checkErrors.clear();
    const candidates = [...new Set([s.last, ...(Array.isArray(s.domains) ? s.domains.slice(0, 24) : []), ...SEEDS].filter(Boolean).map(origin).filter(Boolean))]
      .filter(base => (unavailable.get(base) || 0) < Date.now());
    let base;
    if (candidates[0] && await check(candidates[0])) base = candidates[0];
    for (let i = 1; !base && i < candidates.length; i += 3) {
      const group = candidates.slice(i, i + 3);
      const results = await Promise.all(group.map(check));
      base = group[results.indexOf(true)];
    }
    if (!base) {
      const challenge = [...checkErrors.values()].find(error => error?.type === 'cloudflareError');
      if (challenge) throw challenge;
      if (!candidates.length) throw new Error('Z-Library domains recently returned server errors. Wait five minutes and try again.');
      const reasons = [...checkErrors.entries()].slice(0, 6).map(([url, error]) => new URL(url).hostname + ': ' + error.message).join('; ');
      throw new Error('No Z-Library domain passed its connection check. ' + reasons);
    }
    let domains = candidates;
    let updated = s.updated || 0;
    if (Date.now() - updated > 86400000) {
      try {
        const r = await fetch(base + '/eapi/info/domains', { timeout: 7000, credentials: 'omit' });
        const data = r.ok && await r.json();
        if (Array.isArray(data?.domains)) {
          domains = [...new Set([...candidates, ...data.domains.map(row => typeof row?.domain === 'string' ? origin(row.domain) : undefined).filter(Boolean)])].slice(0, 32);
          updated = Date.now();
        }
      } catch { /* A known working domain remains usable when list refresh fails. */ }
    }
    storage.set(STATE, { last: base, domains, updated });
    chosen = base;
    return base;
  })();
  try { return await discovering; } finally { discovering = undefined; }
}
function login(base) {
  const e = new Error('Sign in to your Z-Library account, then tap Done and try again.');
  e.type = 'authenticationError'; e.url = base + '/login'; throw e;
}
function safePath(value) {
  if (typeof value !== 'string' || !/^\/book\/[a-z0-9]+\/[^?#]+\.html$/i.test(value)) throw new Error('Invalid book address.');
  return value;
}
function localPath(value, base) {
  try { const u = new URL(value, base); return u.origin === base && !u.username && !u.password ? u.pathname : undefined; } catch { return undefined; }
}
async function page(path) {
  let base, response;
  for (let attempt = 0; attempt < 3; attempt++) {
    base = await discover();
    try { response = await fetch(base + path, { timeout: 20000 }); }
    catch (error) {
      // A browser check needs user interaction, not more automatic requests.
      if (error?.type === 'cloudflareError' || error?.type === 'authenticationError') throw error;
      if (attempt === 2) throw new Error('Z-Library requests failed across three domains. The app could not establish a connection; this does not confirm a DNS problem.');
      unavailable.set(base, Date.now() + 300000); chosen = undefined;
      continue;
    }
    if (![502, 503, 504].includes(response.status)) break;
    unavailable.set(base, Date.now() + 300000); chosen = undefined;
    if (attempt === 2) {
      // Keep this domain for the explicit browser handoff and the matching retry.
      chosen = base; unavailable.delete(base);
      const error = new Error('Z-Library returned HTTP ' + response.status + '. Open the requested page in the browser; if it loads, DSReader can read its results.');
      error.type = 'browserCheckError'; error.url = base + path;
      throw error;
    }
  }
  if (response.status === 401 || (response.url && /\/login(?:[/?#]|$)/i.test(response.url))) login(base);
  if (!response.ok) throw new Error('Z-Library could not load this page (' + response.status + ').');
  const html = await response.text();
  if (html.length > 6000000) throw new Error('Z-Library returned an oversized page.');
  return { $: load(html), base }; // only page DOM, never account state, is parsed
}
function cover($, element, base) {
  const img = element.find('img').first();
  const value = img.attr('data-src') || img.attr('src') || element.find('z-cover').attr('src');
  const url = value && absolute(value, base);
  return url && /^https:\/\//i.test(url) ? url : undefined;
}
function listing($, base, query) {
  const books = [], seen = new Set();
  $('z-bookcard').each((_, node) => {
    const el = $(node), href = localPath(el.attr('href'), base);
    const title = el.find('[slot="title"]').text().trim();
    if (!title || !/^\/book\/[a-z0-9]+\/[^?#]+\.html$/i.test(href || '') || seen.has(href)) return;
    const format = (el.attr('extension') || '').toLowerCase();
    if (format && !supported.includes(format)) return;
    seen.add(href);
    const book = { id: href, title, author: el.find('[slot="author"]').text().trim(), cover: cover($, el, base), summary: [format.toUpperCase(), el.attr('filesize'), el.attr('language'), el.attr('year')].filter(Boolean).join(' · ') };
    books.push(book); bookCache.set(href, book);
    if (bookCache.size > 150) bookCache.delete(bookCache.keys().next().value);
  });
  const next = $('a[href]').toArray().map(n => $(n).attr('href')).find(h => {
    try { const u = new URL(h, base); return u.origin === base && (u.pathname.startsWith('/s/') || h.startsWith('?')) && Number(u.searchParams.get('page')) === query.page + 1; } catch { return false; }
  });
  return { books, next: next ? JSON.stringify({ ...query, page: query.page + 1 }) : undefined };
}
async function search(query) {
  const format = query.filters?.format?.[0] || query.format || 'epub';
  if (!supported.includes(format)) throw new Error('Choose EPUB or PDF.');
  const text = String(query.text || '').trim().slice(0, 300), pageNumber = Math.max(1, Math.min(1000, Number(query.page) || 1));
  const state = { text, format, page: pageNumber };
  const path = '/s/' + encodeURIComponent(text) + '?' + new URLSearchParams({ 'extensions[]': format.toUpperCase(), page: String(pageNumber) });
  const { $, base } = await page(path);
  return listing($, base, state);
}
function size(text) {
  const m = /(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)\b/i.exec(text);
  return m ? Math.round(Number(m[1]) * 1024 ** ['B','KB','MB','GB'].indexOf(m[2].toUpperCase())) : undefined;
}
async function details(id) {
  const path = safePath(id), { $, base } = await page(path);
  const title = $('h1').first().text().trim();
  if (!title) throw new Error('This book could not be found.');
  const button = $('a.dlButton').filter((_, n) => /^\/dl\/[a-z0-9]+$/i.test(localPath($(n).attr('href'), base) || '')).first();
  if (!button.length) {
    if ($('a[href="/login"], #loginForm, .auth_modal_login').length) login(base);
    throw new Error('This edition is unavailable to download. Check your account limits on the site.');
  }
  const label = button.text().trim(), format = supported.find(f => new RegExp('\\b' + f + '\\b', 'i').test(label));
  if (!format) throw new Error('This edition is not an EPUB or PDF.');
  return { title, author: $('a[href^="/author/"]').first().text().trim(), cover: cover($, $('z-cover').first().parent(), base) || bookCache.get(path)?.cover,
    description: $('#bookDescriptionBox, .bookDescriptionBox, .book-description').first().text().trim(), webUrl: base + path,
    language: $('.property_language').first().text().replace(/^\s*Language\s*:\s*/i, '').trim(),
    published: $('.property_year .property_value').first().text().trim(),
    tags: $('.property_categories a').toArray().map(n => $(n).text().trim()).filter(Boolean),
    files: [{ label: label || format.toUpperCase(), format, size: size(label), url: base + localPath(button.attr('href'), base), resolve: true }],
  };
}
module.exports = {
  site: 'https://z-library.sk',
  featured: () => [{ title: 'Popular books', path: 'popular' }],
  async browse(path) {
    if (path && path !== 'popular') return search(JSON.parse(path));
    const { $, base } = await page('/');
    return listing($, base, { text: '', format: 'epub', page: 1 });
  },
  search,
  searchOptions: () => ({ sorts: [], filters: [{ id: 'format', title: 'File type', multiple: false, options: [{ id: 'epub', label: 'EPUB' }, { id: 'pdf', label: 'PDF' }] }] }),
  details,
  async resolveFile(id, format) {
    const d = await details(id); // refresh the link; never fetch it in the script
    const file = d.files.find(f => f.format === format);
    if (!file) throw new Error('The selected format is no longer available.');
    return file;
  },
};
