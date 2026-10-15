// Public listing and .torrent metadata only; never submits a torrent or downloads payloads.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { load, SITE } = require('./libertyarchive-fixture.cjs');
const downloaded = [];
const { extension } = load(async pathname => {
  assert.ok(pathname === '/torrents/' || /^\/torrents\/files\/[^/]+\.torrent$/.test(pathname));
  const response = await fetch(SITE + pathname, { signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200);
  if (pathname === '/torrents/') return response.text();
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length < 4000000);
  // Independently locate the original info dictionary using a bencode scanner.
  let offset = 0, info;
  function scan() {
    const token = String.fromCharCode(bytes[offset]);
    if (/\d/.test(token)) {
      const colon = bytes.indexOf(58, offset), count = Number(bytes.subarray(offset, colon).toString());
      const start = colon + 1; offset = start + count; return bytes.subarray(start, offset).toString();
    }
    offset++;
    if (token === 'i') { offset = bytes.indexOf(101, offset) + 1; return; }
    while (bytes[offset] !== 101) {
      if (token === 'd') scan();
      scan();
    }
    offset++;
  }
  assert.equal(bytes[offset++], 100);
  while (bytes[offset] !== 101) {
    const key = scan(), start = offset; scan();
    if (key === 'info') info = bytes.subarray(start, offset);
  }
  assert.ok(info);
  downloaded.push({ pathname, hash: crypto.createHash('sha1').update(info).digest('hex'), bytes: bytes.length });
  return bytes;
});
(async () => {
  const result = await extension.releaseSearch({ category: 'all' });
  assert.ok(result.releases.some(r => r.categoryId === 'books'));
  assert.ok(result.releases.some(r => r.categoryId === 'journals'));
  for (const release of result.releases) {
    assert.ok(downloaded.some(d => d.hash === release.infoHash));
    assert.match(extension.downloadInfo(release).magnet, new RegExp(release.infoHash));
    assert.ok(release.size > 0);
  }
  console.log(JSON.stringify({ releases: result.releases.map(r => ({ name: r.name, size: r.size, infoHash: r.infoHash })), metadata: downloaded }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
