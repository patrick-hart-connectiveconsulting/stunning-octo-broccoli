# Media Manager: Specification

**Version:** 0.2.0 (draft) · **Status:** implemented, as described below · **Runtime:** Node.js ≥ 20, no dependencies

Media Manager is a lightweight, self-hosted alternative to a headless CMS, modeled on Strapi. It has two modules:

1. **Media Library**: upload, organize and serve files (images, video, audio, documents).
2. **Streams**: you define event endpoints in the admin UI. Each stream has its own **dataset** (a list of typed fields). Clients post **events** to it, and can fetch events, filter them, or subscribe to them live.

Both modules share one server, one admin UI, one API token and one data directory.

---

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Stream** | A named event endpoint, e.g. `order-events`. It owns a dataset definition and an ordered log of events. Clients reach it at `/api/streams/<slug>`. |
| **Slug** | The URL identifier of a stream: 1–64 chars of `a–z`, `0–9` and `-`, not starting or ending with `-`. It is derived from the name if you don't give one. **It can't be changed after creation**, because every client URL contains it. |
| **Dataset** | The list of **fields** a stream's events must match. An empty dataset means the stream is *schema-less* and accepts any JSON object. |
| **Field** | `{ name, type, required, …type options }`. See §3. |
| **Event** | One record in a stream: a `data` object that matches the dataset, plus a `timestamp` and system metadata. |
| **Sequence (`seq`)** | A number that goes up by one for each event in a stream (1, 2, 3, …) and never repeats, even after deletes or restarts. Clients use it for polling and for resuming a live feed. |
| **Media file** | An uploaded file in the Media Library. A `media` field in a stream refers to one by its `id`. |

## 2. Access & conventions

- **Base URL:** `http://<host>:<port>` (default port `1338`).
- **Auth:** all `GET` requests are public. Every other method (`POST`, `PUT`, `PATCH`, `DELETE`) needs `Authorization: Bearer <MEDIA_API_TOKEN>` when the server has a token configured. A wrong or missing token returns `401`. If no token is configured, writes are open; that is meant for local development only.
- **Content type:** request and response bodies are JSON (`application/json`). Media uploads are `multipart/form-data`.
- **Timestamps:** ISO 8601 in UTC, e.g. `2026-11-12T20:35:39.359Z`. The API accepts any string `Date` can parse, or epoch milliseconds, and always returns the normalized form.
- **IDs:** UUID v4 strings.
- **Body size limits:** 1 MB for stream definitions and 10 MB for event requests. Media uploads are capped per file by `MEDIA_MAX_FILE_SIZE`.

### 2.1 List responses

```json
{
  "data": [ … ],
  "meta": { "pagination": { "page": 1, "pageSize": 25, "pageCount": 4, "total": 87 } }
}
```

`page` starts at 1. If `page` is past the last page, `data` comes back empty.

### 2.2 Errors

```json
{
  "error": {
    "status": 400,
    "message": "Validation failed",
    "details": {
      "errors": [
        { "path": "data.total", "message": "is required" },
        { "path": "data.status", "message": "must be one of: pending, paid, shipped" }
      ]
    }
  }
}
```

| Status | When |
| --- | --- |
| `400` | Invalid JSON, a validation failure, an unknown filter or sort field, or an attempt to change a slug. `details.errors` lists **every** problem, not just the first. |
| `401` | Missing or invalid API token on a write. |
| `404` | The stream, event, file or folder doesn't exist, or the route doesn't exist. |
| `405` | The method isn't supported on this route. |
| `409` | A duplicate stream slug or folder name, or deleting a folder that isn't empty. |
| `413` | The body is larger than the limit. |
| `500` | Unexpected server error. The details are logged on the server and not exposed. |

In a batch, the paths are prefixed with the item's index: `[3].data.total`.

---

## 3. Field types

| Type | Accepts | Options | Stored as |
| --- | --- | --- | --- |
| `string` | JSON string | `maxLength` (default 255) | string |
| `text` | JSON string | `maxLength` (default 100 000) | string |
| `integer` | Whole JSON number | `min`, `max` | number |
| `number` | Finite JSON number | `min`, `max` | number |
| `boolean` | `true` / `false` | none | boolean |
| `datetime` | ISO 8601 string or epoch ms | none | ISO 8601 UTC string |
| `enum` | One of `options` | `options` (1–200 strings, required) | string |
| `json` | Any JSON value | none | as sent |
| `media` | The `id` of an existing media file | none | string (UUID) |

Every field can also have `required` (default `false`) and an optional `description` (≤ 500 chars).

**Field names:** they start with a letter or `_`, may contain only letters, digits and `_`, and are at most 64 characters. Names must be unique within a stream, ignoring case. A stream can have at most 100 fields.

### 3.1 Validation rules

For streams that have fields:

1. A key in `data` that isn't a field is rejected.
2. A missing value, `null` or `""` counts as empty. Empty is an error if the field is `required`; otherwise it is stored as `null`. Every field is therefore present in stored events.
3. Values are **not** converted between types. For example `"42"` is rejected for an `integer` field. The one exception is `datetime`, which is normalized to UTC ISO.
4. A `media` value must be the id of a file that exists *at the time the event is written*. If the file is deleted later, the event keeps the now-dangling id.

Schema-less streams accept any JSON **object** (not an array or primitive) as `data`.

### 3.2 Changing a dataset

You can add, remove, reorder or retype fields at any time with `PATCH /api/streams/:slug`. **Existing events are not migrated.** They keep their stored data exactly as written. New fields aren't backfilled, and data for removed fields isn't deleted. The new dataset is enforced on events that are created, and on events that are edited with `PUT` or `PATCH`.

---

## 4. Streams API

### 4.1 Endpoint summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/streams` | List streams |
| `POST` | `/api/streams` | **Create a stream** |
| `GET` | `/api/streams/:slug` | Get a stream's definition and stats |
| `PUT` / `PATCH` | `/api/streams/:slug` | Update name, description or fields |
| `DELETE` | `/api/streams/:slug` | Delete a stream **and all its events** |
| `POST` | `/api/streams/:slug` | **Create an event** (shortcut, same as `POST …/events`) |
| `GET` | `/api/streams/:slug/schema` | JSON Schema (2020-12) of the event `data` |
| `GET` | `/api/streams/:slug/events` | List, filter, sort and paginate events |
| `POST` | `/api/streams/:slug/events` | Create one event, or a batch (array) |
| `GET` | `/api/streams/:slug/events/:id` | Get an event |
| `PUT` | `/api/streams/:slug/events/:id` | Replace an event's `data` |
| `PATCH` | `/api/streams/:slug/events/:id` | Update some of an event's `data` fields |
| `DELETE` | `/api/streams/:slug/events/:id` | Delete an event |
| `GET` | `/api/streams/:slug/subscribe` | Live feed (Server-Sent Events) |

### 4.2 Stream object

```json
{
  "id": "1fcc755e-085a-46c5-992a-6450e705efb0",
  "slug": "order-events",
  "name": "Order events",
  "description": "Orders placed on the web shop",
  "fields": [
    { "name": "orderId", "type": "string", "required": true, "maxLength": 255 },
    { "name": "total",   "type": "number", "required": true, "min": 0 },
    { "name": "status",  "type": "enum",   "required": true, "options": ["pending", "paid", "shipped"] },
    { "name": "gift",    "type": "boolean","required": false }
  ],
  "eventCount": 4,
  "lastEventAt": "2026-11-12T20:35:39.359Z",
  "createdAt": "2026-11-12T20:30:00.000Z",
  "updatedAt": "2026-11-12T20:31:12.000Z"
}
```

`eventCount` and `lastEventAt` are computed when the stream is read. `lastEventAt` is the latest event **timestamp**, which is not necessarily the time the latest event was received.

### 4.3 Create a stream: `POST /api/streams`

| Body field | Required | Notes |
| --- | --- | --- |
| `name` | yes | ≤ 100 chars |
| `slug` | no | Derived from `name` if omitted (`"Order events"` → `order-events`) |
| `description` | no | ≤ 1000 chars |
| `fields` | no | Array of field definitions (§3). Omit it or send `[]` for a schema-less stream. |

The response is `201` with the stream object. A duplicate slug returns `409`.

### 4.4 Update a stream: `PUT|PATCH /api/streams/:slug`

Both methods do a partial update: only the keys you send change. The updatable keys are `name`, `description` and `fields`. Sending a `fields` array replaces the whole dataset. Sending a `slug` that differs from the current one returns `400`.

### 4.5 Delete a stream: `DELETE /api/streams/:slug`

Permanently deletes the stream and its event log. The response is `200` with the stream as it was just before deletion. Live subscribers get a `stream-deleted` message and are then disconnected.

### 4.6 List streams: `GET /api/streams`

Query: `q` (case-insensitive match on the name or slug), `page`, `pageSize` (default 100, max 500). The list is sorted by name.

---

## 5. Events API

### 5.1 Event object

```json
{
  "id": "0b7c3a3e-5f8e-4c0a-9a53-0d6f1b0a9f11",
  "seq": 42,
  "stream": "order-events",
  "timestamp": "2026-11-12T20:35:39.359Z",
  "data": { "orderId": "A-100", "total": 42.5, "status": "paid", "gift": null },
  "createdAt": "2026-11-12T20:35:39.360Z",
  "updatedAt": "2026-11-12T20:35:39.360Z"
}
```

- `timestamp` is **when the event happened**. The client can set it, and it defaults to the time the server received the event. Time-range filters and the default sort use it.
- `createdAt` and `updatedAt` are when the server stored or last changed the event. The server sets them.
- `seq` is assigned when the event is created and doesn't change when it is edited.

### 5.2 Create: `POST /api/streams/:slug/events` (or `POST /api/streams/:slug`)

**Single event:**

```json
{ "data": { "orderId": "A-100", "total": 42.5, "status": "paid" }, "timestamp": "2026-11-12T09:00:00Z" }
```

`timestamp` is optional. The response is `201` with the event.

**Batch:** send an array of the same objects, up to 1000.

```json
[
  { "data": { "orderId": "B-1", "total": 10, "status": "pending" } },
  { "data": { "orderId": "B-2", "total": 20, "status": "paid" }, "timestamp": "2026-11-12T09:05:00Z" }
]
```

The response is `201` with an array of events in the order you sent them, with consecutive `seq` values. A batch is **all-or-nothing**: if any item is invalid, the request returns `400`, nothing is stored, and the error paths say which items failed (`[1].data.total`).

The event fields must be inside `data`. A body like `{ "orderId": "A" }` is rejected with a hint to wrap the fields in `data`.

### 5.3 List: `GET /api/streams/:slug/events`

| Parameter | Example | Behavior |
| --- | --- | --- |
| `page`, `pageSize` | `page=2&pageSize=100` | Default `pageSize` is 25, max 500 |
| `sort` | `sort=timestamp:desc` | Key: `timestamp`, `createdAt`, `updatedAt`, `seq` or `data.<field>`. Direction: `:asc` (default) or `:desc`. Without `sort`, the order is `timestamp:desc`, or `seq:asc` when `after` is set. Events with no value for the sort field (`null`) always come last. Ties are broken by `seq`. |
| `since` | `since=2026-11-01T00:00:00Z` | `timestamp ≥ since` |
| `until` | `until=2026-12-01T00:00:00Z` | `timestamp < until` (excludes the boundary, so consecutive windows don't overlap) |
| `after` | `after=42` | `seq > 42`. Use it for polling (§5.6). |
| `filter[<field>]` | `filter[status]=paid` | Equals |
| `filter[<field>][<op>]` | `filter[total][gte]=100` | Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `in` |

Filter details:

- The query value is converted to the field's type: numbers for `integer` and `number`, `true`/`false` for `boolean`, and ISO for `datetime`. In schema-less streams the type is guessed from the stored value.
- `contains` is a case-insensitive substring match. On `json` fields it searches the serialized JSON.
- `in` takes a comma-separated list: `filter[status][in]=pending,shipped`.
- `gt`, `gte`, `lt` and `lte` never match `null` values.
- All filters must match (they are combined with AND). An unknown field returns `400` on streams that have fields.
- With curl, pass `-g` so the brackets are sent literally, or URL-encode them.

### 5.4 Get / update / delete one event

| Method | Body | Behavior |
| --- | --- | --- |
| `GET …/events/:id` | none | `200` with the event, or `404` |
| `PUT …/events/:id` | `{ "data": {…}, "timestamp"?: … }` | Replaces `data` completely, and the result is validated as a new event would be. `data` is required. |
| `PATCH …/events/:id` | `{ "data"?: {…}, "timestamp"?: … }` | Merges the keys you send into the existing `data`, then validates the result. |
| `DELETE …/events/:id` | none | `200` with the deleted event. The `seq` is not reused. |

### 5.5 Live feed: `GET /api/streams/:slug/subscribe`

A [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream (`text/event-stream`). Like other reads, it's public.

| SSE `event:` | `data:` | `id:` |
| --- | --- | --- |
| `created` | The full event object | the event's `seq` |
| `updated` | The full event object | not set |
| `deleted` | `{ "id", "seq" }` | not set |
| `stream-updated` | The stream object | not set |
| `stream-deleted` | `{ "id", "slug" }`, after which the server closes the connection | not set |

- **Resuming:** on reconnect, browsers send `Last-Event-ID` automatically. Non-browser clients can pass `?after=<seq>`. The server first replays every *currently stored* event with a higher `seq` as `created` messages, then switches to live messages. Updates and deletes that happened while the client was disconnected are **not** replayed; use the list endpoint to reconcile them.
- The server sends `retry: 3000` and a `: ping` comment every 25 s so proxies don't close idle connections.

```js
const es = new EventSource('/api/streams/order-events/subscribe');
es.addEventListener('created', (e) => console.log(JSON.parse(e.data)));
```

### 5.6 Polling pattern

As an alternative to SSE, store the highest `seq` you have seen and call:

```
GET /api/streams/order-events/events?after=<lastSeq>&pageSize=500
```

The results are in ascending `seq` order. Repeat until `data` comes back empty.

### 5.7 JSON Schema: `GET /api/streams/:slug/schema`

Returns a JSON Schema (draft 2020-12) for the event `data` object, generated from the dataset. Optional fields allow `null`. For streams with fields, `additionalProperties` is `false`. Clients can use it for validation or code generation.

---

## 6. Media Library API (summary)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/upload/files` | List files. Query: `q`, `type` (`image`/`video`/`audio`/`file`), `folder` (`root` or id), `sort`, `page`, `pageSize` |
| `GET` | `/api/upload/files/:id` | Get a file |
| `POST` | `/api/upload` | Upload with multipart fields `files` (repeatable), `folder` and `fileInfo` (JSON) |
| `POST` | `/api/upload?id=:id` | Replace a file's binary but keep its id and metadata |
| `PUT` / `PATCH` | `/api/upload/files/:id` | Update `name`, `alternativeText`, `caption`, `folder` |
| `DELETE` | `/api/upload/files/:id` | Delete the file and its binary |
| `GET` / `POST` | `/api/upload/folders` | List folders (`?parent=root|id`) / create a folder `{ name, parent }` |
| `GET` / `PUT` / `DELETE` | `/api/upload/folders/:id` | Get, rename or move, delete (`409` if not empty) |
| `GET` | `/uploads/:file` | Serve the binary. Supports `Range`; add `?download` to download it as an attachment. |

Example file object: `{ id, name, alternativeText, caption, folder, folderPath, hash, ext, mime, size, width, height, url, createdAt, updatedAt }`.

## 7. Other endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/health` | `{ "ok": true }` |
| `GET` | `/api/config` | `{ "authRequired": bool, "maxFileSize": bytes }` (used by the admin UI) |

---

## 8. Admin UI

Served at `/`. No build step.

| Page | Path | Capabilities |
| --- | --- | --- |
| Media Library | `/` | Asset grid with previews; folders and breadcrumbs; search, type filter, sort and pagination; drag-and-drop upload with progress; asset details (rename, alt text, caption, move, replace, download, copy link, delete); bulk move and delete |
| Streams | `/streams.html` | Stream list with search. **Create a stream** with name, slug (auto-generated, editable) and a visual field builder (type, required, enum options, min/max, max length, reorder). **Events tab:** table of events with sortable columns, a field filter, a form for creating and editing events generated from the dataset, delete, and a *Live* toggle that updates the table over SSE. **Dataset tab:** edit name, description and fields; delete the stream (you must type the slug to confirm). **API tab:** endpoint list and copy-paste curl and JavaScript examples for that stream, plus a link to its JSON Schema. |

The selected stream and tab are kept in the URL (`/streams.html?stream=order-events&tab=api`), so links to a stream can be shared. If the server needs a token, the UI asks for it on the first write that gets a `401` and remembers it in `localStorage`.

---

## 9. Storage & operations

```
$MEDIA_DATA_DIR/
├── db.json                 # files, folders and stream definitions (rewritten atomically on each change)
├── uploads/<hash>.<ext>    # media binaries
└── events/<streamId>.jsonl # one append-only log per stream
```

- **Event logs** are append-only JSON Lines. Each change adds one line: `{"op":"put","event":{…}}` or `{"op":"del","id":"…"}`, so writing an event costs a small append. On startup the log is replayed into memory. If replaced and deleted lines outnumber the live events by more than 2×, with a minimum of 1000 lines, the log is rewritten in compact form. If the last line was cut off by a crash, it is skipped.
- **Writes are serialized** within a log and within `db.json`. All reads are served from memory.
- **Backup:** copy the data directory. For a consistent snapshot, stop the server or copy it while no writes are happening.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `1338` / `0.0.0.0` | Listen address |
| `MEDIA_API_TOKEN` | *(unset = writes are open)* | Bearer token for writes |
| `MEDIA_DATA_DIR` | `./data` | Data directory |
| `MEDIA_MAX_FILE_SIZE` | `52428800` | Per-file upload limit in bytes |

## 10. Limits & non-goals (current version)

| Area | Limit / behavior |
| --- | --- |
| Scale | It runs as a single process and keeps everything in memory. It's comfortable up to about 100k events per stream and a few thousand media files. Beyond that, move storage to SQLite or Postgres; the API wouldn't need to change. |
| Auth | There is one shared token with full write access. There are no users, roles, per-stream tokens or read protection. |
| Datasets | No migrations, unique constraints, relations other than `media`, or computed fields. |
| Events | No retention or TTL, and no bulk delete by query. Live replay covers created events only. |
| Media | No thumbnails or responsive image formats, and no cloud storage providers. |
| Rate limiting / CORS | Neither is built in. Put a reverse proxy in front if the API is exposed publicly or used across origins. |

## 11. Possible next steps

- Per-stream API keys (write-only ingest keys and read keys)
- Retention policies (`maxAge`, `maxEvents`) and bulk delete by filter
- Webhooks: POST each new event to a configured URL
- Aggregation endpoint (`count`, `sum`, `avg` grouped by field or time bucket)
- CSV / NDJSON export of a filtered event list
- SQLite storage backend
- OpenAPI document generated from the stream definitions
