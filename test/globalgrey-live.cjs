// Explicit network smoke test; not part of the deterministic npm test suite.
// Downloads two small public book files into memory only, never into the repository.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const cheerio = require('cheerio');
const SITE = 'https://www.globalgreyebooks.com';
const state = new Map();
let requests = 0;
const request = async (url, init = {}) => {
  requests++;
  return fetch(url, { ...init, signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'DSReader-GlobalGrey-extension-test/1.0', ...init.headers } });
};
const moduleObject = { exports: {} };
const api = { fetch: request, storage: { get: key => state.get(key), set: (key, value) => state.set(key, value) } };
new Function('require', 'module', 'exports', fs.readFileSync(path.join(__dirname, '../extensions/globalgrey.js'), 'utf8'))(name => name === 'cheerio' ? cheerio : name === 'dsreader' ? api : assert.fail(name), moduleObject, moduleObject.exports);
const extension = moduleObject.exports;
async function download(file) {
  const response = await request(file.url);
  assert.equal(response.status, 200, `${file.format}: HTTP ${response.status}`);
  assert.equal(new URL(response.url).origin, SITE);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 12 * 1024 * 1024) throw Error('Live test download exceeded 12 MiB.');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  if (file.format === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  else {
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.ok(bytes.includes(Buffer.from('META-INF/container.xml')));
    assert.ok(bytes.includes(Buffer.from('application/epub+zip')));
  }
  return { format: file.format, status: response.status, bytes: bytes.length, signatureValid: true };
}
(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../index.json'), 'utf8'));
  assert.equal(manifest.extensions.find(e => e.id === 'globalgrey').script, 'extensions/globalgrey.js');
  const root = await extension.browse(null); assert.ok(root.books.length && root.folders.length);
  const featured = [];
  for (const section of extension.featured()) {
    const listing = await extension.browse(section.path); assert.ok(listing.books.length, section.title);
    featured.push({ title: section.title, count: listing.books.length });
  }
  const categories = await extension.browse('/ebook-categories.html'); assert.ok(categories.folders.length);
  const authors = await extension.browse('/authors.html'); assert.ok(authors.folders.length);
  const fiction = await extension.browse('/category/ebooks/fiction-page-1.html'); assert.ok(fiction.next);
  const next = await extension.browse(fiction.next); assert.ok(next.books.length);
  const author = await extension.browse('/jane-austen-books.html'); assert.ok(author.books.length);
  const found = await extension.search({ text: process.argv[2] || 'pride and prejudice' }); assert.ok(found.books.length);
  const byAuthor = await extension.search({ text: 'jane austen' }); assert.ok(byAuthor.books.length);
  const newest = await extension.details(root.books[0].id); assert.ok(newest.files.length);
  const details = await extension.details(found.books[0].id);
  const downloads = [];
  for (const format of ['epub', 'pdf']) {
    const file = details.files.find(f => f.format === format); assert.ok(file, `Missing ${format}`);
    downloads.push(await download(file));
  }
  console.log(JSON.stringify({ rootBooks: root.books.length, featured, categories: categories.folders.length, authors: authors.folders.length,
    categoryPagination: true, authorBooks: author.books.length, searchMatches: found.books.length, authorSearchMatches: byAuthor.books.length,
    newestBook: { title: newest.title, formats: newest.files.map(f => f.format) },
    book: { title: details.title, author: details.author }, downloads, requests }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
