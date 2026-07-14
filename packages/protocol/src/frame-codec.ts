export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const FRAME_HEADER_BYTES = 4;
const MAX_JSON_DEPTH = 64;

export type FrameCodecErrorReason =
  | 'frame_too_large'
  | 'empty_frame'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'json_depth_exceeded'
  | 'value_not_serializable'
  | 'decoder_failed';

const ERROR_MESSAGES: Record<FrameCodecErrorReason, string> = {
  frame_too_large: 'Frame body exceeds the maximum size',
  empty_frame: 'Frame body must not be empty',
  invalid_utf8: 'Frame body is not valid UTF-8',
  invalid_json: 'Frame body is not valid JSON',
  json_depth_exceeded: 'JSON nesting depth exceeds the maximum',
  value_not_serializable: 'Value is not JSON serializable',
  decoder_failed: 'Frame decoder is in a failed state',
};

export class FrameCodecError extends Error {
  readonly reason: FrameCodecErrorReason;

  constructor(reason: FrameCodecErrorReason) {
    super(ERROR_MESSAGES[reason]);
    this.name = 'FrameCodecError';
    this.reason = reason;
  }
}

const assertJsonDepth = (text: string): void => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === 0x5c) {
        escaped = true;
      } else if (character === 0x22) {
        inString = false;
      }

      continue;
    }

    if (character === 0x22) {
      inString = true;
    } else if (character === 0x7b || character === 0x5b) {
      depth += 1;

      if (depth > MAX_JSON_DEPTH) {
        throw new FrameCodecError('json_depth_exceeded');
      }
    } else if ((character === 0x7d || character === 0x5d) && depth > 0) {
      depth -= 1;
    }
  }
};

const decodeBody = (body: Uint8Array): unknown => {
  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new FrameCodecError('invalid_utf8');
  }

  assertJsonDepth(text);

  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new FrameCodecError('invalid_json');
  }
};

export const encodeFrame = (value: unknown): Buffer => {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new FrameCodecError('value_not_serializable');
  }

  if (serialized === undefined) {
    throw new FrameCodecError('value_not_serializable');
  }

  const body = new TextEncoder().encode(serialized);

  if (body.byteLength > MAX_FRAME_BYTES) {
    throw new FrameCodecError('frame_too_large');
  }

  assertJsonDepth(serialized);

  const frame = new Uint8Array(FRAME_HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, false);
  frame.set(body, FRAME_HEADER_BYTES);
  return Buffer.from(frame);
};

export class FrameDecoder {
  private readonly header = new Uint8Array(FRAME_HEADER_BYTES);
  private readonly headerView = new DataView(this.header.buffer);
  private headerBytes = 0;
  private body: Uint8Array | null = null;
  private bodyBytes = 0;
  private failed = false;

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) {
      throw new FrameCodecError('decoder_failed');
    }

    try {
      return this.consume(chunk);
    } catch (error) {
      if (error instanceof FrameCodecError) {
        this.failed = true;
      }

      throw error;
    }
  }

  private consume(chunk: Uint8Array): unknown[] {
    const values: unknown[] = [];
    let offset = 0;

    while (offset < chunk.byteLength) {
      if (this.body === null) {
        const headerBytesToCopy = Math.min(
          FRAME_HEADER_BYTES - this.headerBytes,
          chunk.byteLength - offset,
        );
        this.header.set(
          chunk.subarray(offset, offset + headerBytesToCopy),
          this.headerBytes,
        );
        this.headerBytes += headerBytesToCopy;
        offset += headerBytesToCopy;

        if (this.headerBytes < FRAME_HEADER_BYTES) {
          continue;
        }

        const declaredBodyBytes = this.headerView.getUint32(0, false);
        this.headerBytes = 0;

        if (declaredBodyBytes === 0) {
          throw new FrameCodecError('empty_frame');
        }

        if (declaredBodyBytes > MAX_FRAME_BYTES) {
          throw new FrameCodecError('frame_too_large');
        }

        this.body = new Uint8Array(declaredBodyBytes);
        this.bodyBytes = 0;
      }

      const body = this.body;
      const bodyBytesToCopy = Math.min(
        body.byteLength - this.bodyBytes,
        chunk.byteLength - offset,
      );
      body.set(chunk.subarray(offset, offset + bodyBytesToCopy), this.bodyBytes);
      this.bodyBytes += bodyBytesToCopy;
      offset += bodyBytesToCopy;

      if (this.bodyBytes === body.byteLength) {
        this.body = null;
        this.bodyBytes = 0;
        values.push(decodeBody(body));
      }
    }

    return values;
  }
}
