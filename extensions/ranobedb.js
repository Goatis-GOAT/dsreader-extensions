// Catalogue metadata only. RanobeDB's public API is non-commercial; see README.
const { fetchJson, storage } = require('dsreader');
const SITE = 'https://ranobedb.org';
const API = SITE + '/api/v0';
const ATTRIBUTION = 'Metadata: RanobeDB · Open Database License / Database Contents License. Catalogue entries do not guarantee a downloadable release.';
let queue = Promise.resolve();
let lastRequest = 0;

async function api(path) {
  const key = 'rndb:' + path;
  const cached = await storage.get(key);
  if (cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.data;
  const operation = queue.then(async () => {
    const wait = 1100 - (Date.now() - lastRequest);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequest = Date.now();
    let data;
    try { data = await fetchJson(API + path); }
    catch { throw new Error('Could not load RanobeDB. Check your connection and retry.'); }
    if (!data || typeof data !== 'object') throw new Error('RanobeDB returned invalid metadata.');
    await storage.set(key, { time: Date.now(), data });
    const keys = (await storage.getAllKeys()).filter(k => k.startsWith('rndb:'));
    for (const old of keys.slice(0, Math.max(0, keys.length - 40))) await storage.delete(old);
    return data;
  });
  queue = operation.catch(() => {});
  return operation;
}
const validId = id => {
  if (!/^\d+$/.test(String(id))) throw new Error('Invalid RanobeDB book or series.');
  return String(id);
};
const cover = image => image && !image.nsfw && !image.spoiler && /^[\w.-]+$/.test(image.filename) ? 'https://images.ranobedb.org/' + image.filename : undefined;
const book = b => ({ id: validId(b.id), title: b.title, cover: cover(b.image) });
const pathOf = state => JSON.stringify(state);
function params(state) {
  const p = new URLSearchParams({ page: String(state.page || 1), limit: '24', sort: state.sort || 'Release date desc', rf: 'digital', rfl: 'or' });
  if (state.language !== 'all') { p.set('rl', state.language || 'en'); p.set('rll', 'or'); }
  if (state.text) p.set('q', state.text.slice(0, 300));
  return p;
}
async function listing(state) {
  if (state.series) {
    const data = await api('/series/' + validId(state.series));
    const series = data.series || data;
    if (!Array.isArray(series.books)) throw new Error('RanobeDB returned an invalid series.');
    const books = series.books.filter(b => !b.hidden && (state.language === 'all' || b.lang === (state.language || 'en')));
    return { title: series.title, books: books.sort((a, b) => a.sort_order - b.sort_order).map(book) };
  }
  const series = state.type === 'series';
  const data = await api('/' + (series ? 'series' : 'books') + '?' + params(state));
  const rows = data[series ? 'series' : 'books'];
  if (!Array.isArray(rows)) throw new Error('RanobeDB returned an invalid catalogue.');
  return {
    title: series ? 'Light novel series' : 'Light novel volumes',
    books: series ? [] : rows.filter(b => !b.hidden).map(book),
    folders: series ? rows.filter(s => !s.hidden).map(s => ({ path: pathOf({ series: s.id, language: state.language || 'en' }), title: s.title, subtitle: `${s.c_num_books || 0} volumes` })) : [],
    next: data.currentPage < data.totalPages ? pathOf({ ...state, page: data.currentPage + 1 }) : undefined,
  };
}
module.exports = {
  site: SITE,
  featured: () => [{ title: 'Latest English digital volumes', path: pathOf({ language: 'en' }) }],
  async browse(path) {
    if (!path) return { title: 'RanobeDB', folders: [
      { title: 'Latest English digital volumes', path: pathOf({ language: 'en' }) },
      { title: 'Browse English series', path: pathOf({ type: 'series', language: 'en', sort: 'Title asc' }) },
      { title: 'Japanese digital volumes', path: pathOf({ language: 'ja' }) },
    ], books: [] };
    let state;
    try { state = JSON.parse(path); } catch { throw new Error('Invalid catalogue page.'); }
    return listing(state);
  },
  search: query => listing({ text: query.text, language: query.filters?.language?.[0] || 'en', sort: query.sort || 'Relevance desc' }),
  searchOptions: () => ({ sorts: [{ id: 'Relevance desc', label: 'Relevance' }, { id: 'Release date desc', label: 'Newest' }, { id: 'Title asc', label: 'Title A–Z' }], filters: [{ id: 'language', title: 'Edition language', options: [{ id: 'en', label: 'English' }, { id: 'ja', label: 'Japanese' }, { id: 'all', label: 'All languages' }] }] }),
  async details(id) {
    const data = await api('/book/' + validId(id));
    const b = data.book || data;
    if (!b.title || b.hidden) throw new Error('This book is unavailable in RanobeDB.');
    const author = [...new Set((b.editions || []).flatMap(e => e.staff || []).filter(s => s.role_type === 'author').map(s => s.romaji || s.name))].join(', ');
    // A series-level fallback finds collection torrents that don't name every volume.
    const titles = [b.title, ...(b.titles || []).filter(t => t.lang === b.lang).map(t => t.title), b.romaji, b.romaji_orig, b.series?.title, b.series?.romaji, b.series?.romaji_orig].filter(Boolean);
    const date = String(b.c_release_dates?.[b.lang] || b.c_release_date || '');
    return {
      ...book(b), author, description: b.description || b.description_ja,
      language: b.lang, published: /^\d{8}$/.test(date) ? date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6) : undefined,
      tags: (b.series?.tags || []).map(t => t.name), webUrl: SITE + '/book/' + id,
      related: b.series ? [{ title: 'Volumes in ' + b.series.title, path: pathOf({ series: b.series.id, language: b.lang }) }] : [],
      files: [], attribution: ATTRIBUTION,
      downloadSearch: { extensionId: 'nyaa', queries: [...new Set(titles)], category: b.lang === 'ja' ? '3_3' : b.lang === 'en' ? '3_1' : '3_2', bookType: 'books' },
    };
  },
};
