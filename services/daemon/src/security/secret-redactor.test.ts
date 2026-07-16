import { describe, expect, it } from 'vitest';

import { redactAndLimit, redactSecrets } from './secret-redactor.js';

describe('redactSecrets', () => {
  it('ignores empty secrets', () => {
    expect(redactSecrets('visible value', ['', ''])).toBe('visible value');
  });

  it('handles repeated secret values', () => {
    expect(redactSecrets('token token', ['token', 'token'])).toBe(
      '[REDACTED] [REDACTED]',
    );
  });

  it('redacts overlapping secrets longest first', () => {
    expect(redactSecrets('abcd abc', ['abc', 'abcd'])).toBe(
      '[REDACTED] [REDACTED]',
    );
  });

  it('redacts UTF-8 secrets', () => {
    expect(redactSecrets('before 密钥 after', ['密钥'])).toBe(
      'before [REDACTED] after',
    );
  });
});

describe('redactAndLimit', () => {
  it('redacts before truncating by UTF-8 bytes', () => {
    const result = redactAndLimit('prefix token suffix', ['token'], 12);

    expect(result).toBe('prefix [REDA');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(12);
  });

  it('does not split a UTF-8 code point at the byte limit', () => {
    const result = redactAndLimit('你好世界', [], 7);

    expect(result).toBe('你好');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(7);
  });
});
