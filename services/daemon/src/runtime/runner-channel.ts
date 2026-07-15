import { timingSafeEqual } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import {
  createRunnerRequestSchema,
  encodeFrame,
  FrameDecoder,
  type RunnerBinding,
  type RunnerRequest,
} from '@agent-workbench/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class RunnerChannel {
  private readonly decoder = new FrameDecoder();
  private readonly expectedCapability: Buffer;
  private started = false;
  private settled = false;
  private fenced = false;
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    private readonly options: {
      readonly readable: Readable;
      readonly writable: Writable;
      readonly binding: RunnerBinding;
      readonly onAuthorizedRequest: (request: RunnerRequest) => void;
    },
  ) {
    this.expectedCapability = Buffer.from(options.binding.capability, 'utf8');
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.readable.on('data', this.onData);
    this.options.readable.once('end', this.close);
    this.options.readable.once('error', this.close);
    this.options.writable.once('error', this.close);
  }

  write(value: unknown): void {
    if (this.settled || this.options.writable.destroyed) {
      throw new Error('Runner channel is closed');
    }
    this.options.writable.write(encodeFrame(value));
  }

  fence(): void {
    this.fenced = true;
  }

  close = (): void => {
    if (this.settled) return;
    this.settled = true;
    this.options.readable.off('data', this.onData);
    this.options.readable.destroy();
    this.options.writable.destroy();
    this.resolveClosed();
  };

  private readonly onData = (chunk: Buffer): void => {
    if (this.settled) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch {
      this.close();
      return;
    }
    for (const frame of frames) {
      if (!this.authorize(frame)) {
        this.close();
        return;
      }
    }
  };

  private authorize(value: unknown): boolean {
    if (this.fenced) return false;
    if (!isRecord(value) || !isRecord(value.binding)) return false;
    const capability = value.binding.capability;
    if (typeof capability !== 'string') return false;
    const candidate = Buffer.from(capability, 'utf8');
    const comparable = Buffer.alloc(this.expectedCapability.byteLength);
    candidate.copy(comparable, 0, 0, comparable.byteLength);
    const capabilityMatches =
      timingSafeEqual(comparable, this.expectedCapability) &&
      candidate.byteLength === this.expectedCapability.byteLength;
    comparable.fill(0);
    if (!capabilityMatches) return false;

    const parsed = createRunnerRequestSchema(this.options.binding).safeParse(value);
    if (!parsed.success) return false;
    try {
      this.options.onAuthorizedRequest(parsed.data);
      return true;
    } catch {
      return false;
    }
  }
}
