const REDACTION = '[REDACTED]';

const normalizedSecrets = (secrets: readonly string[]): readonly string[] =>
  [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

const redactionPlaceholder = (secrets: readonly string[]): string => {
  if (secrets.every((secret) => !REDACTION.includes(secret))) return REDACTION;
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (secrets.every((secret) => !candidate.includes(secret))) return candidate;
  }
  return '';
};

export const redactSecrets = (value: string, secrets: readonly string[]): string => {
  const normalized = normalizedSecrets(secrets);
  const placeholder = redactionPlaceholder(normalized);
  let redacted = value;
  for (const secret of normalized) {
    redacted = redacted.split(secret).join(placeholder);
  }
  return redacted;
};

export const redactAndLimit = (
  value: string,
  secrets: readonly string[],
  maxBytes: number,
): string =>
  Buffer.from(redactSecrets(value, secrets), 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
