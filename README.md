# DSReader extensions

A repository of [DSReader](../dsreader) extensions. DSReader's extension format is built around whole books: the full reference is in `dsreader/docs/extensions.md`.

```
index.json                  the repository: lists the extensions
extensions/wikisource.js    an example: public-domain books from English Wikisource
test/run.js                 runs an extension in Node, the way DSReader would
```

## Try it

```sh
npm install
node test/run.js wikisource-en "pride and prejudice"
```

## Publish

1. Push this folder to a public GitHub repository.
2. In DSReader, open **More → Extensions → +** and paste
   `https://raw.githubusercontent.com/<you>/<repo>/main/index.json`
3. Tap **Get** on an extension. It shows up under **Sources**.

Bump an extension's `version` in `index.json` every time you change it, otherwise DSReader won't offer the update.

## Write your own

Copy `extensions/wikisource.js`, add an entry for it to `index.json`, and fill in:

- `browse(path)`: lists of books (`{ id, title, author, cover }`)
- `details(id)`: one book, with `files` (whole downloads) and/or `contents` (parts DSReader puts together)
- `section(bookId, sectionId)`: one part's HTML (or comic pages), only needed for `contents`
