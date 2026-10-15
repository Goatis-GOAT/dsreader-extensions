# DSReader extensions

Install modules independently from DSReader's Extensions screen. The format reference is in `dsreader/docs/extensions.md`.

- Wikisource supplies public-domain books.
- **Global Grey 1.0** supplies classic books as direct EPUB/PDF downloads, with covers, descriptions, category pagination and author browsing. Search uses a public sitemap cached for 24 hours and fetches matching book pages for their actual metadata (12 results per page, at most three requests at once). Author search uses hints available in the sitemap; the Authors directory is also available. EPUB is preferred; AZW3 is omitted because DSReader does not support it. Book files are fetched only when the user chooses a download. Please support the original site at [Global Grey](https://www.globalgreyebooks.com/donate.html).
- Z-Library supplies EPUB/PDF books with automatic domain discovery and a personal on-device sign-in session. Open a book and use **Sign In** when prompted, then tap Done and retry. Downloads count against the account's allowance; search and cover loading do not download books. Account limits and transfer speed are enforced by the service. Requires the DSReader update that supports deferred files and source sign-in. Use content you are authorised to download.
- Nyaa supplies release discovery and magnet links. It opens on new uploads; keywords, categories and book-type filters live in Search. TorBox is optional and handled by the app.
- **RanobeDB Covers 1.1** is an optional image library. It supplies covers without appearing in Sources or global book search. Open **Manage covers** in Extensions to fill missing covers on existing library books. New imports without embedded covers also use installed image libraries.

Nyaa declares RanobeDB as an optional cover provider. Install both from this repository and refresh/update RanobeDB to use the image-library role. Matching uses normalized exact title/volume identities, skips ambiguous and collection releases, and preserves existing covers and bibliographic metadata. Lookup failures leave discovery and imports usable.

Configure your personal TorBox key in **More → Download services**. **More → Downloads** lists supported EPUB/PDF/CBZ/ZIP files across the TorBox account, including individual volumes in collections. A tick means the file has been imported on this device. Embedded front covers take priority after import. Neither extension receives the TorBox key or relay credential.

RanobeDB cover lookup defaults to English digital editions; Japanese lookups are supported. Metadata is cached for five minutes, bounded to 40 requests, and requests are spaced below the provider's requested 60/minute. Known adult/spoiler covers are omitted.

Metadata attribution: [RanobeDB](https://ranobedb.org/), [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/) and [Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/). The [public API](https://ranobedb.org/api/docs/v0) is restricted to non-commercial use. Commercial deployment needs provider permission or a separately assessed data-dump implementation. Book texts and torrent content are not bundled.

`npm test` runs deterministic metadata/RSS tests and the actual DSReader WebView runtime protocol. `npm run test:live -- ranobedb "search words"` checks cover lookup; `npm run test:live -- nyaa "public domain"` checks RSS without submitting torrents. Nyaa still needs a reachable direct connection or optional relay; image libraries do not bypass an upstream block.

Serve this folder from your extension repository host, refresh the repository in the app, and install/update the modules. Local changes are not visible at the GitHub repository URL until published.

Global Grey was implemented entirely in this extension repository using DSReader's existing runtime; it requires no app code changes. Run `npm run test:live -- globalgrey "pride and prejudice"` for a live catalogue smoke test. `npm run test:globalgrey:live` also checks categories, authors, pagination, title/author search and the signatures of one EPUB and one PDF downloaded into memory only. The deterministic `npm test` includes malformed responses, unsafe links, caching, search pagination and a load/invoke test against the existing DSReader WebView runtime. No account, TorBox or relay is required.

## Adapting a source

Nyaa 2.2.0 and Z-Library 1.1.0 declare their host integrations in `index.json`. Their JavaScript still owns site requests, parsing and search behaviour. DSReader has no source-ID branches, baked-in domain lists or site-specific login endpoints for these modules.

To target a similar site, copy the module, give its repository entry a new ID/name/script, adapt its URLs and parsing, then update that entry's `integration` origins and page/account/feed rules. Both the script and metadata belong to the extension repository; no app code changes are needed for compatible protocols. The full field reference and migration notes are in `dsreader/docs/extensions.md`. The optional relay operator must separately add the new feed to `UPSTREAM_RULES`.

Update DSReader and these extensions together. Sign in again after the upgrade: old globally stored sessions are not copied into the new per-source, per-origin credential stores. JavaScript support for Paperback and LNReader is retained.

### The Liberty Archive

The `libertyarchive` release extension discovers historic Books, Journals and Media collection torrents from https://freecapitalists.org/torrents/. It searches archive labels and filenames from torrent metadata, then returns the whole collection with its real infohash and payload size. It does not offer individual-book torrents or claim live peer counts. Books is the default category; Journals and All archive collections are available. The readable filter includes collections containing EPUB, PDF or CBZ files. Mixed media collections can appear if they contain readable books; audio and video files cannot be imported. PDF torrent imports require the updated DSReader app.

Discovery downloads only the listing and torrent metadata, cached for 15 minutes. Payload downloads happen through the existing TorBox flow after selection. No Liberty-specific app code or credentials are needed. Run `npm run test:libertyarchive:live` to check public metadata without submitting torrents or downloading book payloads.
