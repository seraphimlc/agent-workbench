import type Database from 'better-sqlite3';
import type { ZodType } from 'zod';

import { canonicalJson } from './canonical-json.js';
import { domainErrors } from './errors.js';

type StoredIdempotency = {
  readonly normalized_payload_hash: string;
  readonly result_json: string;
};

export type IdempotencyLookup<Result> =
  | { readonly hit: false }
  | { readonly hit: true; readonly result: Result };

export class IdempotencyRepository {
  constructor(private readonly database: Database.Database) {}

  lookup<Result>(
    method: string,
    clientRequestId: string,
    normalizedPayloadHash: string,
    resultSchema: ZodType<Result>,
  ): IdempotencyLookup<Result> {
    const stored = this.database
      .prepare(
        `SELECT normalized_payload_hash, result_json
         FROM rpc_idempotency
         WHERE method = ? AND client_request_id = ?`,
      )
      .get(method, clientRequestId) as StoredIdempotency | undefined;
    if (!stored) {
      return { hit: false };
    }
    if (stored.normalized_payload_hash !== normalizedPayloadHash) {
      throw domainErrors.idempotencyConflict();
    }

    return {
      hit: true,
      result: resultSchema.parse(JSON.parse(stored.result_json)),
    };
  }

  insert(
    method: string,
    clientRequestId: string,
    normalizedPayloadHash: string,
    result: unknown,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO rpc_idempotency (
          method, client_request_id, normalized_payload_hash, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        method,
        clientRequestId,
        normalizedPayloadHash,
        canonicalJson(result),
        createdAt,
      );
  }
}
