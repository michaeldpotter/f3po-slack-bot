# RAG and Vector Store

This project uses Retrieval-Augmented Generation. The bot is not trained on repo files; it searches the OpenAI vector store and gives relevant snippets to the model at answer time.

```text
Folder = source of truth
Vector store = disposable search index
Bot = Slack interface to search + answer
```

## Source Folders

Put source documents in `vectorstore/`.

```text
vectorstore/
  F3 Nation Documents/      committed
  F3 Wichita Documents/     ignored
logs/
  .gitkeep                  committed
  f3po-YYYY-MM-DD.log       ignored
export/youtube/             ignored raw YouTube metadata/captions
export/google/              ignored Google/BigQuery scratch/review exports
```

Supported file extensions:

```text
.md, .txt, .pdf, .docx, .html, .csv, .json
```

## Add Changed Docs

Use this for normal document maintenance:

```sh
npm run rag:add
```

`rag:add` uses the current `VECTOR_STORE_ID` from `.env`. New or changed files are uploaded and tagged with their source path and content hash. If a local file changed, the old vector store entry for that source path is removed and the updated file is uploaded.

If you delete a local source file, run prune to remove the deleted source from the existing vector store:

```sh
npm run rag:prune
```

You can also add from a specific folder:

```sh
npm run rag:add -- "./vectorstore/F3 Nation Documents"
```

## Rebuild

Use rebuild when you want a fresh vector store:

```sh
npm run rag:rebuild
```

The script:

1. Finds supported documents in `VECTOR_STORE_SOURCE_DIR`.
2. Uploads them to OpenAI file storage.
3. Creates a new OpenAI vector store.
4. Adds the uploaded files to that vector store.
5. Waits for indexing.
6. Updates `VECTOR_STORE_ID` in `.env`.
7. Restarts `VECTOR_STORE_RESTART_SERVICE` on Linux when systemd is available.

You can pass a folder explicitly:

```sh
npm run rag:rebuild -- ./vectorstore
npm run rag:rebuild -- "./vectorstore/F3 Nation Documents"
```

Ingest paths are guarded. By default, `scripts/rag-setup.js` only accepts folders inside `vectorstore` so accidental commands do not upload unintended files. To ingest a folder outside `vectorstore`, pass `--force`:

```sh
npm run rag:rebuild -- ~/Documents/f3-docs --force
```

Direct usage:

```sh
node scripts/rag-setup.js --help
node scripts/rag-setup.js rebuild ./vectorstore
node scripts/rag-setup.js add ./vectorstore
node scripts/rag-setup.js prune ./vectorstore
```
