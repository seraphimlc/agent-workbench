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

  it('chooses a placeholder that does not collide with any secret', () => {
    const secrets = ['token', '[REDACTED]', 'REDACTED', '['];
    const result = redactSecrets('token', secrets);

    expect(result).not.toBe('');
    expect(result).not.toBe('[REDACTED]');
    for (const secret of secrets) expect(result).not.toContain(secret);
  });
});

describe('redactAndLimit', () => {
  it('redacts before truncating by UTF-8 bytes', () => {
    const result = redactAndLimit('prefix token suffix', ['token'], 12);

    expect(result).toBe('prefix [REDA');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(12);
  });

  it('preserves Buffer truncation semantics for partial UTF-8 code points', () => {
    const result = redactAndLimit('你好世界', [], 7);

    expect(result).toBe('你好�');
  });
});
