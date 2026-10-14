// DSReader catalogue source. Never request /dl/ until the app's explicit download action.
const { fetch, storage, absolute } = require('dsreader');
const { load } = require('cheerio');
// Desktop 2.4.3's bundled/saved public book domains, plus its observed active address.
// Article-only endpoints and .onion addresses are not book-source HTTPS fallbacks.
const SEEDS = ['en.z-lib.bz', 'z-lib.sk', 'z-library.im', 'z-library.sk', 'z-lib.fm',
  'z-lib.gd', 'z-lib.gl', 'z-lib.bz', 'z-lib.do', 'z-library.hn', 'z-library.la',
  'italian-books.sk', 'spanish-books.sk', 'thai-books.sk', 'japanese-books.sk',
  'frenchbooks.sk', 'german-books.sk', 'portuguese-books.sk', 'z-lib.fo',
  'urdu-books.sk', 'z-library.ec', 'czechbooks.sk', 'librella.fi', 'librella.tw',
  'lexlib.fi', 'lexlib.tw', 'bookabooki.fi', 'bookabooki.tw', '1lib.sk', 'z-lib.sx', 'z-library.gs'];
// Refresh older installations from the desktop pool instead of retaining the former seed order.
const STATE = 'zlibrary.domains.desktop.v2';
let chosen, discovering;
let homepage;
const bookCache = new Map();
const supported = ['epub', 'pdf'];
const unavailable = new Map();
const checkErrors = new Map();
function origin(value) {
  try {
    const u = new URL(value.includes('://') ? value : 'https://' + value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.pathname === '/' && !u.search && !u.hash && !/\.onion$/i.test(u.hostname) && !/^articles?(?:\.|[0-9])/i.test(u.hostname) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) ? u.origin : undefined;
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
async function discover(path = '/') {
  if (chosen) return chosen;
  if (discovering) return discovering;
  discovering = (async () => {
    const s = saved();
    checkErrors.clear();
    const candidates = [...new Set([s.last, ...(Array.isArray(s.domains) ? s.domains.slice(0, 48) : []), ...SEEDS].filter(Boolean).map(origin).filter(Boolean))]
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
      if (challenge) {
        // Open the requested content page, not the JSON health endpoint.
        const checkUrl = challenge.resolutionRequest?.url;
        const checkedBase = checkUrl && origin(new URL(checkUrl).origin);
        if (checkedBase && candidates.includes(checkedBase)) {
          chosen = checkedBase;
          challenge.resolutionRequest = { ...challenge.resolutionRequest, url: checkedBase + path };
        }
        throw challenge;
      }
      if (!candidates.length) throw new Error('Z-Library domains recently returned server errors. Wait five minutes and try again.');
      // A failed API health check does not prove the website cannot load in a browser.
      // Prefer the user's last domain, then the seed already verified in the browser.
      const fallback = candidates.find(base => base === origin(s.last || ''))
        || candidates.find(base => base === 'https://en.z-lib.bz') || candidates[0];
      chosen = fallback;
      // Try the content page; the app can inspect it using its browser connection.
      // API failure alone must never claim a warning or verification is required.
      return fallback;
    }
    let domains = candidates;
    let updated = s.updated || 0;
    if (Date.now() - updated > 86400000) {
      try {
        const r = await fetch(base + '/eapi/info/domains/singlelogin', { timeout: 7000, credentials: 'omit' });
        const data = r.ok && await r.json();
        if (data?.success === 1 && Array.isArray(data.domains)) {
          domains = [...new Set([...data.domains.map(row => typeof row?.domain === 'string' ? origin(row.domain) : undefined).filter(Boolean), ...candidates])].slice(0, 48);
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
async function page(path, preferredBase) {
  let base, response;
  for (let attempt = 0; attempt < 3; attempt++) {
    base = preferredBase || await discover(path);
    try { response = await fetch(base + path, { timeout: 20000 }); }
    catch (error) {
      // A browser check needs user interaction, not more automatic requests.
      if (error?.type === 'cloudflareError' || error?.type === 'authenticationError') throw error;
      if (preferredBase) throw new Error('The account server could not be reached. Your saved account is not removed.');
      if (attempt === 2) throw new Error('Z-Library requests failed across three domains. The app could not establish a connection; this does not confirm a DNS problem.');
      unavailable.set(base, Date.now() + 300000); chosen = undefined;
      continue;
    }
    if (![502, 503, 504].includes(response.status)) break;
    if (preferredBase) throw new Error('The account server returned HTTP ' + response.status + '. Your download allowance is temporarily unavailable.');
    unavailable.set(base, Date.now() + 300000); chosen = undefined;
    if (attempt === 2) {
      // Keep this domain for the explicit browser handoff and the matching retry.
      chosen = base; unavailable.delete(base);
      throw new Error('Z-Library returned HTTP ' + response.status + ' across the checked domains. Try again later. This is a server error, not a verification request.');
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
  // Homepage recommendations are image links in z-masonry, not search's z-bookcard elements.
  if (!books.length) $('z-masonry a[href], .books-mosaic a[href]').each((_, node) => {
    const el = $(node), href = localPath(el.attr('href'), base), img = el.find('img').first();
    const label = (img.attr('alt') || el.attr('title') || '').trim();
    if (!label || !/^\/book\/[a-z0-9]+\/[^?#]+\.html$/i.test(href || '') || seen.has(href)) return;
    const split = label.indexOf(' — ');
    const book = { id: href, title: split < 0 ? label : label.slice(split + 3).trim(), author: split < 0 ? undefined : label.slice(0, split).trim(), cover: cover($, el, base) };
    if (!book.title) return;
    seen.add(href); books.push(book); bookCache.set(href, book);
    if (bookCache.size > 150) bookCache.delete(bookCache.keys().next().value);
  });
  const next = $('a[href]').toArray().map(n => $(n).attr('href')).find(h => {
    try { const u = new URL(h, base); return u.origin === base && (u.pathname.startsWith('/s/') || h.startsWith('?')) && Number(u.searchParams.get('page')) === query.page + 1; } catch { return false; }
  });
  return { books, next: next ? JSON.stringify({ ...query, page: query.page + 1 }) : undefined };
}
async function home() {
  // Share concurrent homepage requests without retaining a stale signed-in page.
  if (!homepage) homepage = page('/').finally(() => { homepage = undefined; });
  return homepage;
}
async function accountStatus(options = {}) {
  try {
    const preferred = typeof options.origin === 'string' ? origin(options.origin) : undefined;
    const known = preferred && SEEDS.includes(new URL(preferred).hostname) ? preferred : undefined;
    const { $, base } = await page('/profile', known);
    const tile = $('.caret-scroll__tile').filter((_, node) => /^daily limit$/i.test($(node).find('.caret-scroll__desc').text().trim())).first();
    const ratio = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(tile.find('.caret-scroll__title').text());
    if (ratio) {
      const used = Number(ratio[1]), limit = Number(ratio[2]);
      if (Number.isSafeInteger(used) && Number.isSafeInteger(limit))
        return { provider: 'zlibrary', signedIn: true, used, limit, remaining: Math.max(0, limit - used), signInUrl: base + '/login' };
    }
    return { provider: 'zlibrary', signedIn: $('#loginForm, .auth_modal_login, a[href="/login"]').length ? false : undefined, signInUrl: base + '/login' };
  } catch (error) {
    if (error?.type === 'authenticationError') return { provider: 'zlibrary', signedIn: false, signInUrl: error.url };
    throw error;
  }
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
  site: 'https://en.z-lib.bz',
  featured: () => [{ title: 'Featured books', path: 'popular' }],
  async browse(path) {
    if (path && path !== 'popular') return search(JSON.parse(path));
    const { $, base } = await home();
    return listing($, base, { text: '', format: 'epub', page: 1 });
  },
  search,
  accountStatus,
  searchOptions: () => ({ sorts: [], filters: [{ id: 'format', title: 'File type', multiple: false, options: [{ id: 'epub', label: 'EPUB' }, { id: 'pdf', label: 'PDF' }] }] }),
  details,
  async resolveFile(id, format) {
    const d = await details(id); // refresh the link; never fetch it in the script
    const file = d.files.find(f => f.format === format);
    if (!file) throw new Error('The selected format is no longer available.');
    return file;
  },
};
