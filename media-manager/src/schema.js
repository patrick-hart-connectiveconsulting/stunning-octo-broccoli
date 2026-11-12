// Stream datasets: field definitions and validation of event data against them.

export const FIELD_TYPES = ['string', 'text', 'integer', 'number', 'boolean', 'datetime', 'enum', 'json', 'media'];

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 100;

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

    if (raw.type === 'string' || raw.type === 'text') {
      const fallback = raw.type === 'string' ? 255 : 100000;
      const max = raw.maxLength ?? fallback;
      if (!Number.isInteger(max) || max < 1 || max > 1000000) err('maxLength must be an integer between 1 and 1000000');
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
    return field;
  });

  return errors.length ? { errors } : { fields };
}

/**
 * Validates and normalises an event's data object against the stream fields.
 * Streams without fields accept any JSON object.
 * Returns { data } or { errors: [{ path, message }] }.
 */
export function validateData(fields, data, { mediaExists = () => true } = {}) {
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
    if (value === undefined || value === null || value === '') {
      if (field.required) errors.push({ path, message: 'is required' });
      out[field.name] = null;
      continue;
    }
    const result = coerce(field, value, mediaExists);
    if (result.error) errors.push({ path, message: result.error });
    else out[field.name] = result.value;
  }
  return errors.length ? { errors } : { data: out };
}

function coerce(field, value, mediaExists) {
  switch (field.type) {
    case 'string':
    case 'text':
      if (typeof value !== 'string') return { error: 'must be a string' };
      if (value.length > field.maxLength) return { error: `must be at most ${field.maxLength} characters` };
      return { value };
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
    case 'enum':
      return field.options.includes(value) ? { value } : { error: `must be one of: ${field.options.join(', ')}` };
    case 'json':
      return { value };
    case 'media':
      if (typeof value !== 'string') return { error: 'must be a media file id' };
      return mediaExists(value) ? { value } : { error: 'media file does not exist' };
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
