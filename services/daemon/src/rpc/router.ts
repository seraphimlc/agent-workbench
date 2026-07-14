import type { RpcRequest } from '@agent-workbench/protocol';

export class RouterError extends Error {
  readonly code = 'RPC_NOT_IMPLEMENTED';
}

export class Router {
  async handle(request: RpcRequest): Promise<unknown> {
    if (request.method === 'app.health') {
      await new Promise<void>((resolvePromise) => {
        setImmediate(resolvePromise);
      });
      return {
        status: 'ready',
        protocolVersion: 1,
        pid: process.pid,
      };
    }

    throw new RouterError('RPC method is not implemented in Slice 1A');
  }
}
