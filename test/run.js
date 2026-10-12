// Runs a DSReader extension in Node with a stand-in for the app's runtime, so you can try it
// before publishing. Needs Node 18+ and `npm install` (for cheerio).
//
//   node test/run.js <extension id> [search text]
//
// It checks index.json, then calls featured → browse → search → details → the first two
// sections, and prints what DSReader would see.
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const root = path.join(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
if (index.dsreader !== 1) throw new Error('index.json needs "dsreader": 1');

const id = process.argv[2] ?? index.extensions[0]?.id;
const meta = index.extensions.find((e) => e.id === id);
if (!meta) throw new Error(`No extension "${id}" in index.json`);
for (const field of ['id', 'name', 'version', 'script']) if (!meta[field]) throw new Error(`${id}: "${field}" is missing in index.json`);

// What require('dsreader') gives inside the app (see the runtime's dsrLib).
const db = {};
// Like the app, send a browser's user agent (some sites, e.g. Wikimedia, throttle requests without one).
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers } });
async function ok(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`The site answered ${res.status} for ${url}`);
  return res;
}
const dsreader = {
  fetch: (url, init) => fetch(url, init),
  fetchText: async (url, init) => (await ok(url, init)).text(),
  fetchJson: async (url, init) => (await ok(url, init)).json(),
  fetchHtml: async (url, init) => cheerio.load(await (await ok(url, init)).text()),
  absolute: (url, base) => {
    try {
      return new URL(url, base).href;
    } catch {
      return url;
    }
  },
  storage: { get: (k) => db[k]?.value, set: (k, value) => (db[k] = { value }), delete: (k) => delete db[k], getAllKeys: () => Object.keys(db) },
};
const libs = { dsreader, cheerio };
const req = (name) => {
  if (libs[name]) return libs[name];
  throw new Error(`DSReader doesn't provide "${name}" (only dsreader, cheerio, dayjs, htmlparser2)`);
};

const show = (label, value) => console.log(`\n== ${label}\n${JSON.stringify(value, null, 2).slice(0, 1500)}`);

(async () => {
  const code = fs.readFileSync(path.join(root, meta.script), 'utf8');
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', code)(req, module, module.exports, console);
  const ext = module.exports.default || module.exports;
  for (const fn of ['browse', 'details']) if (typeof ext[fn] !== 'function') throw new Error(`The extension must export ${fn}()`);
  console.log(`Loaded ${meta.name} ${meta.version}`);

  const featured = ext.featured ? await ext.featured() : [];
  show('featured()', featured);

  const listing = await ext.browse(featured[0]?.path ?? null);
  show(`browse(${featured[0]?.path ?? 'null'})`, { ...listing, books: listing.books?.slice(0, 5), count: listing.books?.length });

  let books = listing.books ?? [];
  if (process.argv[3]) {
    const found = await ext.search({ text: process.argv[3], filters: {} });
    show(`search("${process.argv[3]}")`, { ...found, books: found.books?.slice(0, 5), count: found.books?.length });
    books = found.books ?? books;
  }
  if (!books.length) throw new Error('No books to try details() on');

  const details = await ext.details(books[0].id);
  show(`details("${books[0].id}")`, { ...details, contents: details.contents?.slice(0, 5), sections: details.contents?.length });
  if (!details.files?.length && !details.contents?.length) throw new Error('details() needs files or contents');

  for (const part of (details.contents ?? []).slice(0, 2)) {
    if (!ext.section) throw new Error('The book has contents, so the extension must export section()');
    const s = await ext.section(books[0].id, part.id);
    const html = typeof s === 'string' ? s : s.html;
    const text = cheerio.load(html ?? '').text().replace(/\s+/g, ' ').trim();
    show(`section("${part.id}")`, s.pages ? { pages: s.pages.slice(0, 3), count: s.pages.length } : { chars: text.length, starts: text.slice(0, 200) });
  }
  console.log('\nAll good.');
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
