# YouTube Export

The YouTube exporter builds a searchable markdown index from the F3 Wichita YouTube channel metadata and available English captions.

## Requirements

- `yt-dlp` installed locally
- Network access to YouTube

## Run

Fetch channel metadata/captions and rebuild the local markdown:

```sh
npm run youtube:export
```

Reuse the existing files under `export/youtube/` without fetching:

```sh
npm run youtube:export -- --skip-fetch
```

Use a different channel URL:

```sh
npm run youtube:export -- --channel https://www.youtube.com/@f3wichita/videos
```

The script writes:

```text
export/youtube/                                      ignored
vectorstore/F3 Wichita Documents/f3wichita-youtube.md
```

Review the generated markdown before ingestion, then run:

```sh
npm run rag:add
```
