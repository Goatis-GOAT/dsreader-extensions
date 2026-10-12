// Example DSReader extension: public-domain books from English Wikisource.
//
// It shows both ways a DSReader extension can deliver a whole book:
//   files    — a ready-made EPUB (Wikisource's export tool builds one for any work)
//   contents — the book's subpages ("Pride and Prejudice/Chapter 1", …), which DSReader fetches
//              through section() and puts together into one EPUB itself
//
// See the format reference: docs/extensions.md in the DSReader app.

const { fetchJson, absolute } = require('dsreader');
const cheerio = require('cheerio');

const SITE = 'https://en.wikisource.org';
const API = `${SITE}/w/api.php`;

/** MediaWiki API call (anonymous, CORS-free since DSReader makes the request). */
function api(params) {
  const query = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  return fetchJson(`${API}?${query}`);
}

/** A page's rendered HTML, as cheerio. */
async function page(title) {
  const res = await api({ action: 'parse', page: title, prop: 'text', redirects: '1', disableeditsection: '1' });
  if (res.error) throw new Error(res.error.info);
  const $ = cheerio.load(res.parse.text);
  // Inline styles and the "sister projects" box aren't part of the book.
  $('style, link, .plainSister, [class*="sister"]').remove();
  return $;
}

/**
 * The work's own subpages, in the order its main page links them (its table of contents). Only
 * the deepest ones: "Volume 1" is skipped when "Volume 1/Chapter 1" is there.
 */
function subpages($, title) {
  const prefix = `/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}/`;
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href').split('#')[0];
    if (!href.startsWith(prefix) || seen.has(href)) return;
    seen.add(href);
    const id = decodeURIComponent(href.slice('/wiki/'.length)).replace(/_/g, ' ');
    out.push({ id, title: id.slice(title.length + 1).replace(/\//g, ' · ') });
  });
  return out.filter((p) => !out.some((q) => q.id.startsWith(`${p.id}/`)));
}

/** Category members (works only) as books. */
async function category(name, cont) {
  const res = await api({ action: 'query', list: 'categorymembers', cmtitle: `Category:${name}`, cmnamespace: '0', cmlimit: '50', ...(cont ? { cmcontinue: cont } : {}) });
  return {
    books: res.query.categorymembers.filter((m) => !m.title.includes('/')).map((m) => ({ id: m.title, title: m.title })),
    next: res.continue ? JSON.stringify({ category: name, cont: res.continue.cmcontinue }) : undefined,
  };
}

module.exports = {
  site: SITE,

  /** Rows on the source's front page. Each path is handed back to browse(). */
  featured() {
    return [
      { title: 'Novels', path: JSON.stringify({ category: 'Novels' }) },
      { title: 'Short stories', path: JSON.stringify({ category: 'Short stories' }) },
      { title: 'Poetry', path: JSON.stringify({ category: 'Poems' }) },
    ];
  },

  /** A listing: no path is the top level. Paths are whatever strings you like. */
  async browse(path) {
    if (!path) return { folders: this.featured(), books: [] };
    const p = JSON.parse(path);
    const { books, next } = await category(p.category, p.cont);
    return { title: p.category, books, next };
  },

  async search({ text }) {
    const res = await api({ action: 'query', list: 'search', srsearch: text, srnamespace: '0', srlimit: '30' });
    // Search finds chapters too; list each work once, by its main page.
    const titles = [...new Set(res.query.search.map((r) => r.title.split('/')[0]))];
    return { books: titles.map((t) => ({ id: t, title: t })) };
  },

  /** One book: what it is, and how to get all of it. */
  async details(id) {
    const $ = await page(id);
    const author = $('.wst-header-author a, #header_author_text a').first().text().trim() || undefined;
    const notes = $('.wst-header-notes, #header_notes').first().text().trim() || undefined;
    const contents = subpages($, id);
    return {
      title: id,
      author,
      description: notes,
      language: 'en',
      webUrl: `${SITE}/wiki/${encodeURIComponent(id.replace(/ /g, '_'))}`,
      // A ready-made EPUB from Wikisource's own export tool.
      files: [{ label: 'EPUB from Wikisource', format: 'epub', url: `https://ws-export.wmcloud.org/?format=epub&lang=en&page=${encodeURIComponent(id)}` }],
      // The subpages, for DSReader to put together. A work on a single page is its own contents.
      contents: contents.length ? contents : [{ id, title: id }],
    };
  },

  /** One part of a book, as HTML. DSReader makes it safe, fetches its pictures, and adds a heading. */
  async section(bookId, sectionId) {
    const $ = await page(sectionId);
    // Wikisource's navigation header and footer aren't part of the text.
    $('.ws-noexport, .wst-header-structure, #headertemplate, .mw-references-wrap, .noprint').remove();
    $('a[href]').each((_, a) => $(a).attr('href', absolute($(a).attr('href'), SITE)));
    return { html: $('.mw-parser-output').html() || $.html(), url: SITE };
  },
};
