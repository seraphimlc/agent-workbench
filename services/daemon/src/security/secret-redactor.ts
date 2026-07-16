const REDACTION = '[REDACTED]';

const normalizedSecrets = (secrets: readonly string[]): readonly string[] =>
  [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

export const redactSecrets = (value: string, secrets: readonly string[]): string => {
  let redacted = value;
  for (const secret of normalizedSecrets(secrets)) {
    redacted = redacted.split(secret).join(REDACTION);
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
