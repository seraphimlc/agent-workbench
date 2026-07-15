import { createReadStream, createWriteStream } from 'node:fs';

const daemonInput = createReadStream('/dev/null', { fd: 3, autoClose: false });
const daemonOutput = createWriteStream('/dev/null', { fd: 4, autoClose: false });
let buffer = Buffer.alloc(0);

const writeFrame = (value: unknown): void => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  daemonOutput.write(frame);
};

daemonInput.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.byteLength < 4) return;
  const length = buffer.readUInt32BE(0);
  if (buffer.byteLength < 4 + length) return;
  const value = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as {
    readonly payload: Record<string, unknown>;
  };
  const binding = value.payload;
  writeFrame({
    kind: 'request',
    protocolVersion: 1,
    requestId: 'resistant-ready',
    traceId: 'resistant-trace',
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    binding,
    method: 'runner.ready',
    payload: {},
  });
});

process.on('SIGTERM', () => undefined);
setInterval(() => undefined, 60_000);
