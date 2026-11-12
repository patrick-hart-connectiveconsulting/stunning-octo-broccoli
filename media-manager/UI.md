# Streams UI: component reference

Web components that show Media Manager streams on any website as formatted HTML: lists, cards, calendars, maps and more.

- **Works anywhere:** plain HTML, WordPress, Webflow, React, Vue, Svelte.
- **Nothing to install:** there are no dependencies and no build step.
- **Safe:** text is inserted as text, and Markdown is rendered through a sanitizer.
- **Live:** add `live` and the component updates when the stream changes.
- **Accessible:** semantic HTML, keyboard support, and `prefers-reduced-motion` is respected.

To see every component working, start the server, run `npm run seed:demo`, and open **`/ui/demo.html`**. To make the code for one of your streams without writing it by hand, open the stream in the admin page and use the **Embed** tab.

---

## 1. Quick start

```html
<!-- 1. Load the library once (from your Media Manager server) -->
<script type="module" src="https://cms.example.com/ui/streams-ui.js"></script>

<!-- 2. Use the elements -->
<stream-list src="https://cms.example.com/api/streams/blog" limit="5" link="/blog/{slug}"></stream-list>
<stream-calendar src="https://cms.example.com/api/streams/events" live></stream-calendar>
```

> **Website on another domain?** Start the server with `--cors=https://www.your-site.com` (see SPEC §11). The `/ui/` files themselves load from any website, but the API refuses browser requests from websites you haven't allowed. A component on a blocked website shows the exact `--cors=` value to add.

---

## 2. Components

| Element | Shows | Default `limit` |
| --- | --- | --- |
| `<stream-list>` | A vertical list (image left), or a horizontal row with `layout="horizontal"` | 10 |
| `<stream-cards>` | A responsive grid of cards | 12 |
| `<stream-carousel>` | Slides with previous/next buttons, dots, swipe and optional autoplay | 10 |
| `<stream-calendar>` | Month, week and agenda views of dated items | 500 per view |
| `<stream-timeline>` | Items on a vertical timeline, optionally grouped by year or month | 20 |
| `<stream-table>` | A table with sortable columns and an optional search box | 50 |
| `<stream-map>` | Items with a map pin, on an interactive map | 200 |
| `<stream-gallery>` | The images of a stream, with a lightbox | 24 |
| `<stream-item>` | One item in full, with its Markdown body rendered: a detail page | 1 |
| `<stream-next>` | The next upcoming item, optionally with a countdown | 1 |
| `<stream-filter>` | Chips that filter other components by a field (e.g. tags) | – |
| `<stream-banner>` | The latest announcement, colour-coded by level | 5 |

### 2.1 Attributes every component accepts

| Attribute | Example | Effect |
| --- | --- | --- |
| `src` **(required)** | `https://cms.example.com/api/streams/events` | The stream. A relative URL works on the same server. |
| `limit` | `6` | Items per page (max 500) |
| `sort` | `data.start:asc`, `timestamp:desc` | Same syntax as the API (SPEC §5.3) |
| `filter` | `filter[tags]=news&since=2026-01-01` | Extra API query parameters: filters, `since`/`until`, `status` (with a `key`) |
| `populate` | `*` (default), `author,cover`, `none` | Fill in related items and media |
| `link` | `/blog/{slug}`, `https://site/e/{id}` | Where each item links to. Placeholders: `{slug}`, `{id}`, `{seq}`, `{<field>}`. Without it, a `url` field is used if the stream has one. |
| `live` | – | Update automatically when the stream changes (Server-Sent Events) |
| `more` | `Load more` | Show a button that loads the next page |
| `excerpt` | `120` | Maximum length of the description text (default 180) |
| `locale` | `de-DE` | Language for dates (default: the page's `lang`, else the browser's) |
| `date-style` | `short`, `medium`, `long`, `full` | Date format (default `medium`) |
| `show-date` / `hide-date` | – | Force dates on or off. By default, dates show for streams with a date field and for posts, articles and events. |
| `theme` | `light` (default), `dark`, `auto` | Built-in colour scheme; `auto` follows the visitor's system setting |
| `unstyled` | – | Render plain markup, with no built-in styles and no shadow DOM, so your site's CSS applies (§3.3) |
| `template` | `my-template-id` | Use a `<template>` elsewhere on the page (§3.4) |
| `jsonld` | – | Add schema.org JSON-LD for search engines, from the stream's `schemaType` |
| `empty-text`, `loading-text` | `No events yet.` | Messages |
| `key` | `mmk_…` | A **read-only** stream API key, needed only to show drafts (e.g. on a preview site). **Never use the main token or a key with write scopes in a page.** |
| `title-field`, `date-field` (or `start-field`), `end-field`, `image-field`, `description-field`, `body-field`, `location-field`, `venue-field`, `url-field`, `tags-field` | `date-field="kickoff"` | Choose which field fills each role. Usually unnecessary: roles are detected from field names (`title`/`name`, `start`, `excerpt`/`description`, the first media field…). |

### 2.2 Component-specific attributes

| Element | Attribute | Effect |
| --- | --- | --- |
| `stream-list` | `layout="horizontal"` | A scrolling row |
| | `compact` | Hide images |
| | `divided` | Lines between items |
| `stream-cards` | `columns="3"` | A fixed number of columns. Default: as many as fit (`--sui-card-min`). |
| | `compact` | Hide images |
| `stream-carousel` | `per-view="2"` | Slides visible at once |
| | `autoplay="5000"` | Advance every N ms. Pauses on hover or focus; off when the visitor prefers reduced motion. |
| `stream-calendar` | `view` | `month` (default), `week` or `agenda` |
| | `views="month,agenda"` | Which view buttons to show |
| | `date="2026-12"` | The month (or day) to open on |
| | `week-start="1"` | 0 = Sunday … 6. Default: from the locale. |
| | `max-per-day="3"` | Events per day before "+N more" |
| | `color-field="tags"` | Colour events by a field's (first) value |
| | `no-responsive` | Keep the month view on narrow screens (by default it becomes the agenda) |
| | `today-label`, `link-label` | Button and link texts |
| `stream-timeline` | `group` | `year` or `month` |
| | `alternate` | Zig-zag layout on wide screens |
| | `order="asc"` | Oldest first (default newest first) |
| | `compact` | Hide images |
| `stream-table` | `columns="title,start,venue"` | Which fields to show. Default: title, date, venue and a few more. |
| | `headers="Event,When,Where"` | Column titles |
| | `searchable` | Add a search box |
| | `caption` | The table caption |
| `stream-map` | `height="420"` | Pixels or any CSS length |
| | `zoom` / `max-zoom` | Zoom levels. Default: fit all pins. |
| | `tiles`, `attribution` | Use another tile provider (URL with `{z}/{x}/{y}`) |
| | `leaflet-src` | Load Leaflet from another URL |
| `stream-gallery` | `field="cover"` | Which media field (default: all) |
| | `captions` | Show captions under thumbnails |
| `stream-item` | `slug="hello-world"` | The item by its UID field… |
| | `slug-param="slug"` | …or from `?slug=` in the page URL… |
| | `slug-from-path` | …or from the last part of the page path (`/blog/hello-world`)… |
| | `item-id="…"` | …or by id |
| | `heading="2"` | Heading level of the title (default 1) |
| | `set-title` | Set the page's `<title>` to the item's title |
| | `details` | List the remaining fields (phone, URL, …) below the body |
| `stream-next` | `countdown` | Show days, hours, minutes and seconds until it starts |
| `stream-filter` | `for="id1,id2"` | **Required:** the ids of the components to filter |
| | `field="tags"` | The field to filter by (default: the stream's tags field) |
| | `values="a,b,c"` | Fixed choices. Default: the values found, most frequent first. |
| | `all-label` | The text of the "All" chip |
| `stream-banner` | `rotate="6000"` | Cycle through several announcements |
| | `dismissible` | Add a close button; dismissed items stay hidden (remembered in the browser) |

---

## 3. Styling, from least to most control

### 3.1 CSS variables

Set them on the element, a parent, or `:root`:

```css
stream-cards {
  --sui-accent: #d6336c;          /* links, buttons, tags, today, pins */
  --sui-radius: 16px;
  --sui-font: Georgia, serif;
}
```

| Variable | Default | Variable | Default |
| --- | --- | --- | --- |
| `--sui-accent` | `#4945ff` | `--sui-accent-text` | `#fff` |
| `--sui-text` | inherited | `--sui-muted` | `#5b6270` |
| `--sui-surface` | `#fff` | `--sui-border` | `#e3e5ea` |
| `--sui-hover` | accent at 6% | `--sui-shadow` | subtle |
| `--sui-font` | inherited | `--sui-font-size` | `1rem` |
| `--sui-title-size` | `1.125rem` | `--sui-radius` | `8px` |
| `--sui-gap` | `16px` | `--sui-image-ratio` | `16 / 9` |
| `--sui-card-min` | `240px` | `--sui-thumb-width` | `160px` (list) |
| `--sui-item-width` | `260px` (horizontal list) | `--sui-day-height` | `104px` (calendar) |
| `--sui-thumb-min` | `160px` (gallery) | `--sui-detail-title-size` | `2em` (item) |

The banner also has `--sui-info-bg` / `--sui-info-text`, plus the same pair for `success`, `warning` and `critical`.

### 3.2 `::part()`

Each piece of a component has a `part` name you can style from your page:

```css
stream-list::part(title) { text-transform: uppercase; }
stream-list::part(date)  { color: #12b886; font-weight: 700; }
stream-calendar::part(day-today) { background: #fff7e6; }
```

**Common parts:**
- `root`, `item`, `image`, `body`, `title`, `link`, `date`, `venue`, `description`, `tags`, `tag`, `more`, `message`.

**Per component:**

| Component | Parts |
| --- | --- |
| list | `list`, `list-item` |
| cards | `grid`, `card` |
| carousel | `carousel`, `track`, `slide`, `controls`, `prev`, `next`, `dots`, `dot` |
| calendar | `header`, `title`, `nav`, `button`, `prev`, `next`, `today`, `views`, `view`, `month`, `week`, `agenda`, `day`, `day-outside`, `day-today`, `event`, `more-events`, `agenda-day`, `popup`, `popup-body`, `popup-title`, `popup-link` |
| timeline | `timeline`, `group`, `entry` |
| table | `table`, `table-wrap`, `caption`, `header`, `row`, `cell`, `search` |
| map | `map`, `popup`, `fallback` |
| gallery | `gallery`, `thumb`, `caption`, `lightbox`, `lightbox-caption` |
| item | `content`, `meta`, `details` |
| next | `next`, `countdown`, `unit` |
| filter | `chips`, `chip` |
| banner | `banner`, `text`, `dismiss` |

### 3.3 `unstyled`: your own CSS

With `unstyled`, the component renders into the light DOM with no built-in CSS. Your stylesheet then styles it through `sui-*` classes:
- `.sui-root`, `.sui-list`, `.sui-cards`, `.sui-item`, `.sui-image`, `.sui-body`, `.sui-title`, `.sui-date`, `.sui-description`, `.sui-tags`, `.sui-tag`, `.sui-message`, …
- The root also has `.sui-<element-name>`, e.g. `.sui-stream-list`.

### 3.4 Your own markup: `<template>`

```html
<stream-cards src="…/api/streams/team" unstyled sort="data.order:asc">
  <template>
    <div class="team-card">
      <img data-src="photo" data-if="photo">
      <h3 data-field="name"></h3>
      <p data-field="jobTitle"></p>
      <div data-html="bio"></div>
      <a data-href="$link" data-if="$link">Profile</a>
      <ul><li data-each="tags" data-field="."></li></ul>
    </div>
  </template>
</stream-cards>
```

| Binding | Fills in |
| --- | --- |
| `data-field="name"` | Text (`textContent`). Arrays are joined with ", ", and related items show their title. |
| `data-html="body"` | Markdown, rendered safely |
| `data-date="start"` | A formatted date. On `<time>`, it also sets `datetime`. |
| `data-href="url"` | `href`. `javascript:` and similar URLs are replaced with `#`. |
| `data-src="photo"` | `src` (and `alt`, if missing) from a media field |
| `data-if="field"` / `data-unless="field"` | Removes the element when the value is empty / not empty |
| `data-each="tags"` | Repeats the element for each value. Inside it, `"."` is the value and `".name"` is a path within it. |

- Values are field names, dotted paths into populated items (`author.data.name`), item properties (`publishedAt`), or these computed values: `$title`, `$link`, `$date`, `$dateLabel`, `$image`, `$description`, `$venue`, `$tags`, `$body`, `$id`, `$seq`.
- Without `unstyled`, the template renders inside the shadow DOM, so page CSS doesn't reach it. Style it with `::part()`, or put a `<style>` element inside the template.

### 3.5 JavaScript: `renderItem`

```js
const list = document.querySelector('#places');
list.renderItem = (item, { info, escapeHtml, renderMarkdown, formatDate }) =>
  `<p><strong>${escapeHtml(info.title)}</strong> · ${escapeHtml(item.data.openingHours ?? '')}</p>`;
```

- Return a DOM node or an HTML string. **When you return a string, you are responsible for escaping**; use the `escapeHtml` helper.
- `info` holds the resolved pieces: `title`, `link`, `start`, `end`, `allDay`, `image` (`{ src, alt }`), `description`, `tags`, `pin`, `venue` and `body`.

---

## 4. Events and methods

| Event (bubbles) | `detail` | When |
| --- | --- | --- |
| `stream-load` | `{ items, stream, total }` | After each successful load |
| `stream-error` | `{ error }` | Loading failed, or the map library could not load |
| `stream-select` | `{ item, info }` | An item, row, calendar event or map pin was clicked |
| `stream-filter` | `{ field, value }` | A filter chip was chosen (`value` is `null` for "All") |

- **Methods:** `el.refresh()` reloads the data, and `el.items` holds the current items.
- **Changing attributes:** when you change an attribute, such as `filter`, `sort`, `src` or `date`, the component reloads automatically.

```js
document.querySelector('stream-calendar').addEventListener('stream-select', (e) => {
  location.href = `/events/${e.detail.item.data.slug}`;
});
```

---

## 5. Notes

- **Maps:**
  - The map uses the bundled **Leaflet 1.9.4** (BSD-2-Clause, `ui/vendor/leaflet/`) and **OpenStreetMap** tiles.
  - For a busy public site, review the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/), or set `tiles` to a commercial provider.
  - If the map library can't load (offline, or blocked by a Content-Security-Policy), the component lists the places with OpenStreetMap links instead.
- **Content-Security-Policy:** your site must allow `script-src` and `connect-src` for the Media Manager origin, and `img-src` for it and for the tile server.
- **Drafts** are never shown unless you give a `key` with the `read` scope. Use that only on private preview pages.
- **Browser support:** current Chrome, Edge, Firefox and Safari (custom elements, shadow DOM, `<dialog>`).
- **Server-side rendering:** the components render in the browser. For pages that search engines must index without JavaScript, add `jsonld`, or render the content on your server from the API (or the RSS / JSON Feed formats).
