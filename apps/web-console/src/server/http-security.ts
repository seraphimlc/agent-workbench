import { randomBytes, timingSafeEqual } from 'node:crypto';

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

const API_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
});

const HTML_SECURITY_HEADERS = Object.freeze({
  ...API_SECURITY_HEADERS,
  'content-security-policy': CONTENT_SECURITY_POLICY,
});

export type RuntimeSecurity = {
  readonly port: number;
  readonly csrfToken: string;
};

export type BrowserRequestSecurityInput = {
  readonly method: string;
  readonly host?: string | undefined;
  readonly origin?: string | undefined;
  readonly contentType?: string | undefined;
  readonly csrfToken?: string | undefined;
};

export type BrowserRequestSecurityDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly statusCode: 400 | 403 | 405 | 415;
      readonly code:
        | 'WEB_HOST_REJECTED'
        | 'WEB_METHOD_REJECTED'
        | 'WEB_ORIGIN_REJECTED'
        | 'WEB_CONTENT_TYPE_REJECTED'
        | 'WEB_CSRF_REJECTED';
    };

const allowedDecision = Object.freeze({ allowed: true } as const);

const rejected = (
  statusCode: 400 | 403 | 405 | 415,
  code: Exclude<BrowserRequestSecurityDecision, { allowed: true }>['code'],
): BrowserRequestSecurityDecision => ({ allowed: false, statusCode, code });

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

const isJsonContentType = (contentType: string | undefined): boolean =>
  contentType !== undefined &&
  /^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(
    contentType,
  );

const tokensMatch = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};

const escapeHtmlAttribute = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

export const createRuntimeSecurity = (
  port: number,
  csrfToken = randomBytes(32).toString('base64url'),
): RuntimeSecurity => {
  if (!isValidPort(port) || csrfToken.length === 0) {
    throw new Error('Invalid web console runtime security configuration');
  }

  const runtimeSecurity = { port } as RuntimeSecurity;
  Object.defineProperty(runtimeSecurity, 'csrfToken', {
    configurable: false,
    enumerable: false,
    value: csrfToken,
    writable: false,
  });
  return Object.freeze(runtimeSecurity);
};

export const validateBrowserRequest = (
  request: BrowserRequestSecurityInput,
  runtimeSecurity: RuntimeSecurity,
): BrowserRequestSecurityDecision => {
  const acceptedHosts = new Set([
    `localhost:${runtimeSecurity.port}`,
    `127.0.0.1:${runtimeSecurity.port}`,
  ]);
  if (request.host === undefined || !acceptedHosts.has(request.host)) {
    return rejected(400, 'WEB_HOST_REJECTED');
  }

  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') {
    return rejected(405, 'WEB_METHOD_REJECTED');
  }

  const sameOrigin = `http://${request.host}`;
  if (method === 'GET') {
    if (request.origin !== undefined && request.origin !== sameOrigin) {
      return rejected(403, 'WEB_ORIGIN_REJECTED');
    }
    return allowedDecision;
  }

  if (request.origin !== sameOrigin) {
    return rejected(403, 'WEB_ORIGIN_REJECTED');
  }
  if (!isJsonContentType(request.contentType)) {
    return rejected(415, 'WEB_CONTENT_TYPE_REJECTED');
  }
  if (!tokensMatch(request.csrfToken, runtimeSecurity.csrfToken)) {
    return rejected(403, 'WEB_CSRF_REJECTED');
  }

  return allowedDecision;
};

export const createHttpSecurityHeaders = (
  kind: 'api' | 'html',
): Readonly<Record<string, string>> =>
  kind === 'html' ? HTML_SECURITY_HEADERS : API_SECURITY_HEADERS;

export const injectCsrfMeta = (
  html: string,
  runtimeSecurity: RuntimeSecurity,
): string => {
  const closingHead = /<\/head\s*>/i.exec(html);
  if (!closingHead) {
    throw new Error('Web console HTML is missing a closing head element');
  }

  const meta = `<meta name="agent-workbench-csrf" content="${escapeHtmlAttribute(
    runtimeSecurity.csrfToken,
  )}">`;
  return `${html.slice(0, closingHead.index)}${meta}${html.slice(
    closingHead.index,
  )}`;
};
