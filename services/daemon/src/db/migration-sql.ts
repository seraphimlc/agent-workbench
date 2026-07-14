const TRANSACTION_CONTROL_KEYWORDS = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

type SqlToken =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'semicolon' }
  | { readonly kind: 'other' };

export interface ForbiddenTransactionStatement {
  readonly keyword: string;
}

const isSqlWhitespace = (character: string): boolean =>
  character === ' ' ||
  character === '\t' ||
  character === '\n' ||
  character === '\v' ||
  character === '\r' ||
  character === '\f' ||
  character === '\ufeff';

const isBareWordCharacter = (character: string): boolean => {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    character === '_' ||
    character === '$' ||
    (codePoint >= 0x61 && codePoint <= 0x7a) ||
    codePoint >= 0x80
  );
};

const skipDelimitedQuote = (
  sql: string,
  start: number,
  delimiter: "'" | '"' | '`',
): number => {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== delimiter) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === delimiter) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
};

const lexMigrationSql = (sql: string): SqlToken[] => {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index] as string;
    const nextCharacter = sql[index + 1];

    if (isSqlWhitespace(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && nextCharacter === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      index += 2;
      while (
        index < sql.length &&
        !(sql[index] === '*' && sql[index + 1] === '/')
      ) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      tokens.push({ kind: 'other' });
      index = skipDelimitedQuote(sql, index, character);
      continue;
    }
    if (character === '[') {
      tokens.push({ kind: 'other' });
      index += 1;
      while (index < sql.length && sql[index] !== ']') {
        index += 1;
      }
      index = Math.min(index + 1, sql.length);
      continue;
    }
    if (character === ';') {
      tokens.push({ kind: 'semicolon' });
      index += 1;
      continue;
    }
    if (isBareWordCharacter(character)) {
      const start = index;
      index += 1;
      while (
        index < sql.length &&
        isBareWordCharacter(sql[index] as string)
      ) {
        index += 1;
      }
      tokens.push({
        kind: 'word',
        value: sql.slice(start, index).toUpperCase(),
      });
      continue;
    }

    tokens.push({ kind: 'other' });
    index += 1;
  }

  return tokens;
};

type AnalyzerState =
  | 'top-level-start'
  | 'ordinary-statement'
  | 'after-create'
  | 'after-create-temp'
  | 'trigger-header'
  | 'trigger-body'
  | 'trigger-end';

export const findForbiddenTransactionStatement = (
  sql: string,
): ForbiddenTransactionStatement | undefined => {
  let state: AnalyzerState = 'top-level-start';
  let triggerStepStart = false;

  for (const token of lexMigrationSql(sql)) {
    if (token.kind === 'semicolon') {
      if (state === 'trigger-body') {
        triggerStepStart = true;
      } else if (state === 'trigger-end') {
        state = 'top-level-start';
        triggerStepStart = false;
      } else {
        state = 'top-level-start';
      }
      continue;
    }

    if (state === 'top-level-start') {
      if (
        token.kind === 'word' &&
        TRANSACTION_CONTROL_KEYWORDS.has(token.value)
      ) {
        return { keyword: token.value };
      }
      state =
        token.kind === 'word' && token.value === 'CREATE'
          ? 'after-create'
          : 'ordinary-statement';
      continue;
    }

    if (state === 'after-create') {
      if (token.kind === 'word' && token.value === 'TRIGGER') {
        state = 'trigger-header';
      } else if (
        token.kind === 'word' &&
        (token.value === 'TEMP' || token.value === 'TEMPORARY')
      ) {
        state = 'after-create-temp';
      } else {
        state = 'ordinary-statement';
      }
      continue;
    }

    if (state === 'after-create-temp') {
      state =
        token.kind === 'word' && token.value === 'TRIGGER'
          ? 'trigger-header'
          : 'ordinary-statement';
      continue;
    }

    if (state === 'trigger-header') {
      if (token.kind === 'word' && token.value === 'BEGIN') {
        state = 'trigger-body';
        triggerStepStart = true;
      }
      continue;
    }

    if (state === 'trigger-body') {
      if (
        triggerStepStart &&
        token.kind === 'word' &&
        token.value === 'END'
      ) {
        state = 'trigger-end';
      } else {
        triggerStepStart = false;
      }
      continue;
    }

    if (state === 'trigger-end') {
      state = 'trigger-body';
      triggerStepStart = false;
    }
  }

  return undefined;
};
