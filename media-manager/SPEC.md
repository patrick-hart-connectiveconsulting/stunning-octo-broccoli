# Media Manager: Specification

**Version:** 0.8.1 (draft) · **Status:** implemented, as described below · **Runtime:** Node.js ≥ 20, no dependencies

Media Manager is a lightweight, self-hosted alternative to a headless CMS, modeled on Strapi. It has two modules:

1. **Media Library**: upload, organize and serve files (images, video, audio, documents).
2. **Streams**: named data streams that you define in the admin UI. A stream can hold any kind of record: app **events**, blog **posts**, social posts, **products**, and so on. Each stream has its own **dataset** (a list of typed fields). Clients post **items** to a stream, and can fetch them, filter them, subscribe to changes live, or receive them by webhook.

Both modules share one server, one admin UI, one API token and one data directory.

> **New in 0.8.1 (hardening):** the admin pages send a strict Content-Security-Policy and can't be framed. The admin page and components send tokens and keys in a header on the live feed, never in the URL. Anonymous readers no longer see `publishAt` / `unpublishAt` / `scheduleError`. Oversized bodies get a proper `413` response.
>
> **New in 0.8 (security fixes):** webhook signatures now cover a timestamp (`X-Webhook-Timestamp`; **receivers must update their check**, §8). Webhooks can't reach private network addresses unless allowed. Live feeds have connection and buffer limits and re-check key access on every message. Feed links and `url` fields reject control characters. See the release notes in the pull request for the full list.
>
> **New in 0.7:** the admin **Embed** tab: choose a component for a stream, set its options, see a live preview and copy the code for your website.
>
> **New in 0.6:** the **Streams UI component library**: web components (`<stream-list>`, `<stream-calendar>`, `<stream-map>`…) that show streams on any website as HTML. See §15a and [UI.md](UI.md).
>
> **New in 0.5:** **map pin** (`geopoint`) and **date** field types with map filters, nine new **templates** with schema.org types, **standard output formats** (iCalendar, RSS, JSON Feed, GeoJSON, CSV), `populate` for **media** fields, and **CORS** so websites can call the API from a browser.
>
> **New in 0.4:** **relations** between streams with `?populate`, **per-stream API keys** with scopes, and **scheduled publishing and unpublishing** (`publishAt` / `unpublishAt`). All 0.3 requests still work unchanged.
>
> **Changes from 0.2:** "events" are now called **items**, because a stream can hold any kind of record. `/events` still works as an alias of `/items`. In stream objects, `eventCount` and `lastEventAt` were renamed to `itemCount` and `lastItemAt`. 0.3 adds templates, display labels, draft & publish, new field types, unique constraints, retention and webhooks.

---

## 1. Concepts

| Term | Meaning |
| --- | --- |
| **Stream** | A named endpoint such as `blog` or `app-events`. It owns a dataset, settings, and an ordered log of items. Clients reach it at `/api/streams/<slug>`. |
| **Item** | One record in a stream, for example an event, a post or a product. It is a `data` object that matches the dataset, plus a `timestamp` and system metadata. |
| **Labels** | What an item is called in the admin UI: `{ "singular": "post", "plural": "posts" }`. They only affect display; the API always says "items". |
| **Template** | A starting point for a new stream: Blank, Event log, Blog posts, Social feed or Products. It pre-fills the fields, labels and settings, and you can change all of them afterwards. |
| **Dataset** | The list of **fields** a stream's items must match. An empty dataset means the stream is *schema-less* and accepts any JSON object. |
| **Slug** | The URL identifier of a stream: 1–64 chars of `a–z`, `0–9` and `-`, not starting or ending with `-`. **It can't be changed after creation**, because every client URL contains it. |
| **Draft & publish** | An optional per-stream workflow. Items start as drafts and are hidden from anonymous readers until they are published. |
| **Sequence (`seq`)** | A number that goes up by one for each item in a stream (1, 2, 3, …) and never repeats. Clients use it for polling and for resuming a live feed. |
| **Retention** | Optional per-stream limits on how many items to keep and for how long. |
| **Webhook** | A URL that receives a signed `POST` for each item change. |
| **Relation** | A field whose value is the id (or ids) of items in another stream, or the same stream. Example: a post's `author` pointing at an item in an `authors` stream. |
| **API key** | A credential that works for **one stream** only, with chosen permissions (`read`, `create`, `update`, `delete`). Use it so a device or partner never holds the main token. |
| **Schedule** | A `publishAt` and/or `unpublishAt` time on an item in a draft & publish stream. The server publishes or unpublishes the item when that time comes. |

## 2. Access & conventions

- **Base URL:** `http://<host>:<port>` (default port `1338`).
- **Auth:** there are two kinds of credential, both sent as `Authorization: Bearer <credential>`:

  | Credential | Can do |
  | --- | --- |
  | **Main token** (`MEDIA_API_TOKEN`) | Everything: all streams, stream settings, API keys, webhooks, the media library |
  | **Stream API key** (`mmk_…`) | Only the item operations its scopes allow, on its own stream (§12). It can't change stream settings, keys or webhooks, or reach the media library. |

  Reads are public, with these exceptions:
  - **Drafts** are visible only with the main token or a key with the `read` scope.
  - **Webhook and API key configuration** appears in stream objects only for the main token.
  - For the live feed, which browsers can't send headers to, the credential can be passed as `?access_token=`.
  - If no main token is configured, every request is treated as authorized. That is meant for local development only.
- **Content type:** JSON (`application/json`). Media uploads are `multipart/form-data`.
- **Timestamps:** ISO 8601 in UTC, e.g. `2026-11-12T20:35:39.359Z`. The API accepts any string `Date` can parse, or epoch milliseconds, and always returns the normalized form.
- **IDs:** UUID v4 strings.
- **Body size limits:** 1 MB for stream definitions and 10 MB for item requests. Media uploads are capped per file by `MEDIA_MAX_FILE_SIZE`.

### 2.1 List responses

```json
{ "data": [ … ], "meta": { "pagination": { "page": 1, "pageSize": 25, "pageCount": 4, "total": 87 } } }
```

### 2.2 Errors

```json
{
  "error": {
    "status": 400,
    "message": "Validation failed",
    "details": { "errors": [ { "path": "data.total", "message": "is required" } ] }
  }
}
```

| Status | When |
| --- | --- |
| `400` | Invalid JSON, a body that isn't a JSON object where one is expected, a malformed URL path, an invalid `Host` header, a validation failure (`details.errors` lists **every** problem), an unknown filter or sort field, an attempt to change a slug, or a publish action on a stream without draft & publish |
| `401` | Missing, invalid or expired credential on a write or a draft read, or a stream key used where only the main token is allowed |
| `403` | A valid stream key that lacks the scope this operation needs |
| `404` | The stream, item, webhook, file or folder doesn't exist. Drafts also return `404` to anonymous readers. |
| `405` | The method isn't supported on this route |
| `409` | A duplicate stream slug or folder name, deleting a folder that isn't empty, or deleting a stream other streams relate to |
| `413` | The body is larger than the limit. The server answers, then closes the connection without reading the rest of the body. |
| `500` | Unexpected server error. The details are logged on the server and not exposed. |

In a batch, the paths are prefixed with the item's index: `[3].data.total`.

---

## 3. Field types

| Type | Accepts | Options | Stored as |
| --- | --- | --- | --- |
| `string` | JSON string | `maxLength` (default 255), `unique` | string |
| `text` | JSON string | `maxLength` (default 100 000) | string |
| `richtext` | Markdown string | `maxLength` (default 1 000 000) | string; the API doesn't render it |
| `uid` | Lowercase `a-z`, `0-9` and single hyphens (`my-first-post`) | `targetField`, `maxLength` (≤ 255) | string. **Always unique.** |
| `email` | An email address | `unique` | string |
| `url` | An `http(s)` URL with no spaces or control characters | `unique` | string |
| `integer` | Whole JSON number | `min`, `max`, `unique` | number |
| `number` | Finite JSON number | `min`, `max`, `unique` | number |
| `boolean` | `true` / `false` | none | boolean |
| `datetime` | ISO 8601 string or epoch ms | none | ISO 8601 UTC string |
| `enum` | One of `options` | `options` (1–200 strings, required) | string |
| `tags` | Array of strings | none | array of unique trimmed strings (≤ 100 tags, ≤ 64 chars each); `[]` when empty |
| `json` | Any JSON value | none | as sent |
| `media` | The `id` of an existing media file | none | string (UUID). `?populate` returns the file details (§3.3). |
| `date` | A calendar date `YYYY-MM-DD` | none | string; impossible dates (2026-02-30) are rejected |
| `geopoint` | A map pin: `{ "lat": 51.5, "lng": -0.12, "label": "London" }` | none | object; `lat` −90…90, `lng` −180…180, `label` ≤ 200 chars (optional) |
| `relation` | The id of an item in the `target` stream, or an array of ids when `multiple` | `target` (stream slug, required), `multiple` (default `false`) | string, or array of unique ids (≤ 100); `[]` when empty and `multiple` |

Every field can also have `required` (default `false`) and `description` (≤ 500 chars).

**Field names:** they start with a letter or `_`, may contain only letters, digits and `_`, and are at most 64 characters. Names must be unique within a stream, ignoring case. A stream can have at most 100 fields.

### 3.1 Validation rules

1. A key in `data` that isn't a field is rejected (for streams that have fields).
2. A missing value, `null`, `""` or `[]` counts as empty. Empty is an error if the field is `required` **and the item is being published**. Required fields aren't enforced on drafts (§6). Empty values are stored as `null`, or `[]` for tags.
3. Values are not converted between types. `"42"` is rejected for an `integer` field. `datetime` values are normalized to UTC; tags are trimmed and de-duplicated.
4. `media` must refer to a file that exists when the item is written or published. Likewise, `relation` ids must refer to items that exist in the target stream (drafts included). Unknown ids are reported per field: `no authors item with id …`.

### 3.2 Unique values and UIDs

- `unique: true` (on string, email, url, integer or number fields) and every `uid` field mean that no two items in the stream may hold the same non-empty value. The check is exact and case-sensitive. A clash returns `400` with `"must be unique — another item already uses this value"`.
- A `uid` field with a `targetField` (which must be a `string` or `text` field) is **generated automatically** when left empty: `"Hello World!"` becomes `hello-world`. If that value is taken, the server tries `hello-world-2`, `hello-world-3` and so on. Generated values never cause a clash error, and the suffix is fitted within the field's `maxLength`. Values you provide explicitly do cause a clash error.
- Uniqueness also holds within one batch request.

### 3.3 Relations

```json
{ "name": "author",     "type": "relation", "target": "authors" }
{ "name": "categories", "type": "relation", "target": "categories", "multiple": true }
{ "name": "related",    "type": "relation", "target": "posts", "multiple": true }
```

The third example is a self-relation: a stream can relate to its own items.

- **Writing:** send ids, e.g. `"author": "0b7c…"` or `"categories": ["a1…", "b2…"]`. Duplicate ids are removed.
- **Reading:** items always store and return **ids**. Add `?populate=*` (all relation **and media** fields) or `?populate=author,cover` to a list or get request to replace them with the related items. Media fields become `{ id, name, url, mime, size, width, height, alternativeText, caption }`. Populating goes one level deep, and the related items keep their own relation ids.
- **Visibility when populating:** drafts in the target stream are included only for requesters who can read drafts *in that stream*, meaning the main token or a key for that stream with `read`. Otherwise a single relation becomes `null` and drafts are left out of lists.
- **Filtering:** `filter[author]=<id>` matches a single relation. `filter[categories]=<id>` matches items whose list contains that id, and `[ne]` matches items whose list doesn't.
- **When a related item is deleted**, references to it are removed automatically: single relations become `null`, and the id is taken out of lists. This also applies to deletions by retention. Each changed item is sent as `updated` to subscribers, and to webhooks unless retention caused the deletion. A *required* relation can become empty this way; the item stays as it is but can't be re-published until the field is filled.
- **Deleting a stream** that other streams relate to returns `409`, naming the streams and fields involved. Remove those fields first.
- The target must be an existing stream, or the stream itself.

### 3.4 Changing a dataset

Fields can be added, removed, reordered or retyped at any time. **Existing items are not migrated.** The new dataset is enforced when items are created, edited or published. When an item is edited, data for fields that no longer exist is dropped.

---

## 4. Streams API

### 4.1 Endpoint summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/stream-templates` | List the templates |
| `GET` | `/api/streams` | List streams |
| `POST` | `/api/streams` | **Create a stream** |
| `GET` | `/api/streams/:slug` | Get a stream definition and stats |
| `PUT` / `PATCH` | `/api/streams/:slug` | Update name, description, fields, labels, draft & publish, retention, webhooks |
| `DELETE` | `/api/streams/:slug` | Delete a stream **and all its items** |
| `POST` | `/api/streams/:slug` | **Create an item** (shortcut, same as `POST …/items`) |
| `GET` | `/api/streams/:slug/schema` | JSON Schema (2020-12) of the item `data` |
| `GET` | `/api/streams/:slug/subscribe` | Live feed (Server-Sent Events) |
| `POST` | `/api/streams/:slug/webhooks/:id/test` | Send a `ping` delivery to one webhook |
| `GET` | `/api/streams/:slug/items` | List, filter, sort and paginate items |
| `POST` | `/api/streams/:slug/items` | Create one item, or a batch (array) |
| `GET` | `/api/streams/:slug/items/:id` | Get an item |
| `PUT` | `/api/streams/:slug/items/:id` | Replace an item's `data` |
| `PATCH` | `/api/streams/:slug/items/:id` | Update some of an item's `data` fields |
| `DELETE` | `/api/streams/:slug/items/:id` | Delete an item |
| `POST` | `/api/streams/:slug/items/:id/publish` | Publish (draft & publish streams only) |
| `POST` | `/api/streams/:slug/items/:id/unpublish` | Back to draft |
| `GET` / `POST` | `/api/streams/:slug/keys` | List / create API keys (main token only) |
| `GET` / `PATCH` / `DELETE` | `/api/streams/:slug/keys/:id` | Get, change or revoke a key (main token only) |

`/events` can be used anywhere `/items` appears.

### 4.2 Stream object

```json
{
  "id": "1fcc755e-085a-46c5-992a-6450e705efb0",
  "slug": "blog",
  "name": "Blog",
  "description": "Company blog",
  "template": "blog-posts",
  "labels": { "singular": "post", "plural": "posts" },
  "draftAndPublish": true,
  "retention": { "maxItems": null, "maxAgeDays": null },
  "fields": [
    { "name": "title", "type": "string", "required": true, "maxLength": 255 },
    { "name": "slug",  "type": "uid", "required": true, "targetField": "title", "maxLength": 255 },
    { "name": "body",  "type": "richtext", "required": true, "maxLength": 1000000 },
    { "name": "tags",  "type": "tags", "required": false }
  ],
  "itemCount": 12,
  "draftCount": 3,
  "scheduledCount": 1,
  "lastItemAt": "2026-11-12T20:35:39.359Z",
  "webhooks": [ … ],
  "apiKeys": [ … ],
  "createdAt": "2026-11-12T20:30:00.000Z",
  "updatedAt": "2026-11-12T20:31:12.000Z"
}
```

- `itemCount` is the number of items **this requester can see**: published items only for anonymous readers on draft & publish streams.
- `draftCount` and `scheduledCount` are included for requesters who can read drafts. `webhooks` and `apiKeys` (without secrets) are included only for the main token.
- `lastItemAt` is the newest item **timestamp** among the items the requester can see.

### 4.3 Create a stream: `POST /api/streams`

| Body field | Required | Default |
| --- | --- | --- |
| `name` | yes | none (≤ 100 chars) |
| `slug` | no | derived from `name` |
| `description` | no | `null` |
| `template` | no | `"blank"` |
| `fields` | no | the template's fields |
| `labels` | no | the template's labels (`item`/`items` for blank) |
| `draftAndPublish` | no | the template's setting |
| `retention` | no | the template's setting |
| `webhooks` | no | `[]` (see §8) |

Values you send override the template's. The response is `201` with the stream object.

**Templates:**

| id | Holds | Fields | Draft & publish | Retention |
| --- | --- | --- | --- | --- |
| `blank` | anything | none (any JSON) | off | none |
| `event-log` | events | type, level (debug/info/warn/error), source, message, payload (json) | off | 90 days |
| `blog-posts` | posts | title, slug (uid from title), excerpt, body (richtext), cover (media), author, tags, featured | **on** | none |
| `social-feed` | posts | author, text (≤ 2000), image (media), link (url), tags | off | none |
| `products` | products | name, slug (uid from name), sku (unique), price, currency (enum), description (richtext), image, inStock, tags | **on** | none |
| `events` | events | title, slug, start, end, allDay, venue, location (**pin**), description, image, url, status (scheduled/postponed/cancelled), tags | **on** | none |
| `pages` | pages | title, slug, body, image, seoTitle (≤ 70), seoDescription (≤ 160) | **on** | none |
| `announcements` | announcements | message (≤ 300), level (info/success/warning/critical), url, linkText | **on** | none |
| `case-studies` | case studies | title, slug, client, industry, summary, challenge, solution, results (richtext), image, tags | **on** | none |
| `faq` | questions | question, answer (richtext), category, order | **on** | none |
| `testimonials` | testimonials | quote, name, role, company, photo, rating (1–5) | **on** | none |
| `people` | people | name, slug, jobTitle, photo, bio, email, url, order | off | none |
| `locations` | locations | name, address, location (**pin**, required), phone, email, openingHours, image, url | off | none |
| `jobs` | jobs | title, slug, location, employmentType, remote, salaryMin/Max, currency, description, applyUrl, closingDate (**date**) | **on** | none |

Every template has a `category` (Basic, Content, Business, Data) for grouping in the admin UI, and a `schemaType`: the schema.org type of its items (`Event`, `BlogPosting`, `WebPage`, `Article`, `Question`, `Review`, `Person`, `Place`, `JobPosting`, `Product`, `SocialMediaPosting`, or `null`). A stream copies `schemaType` from its template. You can set it on create or update to any schema.org type name, or to `null`. Embedded components use it to add structured data for search engines.

### 4.4 Update a stream: `PUT|PATCH /api/streams/:slug`

Both methods do a partial update: only the keys you send change. Sending `fields` or `webhooks` replaces that whole list. Sending a `slug` that differs from the current one returns `400`.

- **Turning draft & publish on:** items created before it was enabled are treated as already published.
- **Turning it off:** every item becomes publicly visible, drafts included. Pending schedules are kept but don't fire while it's off.
- **Changing `retention`:** the new limits apply immediately (§7).

### 4.5 Delete a stream: `DELETE /api/streams/:slug`

Permanently deletes the stream and its item log. Live subscribers get a `stream-deleted` message and are then disconnected. Webhooks aren't notified.

---

## 5. Items API

### 5.1 Item object

```json
{
  "id": "0b7c3a3e-5f8e-4c0a-9a53-0d6f1b0a9f11",
  "seq": 42,
  "stream": "blog",
  "timestamp": "2026-11-12T20:35:39.359Z",
  "data": { "title": "Hello World", "slug": "hello-world", "body": "# Hi", "tags": ["news"] },
  "publishedAt": "2026-11-12T21:00:00.000Z",
  "publishAt": null,
  "unpublishAt": "2026-12-31T23:59:59.000Z",
  "createdAt": "2026-11-12T20:35:39.360Z",
  "updatedAt": "2026-11-12T21:00:00.000Z"
}
```

- `timestamp` is **when the item happened or is dated**. The client can set it, and it defaults to the time the server received the item. Time-range filters, the default sort and retention use it.
- `publishedAt` is `null` for drafts. On streams without draft & publish it equals `createdAt`.
- `publishAt` and `unpublishAt` hold pending schedules (§6.1). They exist only on draft & publish streams and are `null` when nothing is scheduled. They and `scheduleError` are returned only to requesters who can read drafts (the main token, or a `read` key): anonymous readers can't see when an item will be taken down.
- `scheduleError` appears only after a scheduled publish failed, and explains why (§6.1).
- `seq` is assigned when the item is created and never changes.

### 5.2 Create: `POST /api/streams/:slug/items` (or `POST /api/streams/:slug`)

```json
{ "data": { "title": "Hello World", "body": "# Hi" }, "timestamp": "2026-11-12T09:00:00Z", "publish": true }
```

`timestamp`, `publish`, `publishAt` and `unpublishAt` are optional. On draft & publish streams, items are drafts unless the body includes `"publish": true`; `publish` is ignored on other streams. The response is `201` with the item.

**Batch:** send an array of the same objects, up to 1000. The response is `201` with the items in the order you sent them. A batch is **all-or-nothing**: one invalid item rejects the whole request, and the error paths say which items failed (`[1].data.total`).

The fields must be inside `data`. A body like `{ "title": "A" }` is rejected with a hint to wrap the fields in `data`.

### 5.3 List: `GET /api/streams/:slug/items`

| Parameter | Example | Behavior |
| --- | --- | --- |
| `page`, `pageSize` | `page=2&pageSize=100` | Default `pageSize` is 25, max 500 |
| `sort` | `sort=data.price:asc` | Key: `timestamp`, `createdAt`, `updatedAt`, `publishedAt`, `publishAt`, `seq` or `data.<field>`. Direction: `:asc` (default) or `:desc`. Without `sort`, the order is `timestamp:desc`, or `seq:asc` when `after` is set. Empty values sort last; ties are broken by `seq`. |
| `status` | `status=draft` | Draft & publish streams only. `published` (default), `draft` (includes scheduled), `scheduled` (drafts with a `publishAt`) or `all`. Everything except `published` needs the main token or a `read` key. |
| `populate` | `populate=*` | Replace relation and media ids with the related items and file details (§3.3) |
| `since` / `until` | `since=2026-11-01T00:00:00Z` | `timestamp ≥ since` / `timestamp < until` |
| `after` | `after=42` | `seq > 42`. Use it for polling (§9.2). |
| `filter[<field>]` | `filter[slug]=hello-world` | Equals |
| `filter[<field>][<op>]` | `filter[price][lte]=20` | Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `in` |
| `filter[<pin>][within]` | `filter[location][within]=-10,40,10,60` | Map pins inside a box: `minLng,minLat,maxLng,maxLat`. A box with `minLng > maxLng` crosses the antimeridian. |
| `filter[<pin>][near]` | `filter[location][near]=51.5,-0.12,25` | Map pins within a distance: `lat,lng,km` (great-circle distance) |

Filter details:

- The query value is converted to the field's type: numbers, `true`/`false`, or ISO dates. In schema-less streams the type is guessed from the stored value.
- `contains` is a case-insensitive substring match. On `json` fields it searches the serialized JSON.
- `in` takes a comma-separated list: `filter[status][in]=pending,shipped`.
- **Tags** fields: `eq`, `in` and `contains` match when **any** tag matches; `ne` matches when **no** tag equals the value. For example, `filter[tags]=news` returns items tagged `news`.
- `gt`, `gte`, `lt` and `lte` never match empty values. All filters must match (AND).
- **Map pin** fields support only `within` and `near`; other operators return `400`.
- **Date** fields compare as `YYYY-MM-DD` text, so `filter[closingDate][gte]=2026-12-01` works as expected.
- To fetch one item by its slug: `GET …/items?filter[slug]=hello-world`.
- With curl, pass `-g` so the brackets are sent literally.

### 5.4 Get / update / delete one item

| Method | Body | Behavior |
| --- | --- | --- |
| `GET …/items/:id` | none | `200` with the item (`?populate=` supported). A draft returns `404` to anyone who can't read drafts. |
| `PUT …/items/:id` | `{ "data": {…}, "timestamp"?, "publish"?, "publishAt"?, "unpublishAt"? }` | Replaces `data` completely. `data` is required. |
| `PATCH …/items/:id` | `{ "data"?: {…}, "timestamp"?, "publish"?, "publishAt"?, "unpublishAt"? }` | Merges the keys you send into the existing `data`. |
| `DELETE …/items/:id` | none | `200` with the deleted item. The `seq` is not reused. |

`"publish": true` or `false` in a `PUT` or `PATCH` body also changes the status, as in §6.

---

## 6. Draft & publish

When `draftAndPublish` is on:

| | Draft (`publishedAt: null`) | Published |
| --- | --- | --- |
| Visible to anonymous readers (list, get, live feed, counts) | no | yes |
| Visible with the token | yes (use `status=draft` or `all` when listing) | yes |
| Required fields enforced | no | **yes** |

- **Publish:** `POST …/items/:id/publish`, or `"publish": true` on create, `PUT` or `PATCH`. The item is fully validated first, including required fields and that referenced media files still exist. If validation fails you get `400` and the item stays a draft. Publishing an item that is already published changes nothing and returns `200`.
- **Unpublish:** `POST …/items/:id/unpublish`, or `"publish": false`. `publishedAt` becomes `null`.
- When a published item is edited it stays published, and required fields are enforced on the edit.
- The publish and unpublish endpoints return `400` on streams where draft & publish is off.
- Publishing by hand clears a pending `publishAt`; unpublishing by hand clears a pending `unpublishAt`.

### 6.1 Scheduling

Set `publishAt` and/or `unpublishAt` on create, `PUT` or `PATCH`. To cancel a schedule, send `null`:

```http
PATCH /api/streams/blog/items/0b7c…
{ "publishAt": "2026-12-01T09:00:00Z", "unpublishAt": "2026-12-31T23:59:59Z" }
```

| Rule | |
| --- | --- |
| Needs draft & publish | On other streams the request returns `400`. |
| Validated when scheduled | A `publishAt` enforces required fields at save time, as publishing does. |
| `publishAt` only on drafts | On a published item it returns `400`; unpublish first, or set `unpublishAt`. |
| Not together with `"publish": true` | `400`: choose one. |
| `unpublishAt` needs a published or scheduled item | It must also be later than `publishAt`. |
| Times in the past take effect immediately | `publishAt: "2020-01-01"` publishes now. |
| Precision | The server checks for due items every 15 seconds and right after starting up, so an item goes live within about 15 s of its time, and anything that fell due while the server was down fires on restart. |
| Re-validated when it fires | If the item is no longer valid by then (for example the dataset gained a required field, or a related item was deleted), it **stays a draft**. Its `publishAt` is cleared and `scheduleError` says why. A successful reschedule clears the error. |
| Notifications | A scheduled publish or unpublish behaves exactly like a manual one: live subscribers get `published`/`unpublished` (or `created`/`deleted` in the public view), and webhooks get `item.published`/`item.unpublished`. |


---

## 7. Retention

```json
"retention": { "maxItems": 10000, "maxAgeDays": 30 }
```

| Setting | Effect |
| --- | --- |
| `maxItems` (integer 1–10 000 000, or `null`) | After each create, the items with the oldest `timestamp` are deleted until at most `maxItems` remain. |
| `maxAgeDays` (number greater than 0 and up to 36 500, or `null`) | Items whose `timestamp` is older than this many days are deleted. This is checked after each create and in an hourly sweep. |

- Both limits apply as soon as they are saved, and to every item, drafts included.
- A back-dated item (one with an old `timestamp`) can be removed as soon as it is created.
- Retention deletions are sent to live subscribers as `deleted`. They **don't** trigger webhooks.
- The Event log template defaults to `maxAgeDays: 90`.

---

## 8. Webhooks

Each stream can have up to 10 webhooks. You configure them through `PATCH /api/streams/:slug`:

```json
{ "webhooks": [ { "url": "https://example.com/hooks/blog", "events": ["created", "published"], "enabled": true } ] }
```

| Webhook field | Notes |
| --- | --- |
| `id` | Assigned by the server. Send it back when updating, to keep the same webhook. |
| `url` | `http(s)`, ≤ 2000 chars |
| `events` | Any of `created`, `updated`, `deleted`, `published`, `unpublished` (default: all) |
| `enabled` | Default `true` |
| `secret` | Generated by the server (48 hex chars) and returned only to authorized readers. Send `"rotateSecret": true` to replace it. |
| `lastDelivery` | `{ at, type, ok, status, error, attempts }`, read-only |

**Delivery request:**

```
POST <url>
Content-Type: application/json
User-Agent: media-manager-webhooks/0.8
X-Webhook-Event: item.published
X-Webhook-Delivery: 6d0f…            (unique per delivery; use it to de-duplicate)
X-Webhook-Timestamp: 1794528894      (Unix seconds when this attempt was sent)
X-Webhook-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed with the secret>

{ "id": "6d0f…", "type": "item.published", "stream": { "id": "…", "slug": "blog", "name": "Blog" },
  "item": { …full item… }, "createdAt": "2026-11-12T21:00:00.000Z" }
```

- **Which events fire:**
  - An edit that also changes the status fires only `published` or `unpublished`, not `updated`. The payload carries the full item either way.
  - A `deleted` payload carries the item as it was just before deletion.
  - Webhooks receive drafts and all status changes, because they are configured with the token.
- **Retries:** a delivery is retried after a network error, a timeout (10 s) or any non-2xx response. There are up to 3 retries, after 1 s, 10 s and 60 s. Redirects are not followed.
- **Blocked destinations:**
  - By default, webhooks can't reach loopback, private (10/8, 172.16/12, 192.168/16), carrier-grade NAT, link-local (including cloud metadata at 169.254.169.254), multicast or reserved addresses, nor their IPv6 and IPv4-mapped forms.
  - The check is made on the address that is actually connected to, after DNS resolution, so a hostname that resolves to a private address is blocked too.
  - A blocked delivery fails at once with an error that starts with `Blocked:`, and is not retried.
  - For local testing, start the server with `--allow-private-webhooks` (or `MEDIA_WEBHOOKS_ALLOW_PRIVATE=1`); `npm run start:local` does this.
- **Queue limit:** at most 500 deliveries wait per webhook. Further ones are dropped, and `lastDelivery` reports `Queue full (500 waiting): N deliveries dropped`.
- **Ordering:** deliveries to the same webhook are sent in order, one at a time. A slow endpoint delays only its own queue.
- **Testing:** `POST /api/streams/:slug/webhooks/:id/test` sends one `ping` delivery (`item: null`) without retries and returns its result.
- **Verifying a signature (Node.js).** Reject deliveries whose timestamp is more than a few minutes old: that stops a captured delivery from being replayed later.
  ```js
  const ts = req.headers['x-webhook-timestamp'];
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const sig = req.headers['x-webhook-signature'];
  const ok = fresh && sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  ```
  Versions before 0.8 signed the body alone, without a timestamp.
- Delivery is at-least-once and the queue lives in memory: deliveries still pending when the server restarts are lost. For guaranteed processing, poll by `after` instead (§9.2).

---

## 9. Consuming a stream

### 9.1 Live feed: `GET /api/streams/:slug/subscribe`

[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) (`text/event-stream`). Subscribers get one of two views:

| Change | **Editor view** (main token or a `read` key, in the header or `?access_token=`) | **Public view** (no credential) |
| --- | --- | --- |
| Item created | `created` (full item, `id:` = seq) | `created`, only if the item is visible |
| Item updated | `updated` (full item) | `updated`, only if the item is visible |
| Item published | `published` (full item) | `created` (full item): it has just appeared |
| Item unpublished | `unpublished` (full item) | `deleted` (`{ id, seq }`): it has just disappeared |
| Item deleted | `deleted` (`{ id, seq }`) | `deleted`, only if the item was visible |
| Stream settings changed | `stream-updated` (stream object) | `stream-updated` (public stream object) |
| Stream deleted | `stream-deleted`, then the connection closes | same |

- **Resuming:**
  - Browsers send `Last-Event-ID` automatically. Other clients can pass `?after=<seq>`.
  - The server first replays the currently stored items with a higher `seq` (only visible ones in the public view) as `created`, then switches to live messages.
  - Updates, publishes and deletes that happened while the client was disconnected aren't replayed; reconcile them with the list endpoint.
  - Without `Last-Event-ID` or `after`, nothing is replayed.
- **Replay limit:** if more than 1000 items were missed, nothing is replayed. Instead the server sends `event: reset`, with `{ reason, missed, list }`, where `list` is the matching `…/items?after=<seq>` URL. The client should reload from the list endpoint. The components do this automatically.
- **Access is checked on every message.** A stream key that is revoked, expires or loses the `read` scope stops receiving drafts immediately. The connection continues with the public view.
- **Limits:**
  - At most 1000 live connections per server; further ones get `503` with `Retry-After: 30`.
  - A client that doesn't read is disconnected once 1 MB is waiting for it. Its `EventSource` reconnects and resumes with `Last-Event-ID`.
- The server sends `retry: 3000` and a `: ping` comment every 25 s.
- `?access_token=` exists because `EventSource` can't send headers. Tokens in URLs can end up in proxy logs, so prefer the header where your client supports it. The admin page and the components (`key` attribute) use a fetch-based client that sends `Authorization: Bearer …`, and never put a token or key in the URL.

```js
const es = new EventSource('/api/streams/blog/subscribe');
es.addEventListener('created', (e) => render(JSON.parse(e.data)));
es.addEventListener('deleted', (e) => remove(JSON.parse(e.data).id));
```

### 9.2 Polling

Store the highest `seq` you have seen and call `GET …/items?after=<lastSeq>&pageSize=500`. The results are in ascending `seq` order; repeat until `data` comes back empty. On draft & publish streams, editors should also pass `status=all`.

### 9.3 JSON Schema: `GET /api/streams/:slug/schema`

Returns a JSON Schema (draft 2020-12) for the item `data` object. Optional fields allow `null`. `uid` fields carry their pattern, `email` and `url` fields their `format`, and `tags` is an array. For streams with fields, `additionalProperties` is `false`. On draft & publish streams, a `$comment` notes that required fields are enforced only when an item is published.

---

## 10. Standard formats

Every stream offers its **published** items in these formats. They are public reads, like `/items`, and accept the same filters, `since`/`until` and `sort`, plus `limit`.

| Path | Format | Use | Default `limit` (max) |
| --- | --- | --- | --- |
| `…/feed.ics` | iCalendar (RFC 5545) | Subscribe in Google, Outlook or Apple Calendar | 10 000 |
| `…/feed.rss` | RSS 2.0 | Feed readers, newsletters, automation tools | 50 |
| `…/feed.json` | JSON Feed 1.1 | The same, as JSON | 50 |
| `…/feed.geojson` | GeoJSON (RFC 7946) | Map tools; items without a map pin are left out | 10 000 |
| `…/items.csv` | CSV (RFC 4180, UTF-8 with BOM) | Excel, Google Sheets; downloaded as `<slug>.csv` | 100 000 |

**Field roles.** The formats find the right fields by their names and types, so most streams need no configuration:

| Role | Field names looked for (case-insensitive; types) | Fallback |
| --- | --- | --- |
| title | title, name, headline, heading, label, question, subject, summary, message, client | first string or uid field, then `#seq` |
| description | excerpt, summary, description, abstract, answer, quote, text, body, content, message, bio | none |
| start / end | start, startDate, startsAt, begin, date… / end, endDate, endsAt, finish (datetime or date) | start: the item `timestamp` |
| all-day | allDay (boolean) | a `date`-type start is always all-day |
| venue | venue, location, address, place, city (string) | the map pin's `label` |
| url | url, link, website, applyUrl, href (url) | the item's API URL |
| map pin / image | the first `geopoint` / `media` field | none |

To choose a field yourself, pass the role as a parameter, e.g. `feed.ics?start=kickoff&title=headline`. An unknown field name returns `400`.

**Other parameters:**

| Parameter | Example | Effect |
| --- | --- | --- |
| `link` | `link=https://www.example.com/blog/{slug}` | The URL of each item on your website. Placeholders: `{id}`, `{seq}`, `{slug}` (the uid field) or `{<field>}`. Must start with `http(s)://`. |
| `site` | `site=https://www.example.com` | The feed's home page (RSS `<link>`, JSON Feed `home_page_url`) |
| `tz` | `tz=Europe/London` | The time zone for **all-day** dates in `.ics` (default: `MEDIA_TIMEZONE`, else `UTC`). Timed events are always in UTC. |

**Details per format:**

- **iCalendar:**
  - Each item becomes a `VEVENT` with `UID`, `DTSTART`/`DTEND`, `SUMMARY`, `DESCRIPTION`, `LOCATION`, `GEO` and `URL`.
  - All-day events use `VALUE=DATE` with an exclusive end date.
  - Markdown is converted to plain text.
  - Lines are folded at 75 octets, and text is escaped as RFC 5545 requires.
- **RSS / JSON Feed:**
  - Tags become `<category>` / `tags`, and the image becomes an `<enclosure>` / `image`.
  - JSON Feed also includes the item's raw data under `_media_manager`.
- **GeoJSON:** coordinates are `[lng, lat]`, as GeoJSON requires. The item's other fields become `properties`, plus `title`, `url`, `seq` and `timestamp`.
- **CSV:**
  - The columns are `id`, `seq`, `timestamp`, `publishedAt` (on draft & publish streams), then one column per field.
  - Lists are joined with `; `, and objects are written as JSON.
  - Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`, so a spreadsheet does not run them as formulas. This also applies to lists joined into one cell. Real numbers (e.g. `-5`) are left as they are.
- Absolute links use `MEDIA_PUBLIC_URL` when it is set. **Set it in production.** Otherwise:
  - Links are built from the request's `Host` header. An invalid one returns `400`.
  - `X-Forwarded-Proto` is honoured only for `https`; anything else means `http`.
  - Responses carry `Vary: Host, X-Forwarded-Proto`, so caches keep them apart.
- `link` and `site` must be `http(s)` URLs with no spaces or control characters. Anything else returns `400`, because a line break could inject iCalendar lines.
- iCalendar text values escape every line break (including a lone carriage return) and drop other control characters. URL values have control characters removed.
- Responses carry `Cache-Control: public, max-age=60`.

## 11. Cross-origin access (CORS)

A website on another domain can call the API from the browser only if the server allows that website's origin. To allow it, start the server with `--cors=` or set `MEDIA_CORS_ORIGINS`:

```bash
npm start -- --token=… --cors=https://www.example.com,http://localhost:5173
```

- The value is a comma-separated list of origins (scheme, host and port, with no path), or `*` for any website. An invalid entry stops the server at startup with a clear message.
- **Allowed origins** get `Access-Control-Allow-Origin` (plus `Vary: Origin`) on `/api/*`, `/uploads/*` and `/ui/*`. Preflight `OPTIONS` requests are answered with `204`, allowing all API methods and the `Authorization`, `Content-Type` and `Last-Event-ID` headers.
- **Other origins** get no CORS headers, so browsers block their requests.
- CORS does not replace authentication. Writes still need a token or key, and you should **never put the main token in website code**. For browser writes, use a stream key with only the scopes it needs.
- `GET /api/config` returns the configured `corsOrigins`.
- The component library under `/ui/` is public static code and is always served with `Access-Control-Allow-Origin: *`, so any website can load it. Only the API is restricted by this setting.

## 12. Per-stream API keys

Keys are managed with the main token, either in the admin UI (*Settings → API keys*) or through the API:

```http
POST /api/streams/orders/keys
{ "name": "Warehouse scanner", "scopes": ["create"], "expiresAt": "2027-01-01T00:00:00Z" }

→ 201 { "id": "…", "name": "Warehouse scanner", "prefix": "mmk_JhRcQTWj", "scopes": ["create"],
        "expiresAt": "2027-01-01T00:00:00.000Z", "createdAt": "…", "lastUsedAt": null,
        "key": "mmk_JhRcQTWjy-jMlu0dZjgRjuZaTs7tigcD" }   ← shown only this once
```

| Scope | Allows (on its own stream only) |
| --- | --- |
| `read` | Reading drafts: `status=draft`, `scheduled` or `all`, drafts by id, `draftCount`, and the editor view of the live feed |
| `create` | `POST` items, single or batch, including `publish`/`publishAt` on create |
| `update` | `PUT` / `PATCH` items, publish, unpublish and scheduling |
| `delete` | `DELETE` items |

- Published items are public anyway, so a key isn't needed to read them.
- **Only a SHA-256 hash is stored.** The full key is returned once, when it is created. Listings show the `prefix` so you can tell keys apart.
- `PATCH /keys/:id` can change `name`, `scopes` and `expiresAt` (a future time, or `null`). `DELETE /keys/:id` revokes the key immediately.
- An expired or revoked key gets `401`. A valid key without the needed scope gets `403`. A key used on another stream, on stream settings, or on the media library gets `401`.
- `lastUsedAt` is updated on use; it is saved to disk at most every 30 seconds.
- A stream can have up to 50 keys.

## 13. Media Library API (summary)

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

## 14. Other endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/health` | `{ "ok": true }` |
| `GET` | `/api/config` | `{ "authRequired": bool, "maxFileSize": bytes, "corsOrigins": [...], "publicUrl": string \| null }` |

---

## 15. Admin UI

**Security headers.**
- The admin pages (`/` and `/streams.html`) are served with a Content-Security-Policy. Scripts may come only from this server (no inline or third-party scripts); images also from `data:`, `blob:` and the OpenStreetMap tile server; connections only to this server; `frame-ancestors 'none'`. They also send `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`.
- Other HTML pages (e.g. `/ui/demo.html`) can't be framed either.
- These pages keep the main token in the browser, so the policy limits what injected or third-party script could do with it. **Admin login is still not built in:** don't expose the admin pages beyond your team.

| Page | Path | Capabilities |
| --- | --- | --- |
| Media Library | `/` | Asset grid with previews; folders; search, filters and sort; drag-and-drop upload with progress; asset details (rename, alt text, caption, move, replace, download, copy link, delete); bulk move and delete |
| Streams | `/streams.html` | See below |

**Streams page:**

- **Create a stream:** a template picker (Blank, Event log, Blog posts, Social feed, Products), plus the name, a slug (auto-generated, editable) and the field builder, pre-filled from the template.
- **Items tab:** named after the stream's labels, e.g. "Posts". Relation columns show the related items' names, and scheduled items show their publish time in the status column.
  - A table with sortable columns, a status column and a Status filter (All, Published, Drafts) on draft & publish streams, and a field filter.
  - A *Live* toggle that updates the table over SSE, including drafts when a token is set.
  - The item form is generated from the dataset. Markdown fields get a large editor, UID fields a "Generate" button, tags a comma-separated input, and media fields a picker of uploaded files.
  - Relation fields get a dropdown (single) or a searchable checklist (multiple) of the related stream's items; drafts are marked.
  - *Publish at* and *Unpublish at* inputs schedule the item, and *Save draft* becomes *Schedule* once a time is entered. A failed scheduled publish is shown at the top of the form.
  - Its buttons are *Save draft* / *Schedule*, *Publish* / *Save & publish* and *Unpublish*, depending on the item's state.
- **Dataset tab:** the field builder. It covers every type in §3, with required, unique, length, min/max, enum options, the UID source field, and the target stream and "Many" option for relations. It also lets you reorder fields.
- **Settings tab:** labels, the draft & publish toggle and retention limits. *API keys* lists each key (name, prefix, scopes, created, last used, expiry) with a *Revoke* button, and creates keys, showing the secret once with a copy button. You confirm before stricter limits delete anything. It also edits webhooks: URL, events, enabled, secret (copy or rotate), last delivery status, and *Send test*. The *Delete stream* button is here too; you confirm by typing the slug.
- **Embed tab:**
  - **Component choice:** the tab recommends a component for the stream: Calendar for dated items, Map for map pins, Banner for announcements, Cards for streams with images, otherwise List. Components the stream can't support are disabled with the reason, such as "Needs a map pin field".
  - **Options:** the component's own options, plus items to show, order, the link pattern, theme, date style, accent colour, corner radius, live updates, "load more" and structured data.
  - **Preview:** a live preview of the published items.
  - **Code:** the code to copy. It uses `MEDIA_PUBLIC_URL` (from `/api/config`) or the current address, and you can edit the address. Attribute values are escaped.
  - **CORS:** the tab shows which websites may use the API.
- **API tab:** the endpoint list and copy-paste examples for that stream: create, list, filter, get by slug, poll, subscribe, and verifying a webhook signature. It also links to the stream's JSON Schema.

The selected stream and tab are kept in the URL (`/streams.html?stream=blog&tab=settings`).

---

## 15a. Streams UI (component library)

`/ui/streams-ui.js` is an ES module that registers custom elements for showing streams as HTML on any website. It has no dependencies, except the bundled Leaflet 1.9.4 for maps:

`<stream-list>`, `<stream-cards>`, `<stream-carousel>`, `<stream-calendar>`, `<stream-timeline>`, `<stream-table>`, `<stream-map>`, `<stream-gallery>`, `<stream-item>`, `<stream-next>`, `<stream-filter>`, `<stream-banner>`.

- **Data:** each element reads `src` (a stream URL) and requests `GET …/items` with `populate=*`. Only published items are shown, unless a `read` key is given. `live` subscribes to `…/subscribe`.
- **Field roles:** the title, dates, image, body, location and tags are detected from field names and types, the same way as for the standard formats (§10). Attributes such as `date-field="kickoff"` override them.
- **Styling:** CSS variables (`--sui-*`), `::part()`, an `unstyled` light-DOM mode with `sui-*` classes, `<template>` bindings (`data-field`, `data-html`, `data-src`, `data-href`, `data-date`, `data-if`, `data-each`), or a `renderItem` function.
- **Safety:** text is always inserted as text. Markdown goes through a sanitizing renderer: HTML is escaped, and only `http(s)`, `mailto`, `tel` and relative URLs are allowed.
- **Search engines:** `jsonld` adds schema.org JSON-LD based on the stream's `schemaType`.
- **Demo:** `/ui/demo.html` shows every component and its code. Run `npm run seed:demo` first to create the demo streams.

The full reference is in [UI.md](UI.md).

## 16. Storage & operations

```
$MEDIA_DATA_DIR/
├── db.json                 # files, folders, stream definitions, webhook secrets, API key hashes (rewritten atomically)
├── uploads/<hash>.<ext>    # media binaries
└── events/<streamId>.jsonl # one append-only item log per stream
```

- **Item logs** are append-only JSON Lines; each change adds one line. On startup a log is replayed into memory, a line cut off by a crash is skipped, and the log is compacted when superseded lines pile up.
- **Writes are serialized** within each log and within `db.json`. All reads are served from memory.
- **Permissions:** the data directory is created with mode `0700`, and `db.json` and the item logs with `0600` (owner only). Files left by earlier versions are tightened when they are loaded. Uploaded media files are public anyway.
- **Backup:** copy the data directory while no writes are happening. `db.json` holds webhook secrets, so protect it like a credential.

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `1338` / `0.0.0.0` | Listen address |
| `MEDIA_API_TOKEN` | *(unset = everything open)* | Bearer token for writes and draft access |
| `MEDIA_DATA_DIR` | `./data` | Data directory |
| `MEDIA_MAX_FILE_SIZE` | `52428800` | Per-file upload limit in bytes |
| `MEDIA_CORS_ORIGINS` (`--cors=`) | *(none)* | Websites allowed to call the API from a browser (§11) |
| `MEDIA_PUBLIC_URL` (`--public-url=`) | *(from the Host header)* | Base URL for absolute links in feeds |
| `MEDIA_TIMEZONE` | `UTC` | Default time zone for all-day dates in `.ics` feeds |
| `MEDIA_WEBHOOKS_ALLOW_PRIVATE` (`--allow-private-webhooks`) | off | Let webhooks reach loopback / private addresses (local testing only) |

`--token=`, `--port=`, `--host=`, `--cors=`, `--public-url=` and `--allow-private-webhooks` can be passed after `npm start --`. They take priority over the environment variables.

## 17. Limits & non-goals (current version)

| Area | Limit / behavior |
| --- | --- |
| Scale | It runs as a single process and keeps everything in memory. It's comfortable up to about 100k items per stream; unique checks scan the stream once per write request. A SQLite or Postgres backend would remove this limit without changing the API. |
| Auth | One main token with full access, plus per-stream keys with item-level scopes. There are no user accounts, roles or field-level permissions, and nothing is rate-limited per key. |
| Content | Populating goes one level deep. No localization or version history. Markdown isn't rendered server-side. |
| Scheduling | Precision is about 15 seconds. Schedules use absolute UTC times; there are no recurring schedules. |
| Webhooks | The delivery queue lives in memory: pending retries are lost on restart, and it holds at most 500 deliveries per webhook. Redirects aren't followed. Private network destinations are blocked unless allowed (§8). |
| Rate limiting | Not built in. Put a reverse proxy in front if the API is exposed publicly. |
| Maps | The server stores and filters pins but doesn't geocode addresses (convert an address into coordinates). |

## 18. Possible next steps

- Aggregations (`count`, `sum` and `avg` grouped by field or time bucket) and CSV / NDJSON export
- Version history (restore an earlier version of an item)
- Deeper populate (`populate[author][populate]=avatar`) and media population
- A persistent webhook queue with a delivery log
- Rate limits per API key
- SQLite storage backend
