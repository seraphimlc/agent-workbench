import type { RpcRequest } from '@agent-workbench/protocol';

import { SessionService } from '../runtime/session-service.js';

export interface RouterNotifier {
  notify(): void;
}

export class Router {
  constructor(
    private readonly sessions: SessionService,
    private readonly notifier?: RouterNotifier,
  ) {}

  async handle(request: RpcRequest): Promise<unknown> {
    switch (request.method) {
      case 'app.health': {
        await new Promise<void>((resolvePromise) => {
          setImmediate(resolvePromise);
        });
        return {
          status: 'ready',
          protocolVersion: 1,
          pid: process.pid,
        };
      }
      case 'workspace.register':
        return this.sessions.registerWorkspace(
          request.payload,
          request.clientRequestId,
        );
      case 'session.create': {
        const result = this.sessions.createSession(
          request.payload,
          request.clientRequestId,
        );
        this.notifier?.notify();
        return result;
      }
      case 'session.getSnapshot':
        return this.sessions.getSnapshot(request.payload.sessionId);
      case 'turn.enqueue': {
        const result = this.sessions.enqueueTurn(
          request.payload,
          request.clientRequestId,
        );
        this.notifier?.notify();
        return result;
      }
      case 'event.listAfter':
        return this.sessions.listEventsAfter(request.payload);
      case 'auth.respond':
        throw new Error('Authentication requests do not route to handlers');
    }
  }
}
