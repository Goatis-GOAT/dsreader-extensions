# DSReader extensions

A repository of [DSReader](../dsreader) extensions. DSReader's extension format is built around whole books: the full reference is in `dsreader/docs/extensions.md`.

```
index.json                  the repository: lists the extensions
extensions/wikisource.js    an example: public-domain books from English Wikisource
extensions/ranobedb.js      light novel catalogue, automatically fetched from RanobeDB
extensions/nyaa.js          separate release discovery, optional TorBox handled by the app
test/run.js                 runs an extension in Node, the way DSReader would
```

Install **RanobeDB** and **Nyaa** separately from this repository in DSReader's Extensions screen. RanobeDB appears alongside other book sources. Browse volumes or series, choose a volume, then **Find downloads**. Nyaa appears as a download source and remains usable for standalone searches. Configure your personal TorBox key and optional RSS relay in the app's **Sources** screen; neither script receives either secret.

The former bundled Nyaa toggle is replaced by the installable DSReader module. Install Nyaa from the refreshed repository once after updating the app. Existing TorBox settings and download records are retained; the Nyaa screen also displays earlier Nyaa jobs.

RanobeDB search/browse defaults to English digital editions. Japanese and all-language filters are available. Series are listed with their volumes in provider order. Metadata is cached for five minutes, bounded to 40 requests, and requests are spaced to remain below the provider's requested 60/minute. Cover URLs come from its image service; known adult/spoiler covers are omitted. Torrent matching is user-confirmed, not asserted from a filename.

Metadata attribution: [RanobeDB](https://ranobedb.org/), [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/) and [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/). The [public API](https://ranobedb.org/api/docs/v0) is currently restricted to non-commercial use. Commercial deployment needs provider permission or a separately assessed data-dump implementation; this extension currently uses the public API. Book texts and torrent content are not bundled.

Tests: `npm test` runs deterministic catalogue/RSS tests, including the actual DSReader WebView runtime protocol. `npm run test:live -- ranobedb "search words"` checks the public catalogue; `npm run test:live -- nyaa "public domain"` checks RSS availability without submitting torrents. Live Nyaa requests still depend on a reachable direct connection or configured relay; catalogue browsing does not fix an upstream block.

Serve this folder from your extension repository host, refresh the repository in the app, and install the two modules. Local changes are not visible at the existing GitHub repository URL until published.
