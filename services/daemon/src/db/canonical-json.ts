import { createHash } from 'node:crypto';

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalize((value as Record<string, unknown>)[key]);
  }
  return normalized;
};

export const canonicalJson = (value: unknown): string => {
  const encoded = JSON.stringify(normalize(value));
  if (encoded === undefined) {
    throw new Error('Value cannot be encoded as JSON');
  }
  return encoded;
};

export const hashCanonicalJson = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
