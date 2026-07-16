import { describe, expect, it } from 'vitest';

type RuntimeSecurity = {
  readonly port: number;
  readonly csrfToken: string;
};

type SecurityInput = {
  readonly method: string;
  readonly host?: string | undefined;
  readonly origin?: string | undefined;
  readonly contentType?: string | undefined;
  readonly csrfToken?: string | undefined;
};

type SecurityDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly statusCode: number;
      readonly code: string;
    };

type HttpSecurityModule = {
  createRuntimeSecurity(
    port: number,
    csrfToken?: string,
  ): RuntimeSecurity;
  createCspNonce(): string;
  validateBrowserRequest(
    request: SecurityInput,
    runtimeSecurity: RuntimeSecurity,
  ): SecurityDecision;
  createHttpSecurityHeaders(
    kind: 'api' | 'html',
    cspNonce?: string,
  ): Readonly<Record<string, string>>;
  replaceCspNoncePlaceholder(
    html: string,
    placeholder: string,
    cspNonce: string,
  ): string;
  injectCsrfMeta(html: string, runtimeSecurity: RuntimeSecurity): string;
};

const loadHttpSecurity = async (): Promise<HttpSecurityModule> =>
  (await import('./http-security.js')) as unknown as HttpSecurityModule;

const allowed = { allowed: true } as const;
const viteCspNoncePlaceholder = 'agent-workbench-csp-nonce-placeholder';
const responseCspNonce = 'response-csp-nonce';

describe('web console HTTP security', () => {
  it.each(['localhost:4173', '127.0.0.1:4173'])(
    'accepts the exact loopback Host %s',
    async (host) => {
      const { createRuntimeSecurity, validateBrowserRequest } =
        await loadHttpSecurity();
      const security = createRuntimeSecurity(4173, 'csrf-token');

      expect(validateBrowserRequest({ method: 'GET', host }, security)).toEqual(
        allowed,
      );
    },
  );

  it.each([
    undefined,
    'localhost',
    'localhost:4174',
    '127.0.0.1',
    '127.0.0.1:4174',
    '[::1]:4173',
    'evil.test:4173',
    'localhost:4173.evil.test',
  ])('rejects a non-exact Host value %s', async (host) => {
    const { createRuntimeSecurity, validateBrowserRequest } =
      await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token');

    expect(validateBrowserRequest({ method: 'GET', host }, security)).toEqual({
      allowed: false,
      statusCode: 400,
      code: 'WEB_HOST_REJECTED',
    });
  });

  it('requires a GET Origin, when present, to exactly match the Host origin', async () => {
    const { createRuntimeSecurity, validateBrowserRequest } =
      await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token');

    expect(
      validateBrowserRequest(
        {
          method: 'GET',
          host: 'localhost:4173',
          origin: 'http://localhost:4173',
        },
        security,
      ),
    ).toEqual(allowed);
    expect(
      validateBrowserRequest(
        {
          method: 'GET',
          host: 'localhost:4173',
          origin: 'http://127.0.0.1:4173',
        },
        security,
      ),
    ).toEqual({
      allowed: false,
      statusCode: 403,
      code: 'WEB_ORIGIN_REJECTED',
    });
  });

  it.each([undefined, 'http://evil.test', 'null', 'https://localhost:4173'])(
    'rejects a mutation Origin %s',
    async (origin) => {
      const { createRuntimeSecurity, validateBrowserRequest } =
        await loadHttpSecurity();
      const security = createRuntimeSecurity(4173, 'csrf-token');

      expect(
        validateBrowserRequest(
          {
            method: 'POST',
            host: 'localhost:4173',
            origin,
            contentType: 'application/json',
            csrfToken: 'csrf-token',
          },
          security,
        ),
      ).toEqual({
        allowed: false,
        statusCode: 403,
        code: 'WEB_ORIGIN_REJECTED',
      });
    },
  );

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON ; Charset=UTF-8',
  ])('accepts mutation content type %s', async (contentType) => {
    const { createRuntimeSecurity, validateBrowserRequest } =
      await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token');

    expect(
      validateBrowserRequest(
        {
          method: 'POST',
          host: 'localhost:4173',
          origin: 'http://localhost:4173',
          contentType,
          csrfToken: 'csrf-token',
        },
        security,
      ),
    ).toEqual(allowed);
  });

  it.each([
    undefined,
    'text/plain',
    'application/jsonp',
    'application/json; charset=iso-8859-1',
    'application/json; boundary=x',
  ])('rejects mutation content type %s', async (contentType) => {
    const { createRuntimeSecurity, validateBrowserRequest } =
      await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token');

    expect(
      validateBrowserRequest(
        {
          method: 'POST',
          host: 'localhost:4173',
          origin: 'http://localhost:4173',
          contentType,
          csrfToken: 'csrf-token',
        },
        security,
      ),
    ).toEqual({
      allowed: false,
      statusCode: 415,
      code: 'WEB_CONTENT_TYPE_REJECTED',
    });
  });

  it.each([undefined, '', 'wrong-token'])(
    'rejects mutation CSRF token %s',
    async (csrfToken) => {
      const { createRuntimeSecurity, validateBrowserRequest } =
        await loadHttpSecurity();
      const security = createRuntimeSecurity(4173, 'csrf-token');

      expect(
        validateBrowserRequest(
          {
            method: 'POST',
            host: 'localhost:4173',
            origin: 'http://localhost:4173',
            contentType: 'application/json',
            csrfToken,
          },
          security,
        ),
      ).toEqual({
        allowed: false,
        statusCode: 403,
        code: 'WEB_CSRF_REJECTED',
      });
    },
  );

  it('rejects OPTIONS without emitting CORS response headers', async () => {
    const {
      createRuntimeSecurity,
      validateBrowserRequest,
      createHttpSecurityHeaders,
    } = await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token');

    expect(
      validateBrowserRequest(
        {
          method: 'OPTIONS',
          host: 'localhost:4173',
          origin: 'http://evil.test',
        },
        security,
      ),
    ).toEqual({
      allowed: false,
      statusCode: 405,
      code: 'WEB_METHOD_REJECTED',
    });
    expect(
      Object.keys(createHttpSecurityHeaders('api')).some((header) =>
        header.toLowerCase().startsWith('access-control-'),
      ),
    ).toBe(false);
  });

  it('provides unchanged API headers and an exact nonce-scoped HTML CSP', async () => {
    const { createHttpSecurityHeaders } = await loadHttpSecurity();

    expect(createHttpSecurityHeaders('api')).toEqual({
      'cache-control': 'no-store',
    });
    expect(createHttpSecurityHeaders('html', responseCspNonce)).toEqual({
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; connect-src 'self'; style-src 'self' 'nonce-response-csp-nonce'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    });
  });

  it.each(['', 'nonce value', "nonce'; style-src *"])(
    'rejects an invalid CSP nonce %s',
    async (cspNonce) => {
      const { createHttpSecurityHeaders } = await loadHttpSecurity();

      expect(() =>
        createHttpSecurityHeaders('html', cspNonce),
      ).toThrow('Invalid web console runtime security configuration');
    },
  );

  it('replaces every Vite nonce placeholder with one response nonce', async () => {
    const { replaceCspNoncePlaceholder } = await loadHttpSecurity();
    const transformed =
      `<html><head><meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}">` +
      `<style nonce="${viteCspNoncePlaceholder}">body{display:grid}</style>` +
      `</head><body><script nonce="${viteCspNoncePlaceholder}"></script></body></html>`;

    const replaced = replaceCspNoncePlaceholder(
      transformed,
      viteCspNoncePlaceholder,
      responseCspNonce,
    );

    expect(replaced).not.toContain(viteCspNoncePlaceholder);
    expect(replaced.match(/nonce="response-csp-nonce"/g)).toHaveLength(3);
  });

  it.each([
    [
      'missing CSP nonce metadata',
      `<html><head><style nonce="${viteCspNoncePlaceholder}"></style></head></html>`,
    ],
    [
      'duplicate CSP nonce metadata',
      `<html><head><meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}">` +
        `<meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}"></head></html>`,
    ],
    [
      'placeholder outside a nonce attribute',
      `<html><head><meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}">` +
        `<meta name="unexpected" content="${viteCspNoncePlaceholder}"></head></html>`,
    ],
    [
      'an unexpected nonce attribute value',
      `<html><head><meta property="csp-nonce" nonce="${viteCspNoncePlaceholder}">` +
        '<style nonce="unexpected-nonce"></style></head></html>',
    ],
  ])('fails closed for %s', async (_description, transformed) => {
    const { replaceCspNoncePlaceholder } = await loadHttpSecurity();

    expect(() =>
      replaceCspNoncePlaceholder(
        transformed,
        viteCspNoncePlaceholder,
        responseCspNonce,
      ),
    ).toThrow('Invalid Vite CSP nonce transformation');
  });

  it('injects the CSRF token into HTML metadata without placing it in a URL', async () => {
    const { createRuntimeSecurity, injectCsrfMeta } = await loadHttpSecurity();
    const security = createRuntimeSecurity(4173, 'csrf-token&value');
    const html = '<html><head><title>Workbench</title></head><body></body></html>';
    const injected = injectCsrfMeta(html, security);

    expect(injected).toContain(
      '<meta name="agent-workbench-csrf" content="csrf-token&amp;value">',
    );
    expect(injected).not.toContain('?csrf');
    expect(injected.indexOf('<meta')).toBeLessThan(injected.indexOf('</head>'));
    expect('cspNonce' in security).toBe(false);
    expect(JSON.stringify(security)).toBe('{"port":4173}');
  });
});
