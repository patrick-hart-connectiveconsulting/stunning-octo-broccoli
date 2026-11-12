// Starting points for new streams. A template only pre-fills the stream
// definition; everything it sets can be changed afterwards.

export const TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'No fields — accepts any JSON object. Define the dataset yourself.',
    labels: { singular: 'item', plural: 'items' },
    draftAndPublish: false,
    retention: { maxItems: null, maxAgeDays: null },
    fields: [],
  },
  {
    id: 'event-log',
    name: 'Event log',
    description: 'Timestamped events from apps, devices or services. Optional retention keeps it small.',
    labels: { singular: 'event', plural: 'events' },
    draftAndPublish: false,
    retention: { maxItems: null, maxAgeDays: 90 },
    fields: [
      { name: 'type', type: 'string', required: true, description: 'What happened, e.g. user.signed_up' },
      { name: 'level', type: 'enum', options: ['debug', 'info', 'warn', 'error'], required: true },
      { name: 'source', type: 'string', description: 'Service, device or user that emitted the event' },
      { name: 'message', type: 'text' },
      { name: 'payload', type: 'json', description: 'Any extra structured data' },
    ],
  },
  {
    id: 'blog-posts',
    name: 'Blog posts',
    description: 'Articles with a URL slug, Markdown body, cover image and tags. Draft & publish enabled.',
    labels: { singular: 'post', plural: 'posts' },
    draftAndPublish: true,
    retention: { maxItems: null, maxAgeDays: null },
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'slug', type: 'uid', targetField: 'title', required: true, description: 'Generated from the title if left blank' },
      { name: 'excerpt', type: 'text', maxLength: 500 },
      { name: 'body', type: 'richtext', required: true, description: 'Markdown' },
      { name: 'cover', type: 'media' },
      { name: 'author', type: 'string' },
      { name: 'tags', type: 'tags' },
      { name: 'featured', type: 'boolean' },
    ],
  },
  {
    id: 'social-feed',
    name: 'Social feed',
    description: 'Short posts with an optional image and link — announcements, updates, a status feed.',
    labels: { singular: 'post', plural: 'posts' },
    draftAndPublish: false,
    retention: { maxItems: null, maxAgeDays: null },
    fields: [
      { name: 'author', type: 'string', required: true },
      { name: 'text', type: 'text', required: true, maxLength: 2000 },
      { name: 'image', type: 'media' },
      { name: 'link', type: 'url' },
      { name: 'tags', type: 'tags' },
    ],
  },
  {
    id: 'products',
    name: 'Products',
    description: 'A catalog with unique SKUs, prices and images. Draft & publish enabled.',
    labels: { singular: 'product', plural: 'products' },
    draftAndPublish: true,
    retention: { maxItems: null, maxAgeDays: null },
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'slug', type: 'uid', targetField: 'name', required: true },
      { name: 'sku', type: 'string', required: true, unique: true, maxLength: 64 },
      { name: 'price', type: 'number', required: true, min: 0 },
      { name: 'currency', type: 'enum', options: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'], required: true },
      { name: 'description', type: 'richtext' },
      { name: 'image', type: 'media' },
      { name: 'inStock', type: 'boolean' },
      { name: 'tags', type: 'tags' },
    ],
  },
];

export const getTemplate = (id) => TEMPLATES.find((t) => t.id === id) || null;
