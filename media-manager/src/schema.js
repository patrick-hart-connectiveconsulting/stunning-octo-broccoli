// Stream datasets: field definitions and validation of item data against them.

export const FIELD_TYPES = [
  'string', 'text', 'richtext', 'uid', 'email', 'url',
  'integer', 'number', 'boolean', 'datetime', 'date', 'enum', 'tags', 'json', 'media', 'relation', 'geopoint',
];

export const UID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 100;
const MAX_TAGS = 100;
const MAX_TAG_LENGTH = 64;
const MAX_RELATIONS = 100;
const STREAM_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const DEFAULT_MAX_LENGTH = { string: 255, text: 100000, richtext: 1000000, uid: 255 };
const UNIQUE_CAPABLE = new Set(['string', 'email', 'url', 'integer', 'number', 'uid']);

/**
 * Normalises a stream's field list. Returns { fields } on success or
 * { errors: [{ path, message }] } describing every problem found.
 */
export function normalizeFields(input) {
  const errors = [];
  if (input === undefined || input === null) return { fields: [] };
  if (!Array.isArray(input)) return { errors: [{ path: 'fields', message: 'fields must be an array' }] };
  if (input.length > MAX_FIELDS) return { errors: [{ path: 'fields', message: `At most ${MAX_FIELDS} fields` }] };

  const seen = new Set();
  const fields = input.map((raw, i) => {
    const path = `fields[${i}]`;
    const err = (message) => errors.push({ path, message });
    if (!raw || typeof raw !== 'object') {
      err('must be an object');
      return null;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!FIELD_NAME.test(name)) err('name must start with a letter or _ and contain only letters, digits and _ (max 64)');
    else if (seen.has(name.toLowerCase())) err(`duplicate field name "${name}"`);
    seen.add(name.toLowerCase());

    if (!FIELD_TYPES.includes(raw.type)) err(`type must be one of: ${FIELD_TYPES.join(', ')}`);
    const field = { name, type: raw.type, required: raw.required === true };

    if (raw.description !== undefined && raw.description !== null && raw.description !== '') {
      if (typeof raw.description !== 'string' || raw.description.length > 500) err('description must be a string (max 500)');
      else field.description = raw.description.trim();
    }

    if (raw.type === 'enum') {
      const options = Array.isArray(raw.options) ? [...new Set(raw.options.map((o) => String(o).trim()).filter(Boolean))] : [];
      if (!options.length) err('enum fields need at least one option');
      if (options.length > 200) err('enum fields allow at most 200 options');
      field.options = options;
    }

    if (raw.type in DEFAULT_MAX_LENGTH) {
      const max = raw.maxLength ?? DEFAULT_MAX_LENGTH[raw.type];
      const ceiling = raw.type === 'uid' ? 255 : 10000000;
      if (!Number.isInteger(max) || max < 1 || max > ceiling) err(`maxLength must be an integer between 1 and ${ceiling}`);
      field.maxLength = max;
    }

    if (raw.type === 'integer' || raw.type === 'number') {
      for (const key of ['min', 'max']) {
        if (raw[key] === undefined || raw[key] === null || raw[key] === '') continue;
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) err(`${key} must be a number`);
        else field[key] = raw[key];
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) err('min cannot be greater than max');
    }

    if (raw.type === 'uid') {
      if (raw.targetField !== undefined && raw.targetField !== null && raw.targetField !== '') field.targetField = String(raw.targetField);
    }

    if (raw.type === 'relation') {
      if (typeof raw.target !== 'string' || !STREAM_SLUG.test(raw.target)) err('relation fields need a target stream slug');
      field.target = raw.target;
      field.multiple = raw.multiple === true;
    }

    if (raw.unique === true) {
      if (UNIQUE_CAPABLE.has(raw.type)) field.unique = true;
      else if (raw.type !== undefined) err(`unique is not supported on ${raw.type} fields`);
    }
    return field;
  });

  // Cross-field checks
  fields.forEach((f, i) => {
    if (f?.type !== 'uid' || !f.targetField) return;
    const target = fields.find((t) => t?.name === f.targetField);
    if (!target || !['string', 'text'].includes(target.type)) {
      errors.push({ path: `fields[${i}].targetField`, message: 'must name a string or text field of this stream' });
    }
  });

  return errors.length ? { errors } : { fields };
}

/** Empty value stored for a field: [] for list-like fields, null otherwise. */
export const emptyValue = (f) => (f.type === 'tags' || (f.type === 'relation' && f.multiple) ? [] : null);

export const isEmptyValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validates and normalises an item's data object against the stream fields.
 * Streams without fields accept any JSON object. With `enforceRequired: false`
 * (drafts) required fields may be empty.
 * Returns { data } or { errors: [{ path, message }] }.
 */
export function validateData(fields, data, { mediaExists = () => true, relationExists = () => true, enforceRequired = true } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: [{ path: 'data', message: 'data must be a JSON object' }] };
  }
  if (!fields.length) return { data };

  const errors = [];
  const out = {};
  const known = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(data)) {
    if (!known.has(key)) errors.push({ path: `data.${key}`, message: 'is not a field of this stream' });
  }

  for (const field of fields) {
    const path = `data.${field.name}`;
    const value = data[field.name];
    if (isEmptyValue(value)) {
      if (field.required && enforceRequired) errors.push({ path, message: 'is required' });
      out[field.name] = emptyValue(field);
      continue;
    }
    const result = coerce(field, value, mediaExists, relationExists);
    if (result.error) errors.push({ path, message: result.error });
    else out[field.name] = result.value;
  }
  return errors.length ? { errors } : { data: out };
}

function coerce(field, value, mediaExists, relationExists) {
  const lengthCheck = (v) => (v.length > field.maxLength ? { error: `must be at most ${field.maxLength} characters` } : { value: v });
  switch (field.type) {
    case 'string':
    case 'text':
    case 'richtext':
      if (typeof value !== 'string') return { error: 'must be a string' };
      return lengthCheck(value);
    case 'uid':
      if (typeof value !== 'string' || !UID_PATTERN.test(value)) return { error: 'must be lowercase letters, digits and single hyphens (e.g. my-first-post)' };
      return lengthCheck(value);
    case 'email':
      if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) return { error: 'must be an email address' };
      return { value: value.trim() };
    case 'url': {
      if (typeof value !== 'string' || value.length > 2000) return { error: 'must be an http(s) URL' };
      try {
        const u = new URL(value);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
        return { value };
      } catch {
        return { error: 'must be an http(s) URL' };
      }
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: 'must be a number' };
      if (field.type === 'integer' && !Number.isInteger(value)) return { error: 'must be an integer' };
      if (field.min !== undefined && value < field.min) return { error: `must be ≥ ${field.min}` };
      if (field.max !== undefined && value > field.max) return { error: `must be ≤ ${field.max}` };
      return { value };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { error: 'must be true or false' };
    case 'datetime': {
      const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return { error: 'must be an ISO 8601 date-time' };
      return { value: date.toISOString() };
    }
    case 'date': {
      const m = typeof value === 'string' ? DATE_ONLY.exec(value) : null;
      const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
        return { error: 'must be a date like 2026-12-31' };
      }
      return { value };
    }
    case 'geopoint': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'must be an object like { "lat": 51.5, "lng": -0.12 }' };
      const extra = Object.keys(value).filter((k) => !['lat', 'lng', 'label'].includes(k));
      if (extra.length) return { error: `unknown key ${extra.join(', ')} (allowed: lat, lng, label)` };
      const { lat, lng, label } = value;
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'lat must be a number between -90 and 90' };
      if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return { error: 'lng must be a number between -180 and 180' };
      if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 200)) return { error: 'label must be a string of at most 200 characters' };
      return { value: { lat, lng, ...(label ? { label: label.trim() } : {}) } };
    }
    case 'enum':
      return field.options.includes(value) ? { value } : { error: `must be one of: ${field.options.join(', ')}` };
    case 'tags': {
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) return { error: 'must be an array of strings' };
      const tags = [...new Set(value.map((t) => t.trim()).filter(Boolean))];
      if (tags.length > MAX_TAGS) return { error: `at most ${MAX_TAGS} tags` };
      if (tags.some((t) => t.length > MAX_TAG_LENGTH)) return { error: `each tag must be at most ${MAX_TAG_LENGTH} characters` };
      return { value: tags };
    }
    case 'json':
      return { value };
    case 'media':
      if (typeof value !== 'string') return { error: 'must be a media file id' };
      return mediaExists(value) ? { value } : { error: 'media file does not exist' };
    case 'relation': {
      if (!field.multiple) {
        if (typeof value !== 'string') return { error: `must be the id of a ${field.target} item` };
        return relationExists(field, value) ? { value } : { error: `no ${field.target} item with id ${value}` };
      }
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return { error: `must be an array of ${field.target} item ids` };
      const ids = [...new Set(value)];
      if (ids.length > MAX_RELATIONS) return { error: `at most ${MAX_RELATIONS} related items` };
      const missing = ids.filter((id) => !relationExists(field, id));
      return missing.length ? { error: `no ${field.target} item with id ${missing.join(', ')}` } : { value: ids };
    }
    default:
      return { error: 'has an unknown type' };
  }
}

/** Converts a query-string value for comparison against a field of the given type. */
export function parseFilterValue(type, raw, sample) {
  const kind = type || (typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string');
  if (kind === 'integer' || kind === 'number') return Number(raw);
  if (kind === 'boolean') return raw === 'true';
  if (kind === 'datetime') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toISOString();
  }
  return raw;
}

/** JSON Schema (2020-12) fragment for one field. */
export function fieldJsonSchema(f) {
  const base = {
    string: { type: 'string' },
    text: { type: 'string' },
    richtext: { type: 'string', contentMediaType: 'text/markdown' },
    uid: { type: 'string', pattern: UID_PATTERN.source },
    email: { type: 'string', format: 'email' },
    url: { type: 'string', format: 'uri' },
    integer: { type: 'integer' },
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    datetime: { type: 'string', format: 'date-time' },
    date: { type: 'string', format: 'date' },
    geopoint: {
      type: 'object',
      properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 }, label: { type: 'string', maxLength: 200 } },
      required: ['lat', 'lng'],
      additionalProperties: false,
      description: 'Map pin (WGS 84)',
    },
    enum: { type: 'string', enum: f.options },
    tags: { type: 'array', items: { type: 'string', maxLength: MAX_TAG_LENGTH }, uniqueItems: true, maxItems: MAX_TAGS },
    json: {},
    media: { type: 'string', format: 'uuid', description: 'Media file id' },
    relation: f.multiple
      ? { type: 'array', items: { type: 'string', format: 'uuid' }, uniqueItems: true, maxItems: MAX_RELATIONS, description: `Ids of items in the "${f.target}" stream` }
      : { type: 'string', format: 'uuid', description: `Id of an item in the "${f.target}" stream` },
  }[f.type];
  const schema = { ...base };
  if (f.maxLength && f.type !== 'enum') schema.maxLength = f.maxLength;
  if (f.min !== undefined) schema.minimum = f.min;
  if (f.max !== undefined) schema.maximum = f.max;
  if (f.description) schema.description = [f.description, schema.description].filter(Boolean).join(' — ');
  return schema;
}
