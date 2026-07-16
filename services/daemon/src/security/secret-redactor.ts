const REDACTION = '[REDACTED]';

const normalizedSecrets = (secrets: readonly string[]): readonly string[] =>
  [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

const redactIfSafe = (
  value: string,
  secrets: readonly string[],
  placeholder: string,
): string | undefined => {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join(placeholder);
  }
  return secrets.some((secret) => redacted.includes(secret)) ? undefined : redacted;
};

export const redactSecrets = (value: string, secrets: readonly string[]): string => {
  const normalized = normalizedSecrets(secrets);
  const defaultRedaction = redactIfSafe(value, normalized, REDACTION);
  if (defaultRedaction !== undefined) return defaultRedaction;

  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const redacted = redactIfSafe(value, normalized, String.fromCodePoint(codePoint));
    if (redacted !== undefined) return redacted;
  }
  return '';
};

export const redactAndLimit = (
  value: string,
  secrets: readonly string[],
  maxBytes: number,
): string =>
  Buffer.from(redactSecrets(value, secrets), 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
