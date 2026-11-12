// Streams UI — web components that turn Media Manager streams into HTML.
//
//   <script type="module" src="https://your-cms/ui/streams-ui.js"></script>
//   <stream-list src="https://your-cms/api/streams/blog" limit="5" live></stream-list>
//
// Importing this file registers every element. See UI.md for the reference.

import { StreamElement } from './base.js';
import {
  StreamList, StreamCards, StreamCarousel, StreamTimeline, StreamTable,
  StreamGallery, StreamNext, StreamItem, StreamFilter, StreamBanner,
} from './views.js';
import { StreamCalendar } from './calendar.js';
import { StreamMap } from './map.js';

export const ELEMENTS = {
  'stream-list': StreamList,
  'stream-cards': StreamCards,
  'stream-carousel': StreamCarousel,
  'stream-calendar': StreamCalendar,
  'stream-timeline': StreamTimeline,
  'stream-table': StreamTable,
  'stream-map': StreamMap,
  'stream-item': StreamItem,
  'stream-gallery': StreamGallery,
  'stream-next': StreamNext,
  'stream-filter': StreamFilter,
  'stream-banner': StreamBanner,
};

for (const [name, cls] of Object.entries(ELEMENTS)) {
  if (!customElements.get(name)) customElements.define(name, cls);
}

export {
  StreamElement, StreamList, StreamCards, StreamCarousel, StreamCalendar, StreamTimeline, StreamTable,
  StreamMap, StreamItem, StreamGallery, StreamNext, StreamFilter, StreamBanner,
};
export { renderMarkdown, escapeHtml, markdownToText, fieldRoles, formatDate, jsonLdFor } from './core.js';
