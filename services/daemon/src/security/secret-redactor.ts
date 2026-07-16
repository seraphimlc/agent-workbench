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
): string => {
  const redacted = redactSecrets(value, secrets);
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maxBytes) return redacted;

  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
};
