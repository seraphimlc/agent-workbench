import { describe, expect, it } from 'vitest';

import * as protocol from './index.js';

const TEST_MAX_FRAME_BYTES = 16 * 1024 * 1024;

type Decoder = {
  push: (chunk: Uint8Array) => unknown[];
};

type CodecExports = {
  MAX_FRAME_BYTES: number;
  encodeFrame: (value: unknown) => Buffer;
  FrameDecoder: new () => Decoder;
  FrameCodecError: new (...args: never[]) => Error & { readonly reason: string };
};

const requireCodec = (): CodecExports => {
  const codec = protocol as Partial<CodecExports>;

  expect(codec.MAX_FRAME_BYTES, 'MAX_FRAME_BYTES should be exported').toBe(
    TEST_MAX_FRAME_BYTES,
  );
  expect(typeof codec.encodeFrame, 'encodeFrame should be exported').toBe('function');
  expect(typeof codec.FrameDecoder, 'FrameDecoder should be exported').toBe('function');
  expect(typeof codec.FrameCodecError, 'FrameCodecError should be exported').toBe('function');

  return codec as CodecExports;
};

const frameFromBody = (body: Uint8Array): Buffer => {
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  frame.set(body, 4);
  return frame;
};

const frameFromText = (text: string): Buffer => frameFromBody(Buffer.from(text, 'utf8'));

const expectCodecError = (
  action: () => unknown,
  reason: string,
  ErrorClass: CodecExports['FrameCodecError'],
): void => {
  let caught: unknown;

  try {
    action();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ErrorClass);
  expect(caught).toMatchObject({ name: 'FrameCodecError', reason });
};

const nestedArrayValue = (depth: number): unknown => {
  let value: unknown = 0;

  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }

  return value;
};

const nestedArrayText = (depth: number): string =>
  `${'['.repeat(depth)}0${']'.repeat(depth)}`;

describe('frame codec', () => {
  it('exports the codec API and uses exactly four big-endian length bytes', () => {
    const { encodeFrame } = requireCodec();
    const frame = encodeFrame({ ok: true });
    const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');

    expect(frame.subarray(0, 4)).toEqual(
      Buffer.from([0, 0, 0, body.byteLength]),
    );
    expect(frame.subarray(4)).toEqual(body);
    expect(frame).toHaveLength(4 + body.byteLength);
  });

  it('decodes a header and body fragmented across arbitrary push calls', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const value = { message: 'fragmented', values: [1, 2, 3] };
    const frame = encodeFrame(value);
    const cuts = [1, 3, 4, 6, 11, frame.byteLength - 1, frame.byteLength];
    const decoder = new FrameDecoder();
    let offset = 0;

    for (const cut of cuts.slice(0, -1)) {
      expect(decoder.push(frame.subarray(offset, cut))).toEqual([]);
      offset = cut;
    }

    expect(decoder.push(frame.subarray(offset, cuts.at(-1)))).toEqual([value]);
  });

  it('decodes multiple complete frames from one chunk', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const values = [{ id: 1 }, ['two', 2], 'line one\nline two'];
    const chunk = Buffer.concat(values.map((value) => encodeFrame(value)));

    expect(new FrameDecoder().push(chunk)).toEqual(values);
  });

  it('returns a complete frame and retains only the partial next frame', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const first = { id: 'first' };
    const second = { id: 'second', payload: [1, 2, 3] };
    const secondFrame = encodeFrame(second);
    const decoder = new FrameDecoder();

    expect(
      decoder.push(Buffer.concat([encodeFrame(first), secondFrame.subarray(0, 7)])),
    ).toEqual([first]);
    expect(decoder.push(secondFrame.subarray(7))).toEqual([second]);
  });

  it(
    'accepts a JSON body exactly 16 MiB long',
    { timeout: 30_000 },
    () => {
      const { encodeFrame, FrameDecoder } = requireCodec();
      const value = 'x'.repeat(TEST_MAX_FRAME_BYTES - 2);
      const frame = encodeFrame(value);

      expect(frame.readUInt32BE(0)).toBe(TEST_MAX_FRAME_BYTES);
      expect(frame).toHaveLength(TEST_MAX_FRAME_BYTES + 4);

      const decoded = new FrameDecoder().push(frame);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]).toBe(value);
    },
  );

  it('rejects a declared body over 16 MiB from the header alone', () => {
    const { FrameCodecError, FrameDecoder } = requireCodec();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(TEST_MAX_FRAME_BYTES + 1, 0);

    expectCodecError(
      () => new FrameDecoder().push(header),
      'frame_too_large',
      FrameCodecError,
    );
  });

  it('rejects invalid UTF-8 instead of inserting replacement characters', () => {
    const { FrameCodecError, FrameDecoder } = requireCodec();
    const invalidUtf8 = frameFromBody(Buffer.from([0xc3, 0x28]));

    expectCodecError(
      () => new FrameDecoder().push(invalidUtf8),
      'invalid_utf8',
      FrameCodecError,
    );
  });

  it('rejects invalid JSON', () => {
    const { FrameCodecError, FrameDecoder } = requireCodec();

    expectCodecError(
      () => new FrameDecoder().push(frameFromText('{"broken":]')),
      'invalid_json',
      FrameCodecError,
    );
  });

  it('accepts JSON nesting depth 64', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const value = nestedArrayValue(64);
    const [decoded] = new FrameDecoder().push(encodeFrame(value));
    let cursor = decoded;

    for (let depth = 0; depth < 64; depth += 1) {
      expect(Array.isArray(cursor)).toBe(true);
      cursor = (cursor as unknown[])[0];
    }

    expect(cursor).toBe(0);
  });

  it('rejects JSON nesting depth 65 when encoding and decoding', () => {
    const { encodeFrame, FrameCodecError, FrameDecoder } = requireCodec();

    expectCodecError(
      () => encodeFrame(nestedArrayValue(65)),
      'json_depth_exceeded',
      FrameCodecError,
    );
    expectCodecError(
      () => new FrameDecoder().push(frameFromText(nestedArrayText(65))),
      'json_depth_exceeded',
      FrameCodecError,
    );
  });

  it('treats an empty input chunk as a no-op without disturbing partial input', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const frame = encodeFrame({ after: 'empty chunks' });
    const decoder = new FrameDecoder();

    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(frame.subarray(2))).toEqual([{ after: 'empty chunks' }]);
  });

  it('rejects a declared zero-length frame', () => {
    const { FrameCodecError, FrameDecoder } = requireCodec();

    expectCodecError(
      () => new FrameDecoder().push(Buffer.alloc(4)),
      'empty_frame',
      FrameCodecError,
    );
  });

  it('permanently fails after a header-time codec error', () => {
    const { encodeFrame, FrameCodecError, FrameDecoder } = requireCodec();
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(TEST_MAX_FRAME_BYTES + 1, 0);
    const malformedHeaders = [
      { frame: oversizedHeader, reason: 'frame_too_large' },
      { frame: Buffer.alloc(4), reason: 'empty_frame' },
    ] as const;
    const validFrame = encodeFrame({ valid: true });

    for (const { frame, reason } of malformedHeaders) {
      const decoder = new FrameDecoder();

      expectCodecError(() => decoder.push(frame), reason, FrameCodecError);
      expectCodecError(
        () => decoder.push(new Uint8Array()),
        'decoder_failed',
        FrameCodecError,
      );
      expectCodecError(
        () => decoder.push(validFrame),
        'decoder_failed',
        FrameCodecError,
      );
    }
  });

  it('permanently fails after a body-time codec error', () => {
    const { encodeFrame, FrameCodecError, FrameDecoder } = requireCodec();
    const malformedBodies = [
      {
        frame: frameFromBody(Buffer.from([0xc3, 0x28])),
        reason: 'invalid_utf8',
      },
      { frame: frameFromText('{"broken":]'), reason: 'invalid_json' },
      {
        frame: frameFromText(nestedArrayText(65)),
        reason: 'json_depth_exceeded',
      },
    ] as const;
    const validFrame = encodeFrame({ valid: true });

    for (const { frame, reason } of malformedBodies) {
      const decoder = new FrameDecoder();

      expectCodecError(() => decoder.push(frame), reason, FrameCodecError);
      expectCodecError(
        () => decoder.push(validFrame),
        'decoder_failed',
        FrameCodecError,
      );
    }
  });

  it('uses length prefixes rather than newlines as frame delimiters', () => {
    const { encodeFrame, FrameDecoder } = requireCodec();
    const value = {
      message: 'first line\nsecond line',
      syntaxInsideString: `${'{[\\"'.repeat(70)}${'\\"]}'.repeat(70)}`,
    };
    const formattedJson = '{\n  "message": "first line\\nsecond line"\n}';
    const chunk = Buffer.concat([frameFromText(formattedJson), encodeFrame(value)]);

    expect(new FrameDecoder().push(chunk)).toEqual([
      { message: 'first line\nsecond line' },
      value,
    ]);
  });

  it('rejects an encoded body over 16 MiB', { timeout: 30_000 }, () => {
    const { encodeFrame, FrameCodecError } = requireCodec();
    const value = 'x'.repeat(TEST_MAX_FRAME_BYTES - 1);

    expectCodecError(
      () => encodeFrame(value),
      'frame_too_large',
      FrameCodecError,
    );
  });

  it('rejects a root value that JSON cannot serialize', () => {
    const { encodeFrame, FrameCodecError } = requireCodec();

    expectCodecError(
      () => encodeFrame(undefined),
      'value_not_serializable',
      FrameCodecError,
    );
  });
});
