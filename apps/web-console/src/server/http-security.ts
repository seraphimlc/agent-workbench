import { randomBytes, timingSafeEqual } from 'node:crypto';

const API_SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
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

const isValidCspNonce = (cspNonce: string): boolean =>
  /^[A-Za-z0-9+/_-]+={0,2}$/.test(cspNonce);

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

const readQuotedHtmlAttribute = (
  tag: string,
  attributeName: string,
): string | undefined => {
  const match = new RegExp(
    `\\s${attributeName}\\s*=\\s*(["'])([^"']*)\\1`,
    'i',
  ).exec(tag);
  return match?.[2];
};

export const createCspNonce = (): string =>
  randomBytes(32).toString('base64url');

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

export function createHttpSecurityHeaders(
  kind: 'api',
): Readonly<Record<string, string>>;
export function createHttpSecurityHeaders(
  kind: 'html',
  cspNonce: string,
): Readonly<Record<string, string>>;
export function createHttpSecurityHeaders(
  kind: 'api' | 'html',
  cspNonce?: string,
): Readonly<Record<string, string>> {
  if (kind === 'api') return API_SECURITY_HEADERS;
  if (cspNonce === undefined || !isValidCspNonce(cspNonce)) {
    throw new Error('Invalid web console runtime security configuration');
  }
  return Object.freeze({
    ...API_SECURITY_HEADERS,
    'content-security-policy':
      `default-src 'self'; connect-src 'self'; style-src 'self' ` +
      `'nonce-${cspNonce}'; img-src 'self' data:; ` +
      `frame-ancestors 'none'; base-uri 'none'`,
  });
}

export const replaceCspNoncePlaceholder = (
  html: string,
  placeholder: string,
  cspNonce: string,
): string => {
  const reject = (): never => {
    throw new Error('Invalid Vite CSP nonce transformation');
  };
  if (
    !isValidCspNonce(placeholder) ||
    !isValidCspNonce(cspNonce) ||
    placeholder === cspNonce ||
    cspNonce.includes(placeholder)
  ) {
    return reject();
  }

  const cspNonceMetaTags = (html.match(/<meta\b[^>]*>/gi) ?? []).filter(
    (tag) => readQuotedHtmlAttribute(tag, 'property') === 'csp-nonce',
  );
  if (
    cspNonceMetaTags.length !== 1 ||
    readQuotedHtmlAttribute(cspNonceMetaTags[0] ?? '', 'nonce') !== placeholder
  ) {
    return reject();
  }

  let nonceAttributeCount = 0;
  let replacementCount = 0;
  let unexpectedNonceAttribute = false;
  const replaced = html.replace(/<[A-Za-z][^>]*>/g, (tag) => {
    const nonceAssignmentCount = tag.match(/\snonce\s*=/gi)?.length ?? 0;
    let parsedNonceAttributes = 0;
    const replacedTag = tag.replace(
      /\snonce\s*=\s*(["'])([^"']*)\1/gi,
      (attribute, _quote: string, value: string) => {
        parsedNonceAttributes += 1;
        nonceAttributeCount += 1;
        if (value !== placeholder) {
          unexpectedNonceAttribute = true;
          return attribute;
        }
        replacementCount += 1;
        return attribute.replace(placeholder, cspNonce);
      },
    );
    if (nonceAssignmentCount !== parsedNonceAttributes) {
      unexpectedNonceAttribute = true;
    }
    return replacedTag;
  });
  const placeholderOccurrences = html.split(placeholder).length - 1;
  if (
    unexpectedNonceAttribute ||
    replacementCount === 0 ||
    replacementCount !== nonceAttributeCount ||
    replacementCount !== placeholderOccurrences ||
    replaced.includes(placeholder)
  ) {
    return reject();
  }
  return replaced;
};

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
