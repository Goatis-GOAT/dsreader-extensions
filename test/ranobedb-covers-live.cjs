// Explicit public metadata/image smoke test; no torrent or book downloads.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ts = require('../../dsreader/node_modules/typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, f);
const { lookupCovers } = require('../../dsreader/src/sources/releases/presentation.ts');
const data = new Map(), moduleObject = { exports: {} };
const api = {
  storage: { get: k => data.get(k), set: (k, v) => data.set(k, v), getAllKeys: () => [...data.keys()], delete: k => data.delete(k) },
  fetchJson: async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200); return response.json();
  },
};
new Function('require', 'module', 'exports', fs.readFileSync(path.join(__dirname, '../extensions/ranobedb.js'), 'utf8'))(() => api, moduleObject, moduleObject.exports);
(async () => {
  for (const [text, names] of [
    ['Overlord', ['[Group] Overlord v01 (Digital) (Yen Press)', 'Overlord v02 [EPUB]', 'Overlord v01-16 [Complete]']],
    ['Ascendance of a Bookworm', ['Ascendance of a Bookworm Part 1 v01 [EPUB]', 'Ascendance of a Bookworm Part 2 v01 [EPUB]']],
  ]) {
    const releases = names.map((name, i) => ({ id: String(i), name }));
    const covers = await lookupCovers(releases, text, async query => {
      const result = await moduleObject.exports.coverSearch({ text: query, language: 'en' });
      return result.images.map(b => ({ ...b, cover: { uri: b.cover } }));
    });
    for (const release of releases) {
      assert.ok(covers[release.id], 'Missing cover: ' + release.name);
      const response = await fetch(covers[release.id].uri, { method: 'HEAD', signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^image\//);
      console.log(release.name + ' -> ' + covers[release.id].uri);
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
