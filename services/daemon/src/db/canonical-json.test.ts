import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import * as canonicalJsonModule from './canonical-json.js';

describe('canonical JSON', () => {
  it('recursively sorts object keys while preserving array order and UTF-8 JSON', () => {
    expect(canonicalJsonModule).toHaveProperty('canonicalJson');
    const canonicalJson = (
      canonicalJsonModule as typeof canonicalJsonModule & {
        readonly canonicalJson: (value: unknown) => string;
      }
    ).canonicalJson;

    expect(
      canonicalJson({
        z: [{ beta: '雪', alpha: 1 }, 2],
        a: { y: true, x: null },
      }),
    ).toBe('{"a":{"x":null,"y":true},"z":[{"alpha":1,"beta":"雪"},2]}');
  });

  it('hashes the canonical UTF-8 bytes with SHA-256', () => {
    expect(canonicalJsonModule).toHaveProperty('hashCanonicalJson');
    const hashCanonicalJson = (
      canonicalJsonModule as typeof canonicalJsonModule & {
        readonly hashCanonicalJson: (value: unknown) => string;
      }
    ).hashCanonicalJson;
    const canonical = '{"a":"雪","b":[2,1]}';

    expect(hashCanonicalJson({ b: [2, 1], a: '雪' })).toBe(
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    );
  });
});
