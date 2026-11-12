# Media Manager

A lightweight media library inspired by Strapi's Media Library (upload plugin). It needs only Node.js 20+ and has no `npm install` step or build step.

- **Admin UI**: grid of assets with previews, folders and breadcrumbs, search, type filter, sorting, pagination, drag-and-drop uploads with progress bars, an asset details panel (rename, alt text, caption, move, replace, download, copy link, delete), and bulk move/delete. Light and dark themes.
- **REST API**: Strapi-style `/api/upload` endpoints, so content front-ends can use it the same way.
- **Storage**: files on local disk and metadata in a single JSON file (`data/db.json`), written atomically.

## Run

```bash
cd media-manager
MEDIA_API_TOKEN=change-me npm start     # http://localhost:1338
npm test                                # API test suite (node:test)
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `1338` / `0.0.0.0` | Listen address |
| `MEDIA_API_TOKEN` | *(unset)* | Bearer token required for every write. **If unset, writes are open**, so set it anywhere other than your own machine. |
| `MEDIA_DATA_DIR` | `./data` | Where `db.json` and `uploads/` live |
| `MEDIA_MAX_FILE_SIZE` | `52428800` (50 MB) | Per-file upload limit in bytes |

Reads (listing and fetching files) are public. When a token is configured, the UI asks for it the first time you make a change and remembers it in the browser.

## API

| Method & path | Description |
| --- | --- |
| `GET /api/upload/files` | List files. Query: `q`, `type` (`image`/`video`/`audio`/`file`), `folder` (`root` or id; omit for all), `sort` (`name`/`createdAt`/`updatedAt`/`size` + `:asc`/`:desc`), `page`, `pageSize` (≤100) |
| `GET /api/upload/files/:id` | One file |
| `POST /api/upload` | Multipart upload. Fields: `files` (repeatable), optional `folder`, optional `fileInfo` (JSON object or array of `{name, alternativeText, caption, folder}` matched to the files by position) |
| `POST /api/upload?id=:id` | Replace a file's binary but keep its id and metadata |
| `PUT /api/upload/files/:id` | Update `name`, `alternativeText`, `caption`, `folder` |
| `DELETE /api/upload/files/:id` | Delete the file record and its binary |
| `GET /api/upload/folders` | List folders (`?parent=root\|id` to filter), with path and child counts |
| `GET/PUT/DELETE /api/upload/folders/:id` | Get, rename/move, or delete a folder. Deleting a folder that still has contents returns `409` |
| `POST /api/upload/folders` | Create a folder `{name, parent}` |
| `GET /uploads/:file` | The binary itself. Supports `Range` requests; add `?download` to get it as an attachment |

```bash
curl -H "Authorization: Bearer $MEDIA_API_TOKEN" \
  -F files=@hero.jpg -F 'fileInfo={"alternativeText":"Team photo"}' \
  http://localhost:1338/api/upload
```

## Notes and limits

- Stored files get random names (`/uploads/<32 hex>.<ext>`). Uploaded HTML and SVG are served with a sandboxing CSP and `nosniff`, so they can't run scripts on this origin.
- Image dimensions are read from file headers for PNG, JPEG, GIF, WebP, BMP and SVG. It does **not** generate thumbnails or responsive formats; the grid shows the original images, lazy-loaded.
- It runs as one process with an in-memory index, which suits up to a few thousand assets. Uploads are buffered in memory per request.
