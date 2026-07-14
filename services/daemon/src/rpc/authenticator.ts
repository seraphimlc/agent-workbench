import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { AuthRespondPayload } from '@agent-workbench/protocol';

export type AuthenticatorState = 'pending' | 'authenticated' | 'failed';

const MAC_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const computeAuthMac = (secret: Uint8Array, nonce: string): Buffer =>
  createHmac('sha256', secret).update(`${nonce}1`, 'utf8').digest();

export class Authenticator {
  readonly challengeNonce = randomBytes(32).toString('hex');

  private readonly secret: Buffer;
  private nonce: string | undefined;
  private currentState: AuthenticatorState = 'pending';

  constructor(secret: Uint8Array) {
    this.secret = Buffer.from(secret);
    this.nonce = this.challengeNonce;
  }

  get state(): AuthenticatorState {
    return this.currentState;
  }

  authenticate(payload: AuthRespondPayload): boolean {
    if (this.currentState !== 'pending' || this.nonce === undefined) {
      this.currentState = 'failed';
      return false;
    }

    const expectedNonce = this.nonce;
    this.nonce = undefined;
    this.currentState = 'failed';
    const expectedMac = computeAuthMac(this.secret, expectedNonce);

    try {
      const macFormatIsValid = MAC_HEX_PATTERN.test(payload.mac);
      const actualMac = macFormatIsValid
        ? Buffer.from(payload.mac, 'hex')
        : Buffer.alloc(expectedMac.byteLength);
      const nonceMatches = payload.nonce === expectedNonce;
      const macMatches = timingSafeEqual(actualMac, expectedMac);
      const authenticated = nonceMatches && macFormatIsValid && macMatches;

      if (authenticated) {
        this.currentState = 'authenticated';
      }

      actualMac.fill(0);
      return authenticated;
    } finally {
      expectedMac.fill(0);
    }
  }

  reject(): void {
    this.nonce = undefined;
    this.currentState = 'failed';
  }

  destroy(): void {
    this.reject();
    this.secret.fill(0);
  }
}
