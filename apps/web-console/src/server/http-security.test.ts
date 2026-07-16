import { describe, expect, it } from 'vitest';

type RuntimeSecurity = {
  readonly port: number;
  readonly csrfToken: string;
  readonly cspNonce: string;
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
    cspNonce?: string,
  ): RuntimeSecurity;
  validateBrowserRequest(
    request: SecurityInput,
    runtimeSecurity: RuntimeSecurity,
  ): SecurityDecision;
  createHttpSecurityHeaders(
    kind: 'api' | 'html',
    runtimeSecurity?: RuntimeSecurity,
  ): Readonly<Record<string, string>>;
  injectCsrfMeta(html: string, runtimeSecurity: RuntimeSecurity): string;
};

const loadHttpSecurity = async (): Promise<HttpSecurityModule> =>
  (await import('./http-security.js')) as unknown as HttpSecurityModule;

const allowed = { allowed: true } as const;

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
    const { createHttpSecurityHeaders, createRuntimeSecurity } =
      await loadHttpSecurity();
    const security = createRuntimeSecurity(
      4173,
      'csrf-token',
      'specific-csp-nonce',
    );

    expect(createHttpSecurityHeaders('api')).toEqual({
      'cache-control': 'no-store',
    });
    expect(createHttpSecurityHeaders('html', security)).toEqual({
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'self'; connect-src 'self'; style-src 'self' 'nonce-specific-csp-nonce'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    });
  });

  it.each(['', 'nonce value', "nonce'; style-src *"])(
    'rejects an invalid CSP nonce %s',
    async (cspNonce) => {
      const { createRuntimeSecurity } = await loadHttpSecurity();

      expect(() =>
        createRuntimeSecurity(4173, 'csrf-token', cspNonce),
      ).toThrow('Invalid web console runtime security configuration');
    },
  );

  it('injects the CSRF token into HTML metadata without placing it in a URL', async () => {
    const { createRuntimeSecurity, injectCsrfMeta } = await loadHttpSecurity();
    const security = createRuntimeSecurity(
      4173,
      'csrf-token&value',
      'specific-csp-nonce',
    );
    const html = '<html><head><title>Workbench</title></head><body></body></html>';
    const injected = injectCsrfMeta(html, security);

    expect(injected).toContain(
      '<meta name="agent-workbench-csrf" content="csrf-token&amp;value">',
    );
    expect(injected).not.toContain('?csrf');
    expect(injected.indexOf('<meta')).toBeLessThan(injected.indexOf('</head>'));
    expect(security.cspNonce).toBe('specific-csp-nonce');
    expect(JSON.stringify(security)).toBe('{"port":4173}');
  });
});
