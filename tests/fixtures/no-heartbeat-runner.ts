import { createReadStream, createWriteStream } from 'node:fs';

const daemonInput = createReadStream('/dev/null', { fd: 3, autoClose: false });
const daemonOutput = createWriteStream('/dev/null', { fd: 4, autoClose: false });
let buffer = Buffer.alloc(0);
let readySent = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const writeFrame = (value: unknown): void => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  daemonOutput.write(frame);
};

const handleFrame = (body: Buffer): void => {
  if (readySent) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    process.exitCode = 1;
    daemonInput.destroy();
    return;
  }
  if (!isRecord(parsed) || parsed.method !== 'runner.bind' || !isRecord(parsed.payload)) {
    process.exitCode = 1;
    daemonInput.destroy();
    return;
  }
  const binding = parsed.payload;
  if (typeof binding.sessionId !== 'string' || typeof binding.turnId !== 'string') {
    process.exitCode = 1;
    daemonInput.destroy();
    return;
  }
  readySent = true;
  writeFrame({
    kind: 'request',
    protocolVersion: 1,
    requestId: 'no-heartbeat-ready',
    traceId: 'no-heartbeat-trace',
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    binding,
    method: 'runner.ready',
    payload: {},
  });
};

daemonInput.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.byteLength >= 4) {
    const bodyLength = buffer.readUInt32BE(0);
    if (buffer.byteLength < 4 + bodyLength) return;
    const body = buffer.subarray(4, 4 + bodyLength);
    buffer = buffer.subarray(4 + bodyLength);
    handleFrame(body);
  }
});

daemonInput.on('error', () => {
  process.exitCode = 1;
});
daemonOutput.on('error', () => {
  process.exitCode = 1;
});
setInterval(() => undefined, 60_000);
