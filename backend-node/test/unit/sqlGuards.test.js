// Regression guards for bugs that SQL-substring mocks cannot see (found by the real-database flows in slice 6).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, problemBody } from '../../src/http/errors.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? files(full) : full.endsWith('.js') ? [full] : [];
});

describe('SQL guards', () => {
  it('never uses an unqualified xmin in a statement that joins tables (PostgreSQL: column "xmin" does not exist)', () => {
    const offenders = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
        const sql = match[1] ?? match[2] ?? '';
        // Only a SELECT list is affected: UPDATE ... WHERE xmin = ... and RETURNING work on a single target table.
        // SQL joins here are uppercase and name a quoted table; this ignores JS such as conditions.join(' AND ').
        if (!/\bSELECT\b/.test(sql) || !/\bJOIN\s+"/.test(sql)) continue;
        const selectList = sql.slice(0, sql.search(/\bFROM\b/i) < 0 ? sql.length : sql.search(/\bFROM\b/i));
        if (/(?<![\w.])xmin\b/.test(selectList)) offenders.push(`${path.relative(SRC, file)}:${text.slice(0, match.index).split('\n').length}`);
      }
    }
    assert.deepEqual(offenders, [], 'qualify xmin with the table alias, e.g. o.xmin');
  });

  it('never uses a PostgreSQL reserved word as a table alias (e.g. JOIN "AspNetUsers" user is a syntax error)', () => {
    // Reserved keywords that PostgreSQL rejects as an unquoted table alias or qualifier. Use names like appUser instead.
    const reserved = ['user', 'order', 'group', 'table', 'check', 'default', 'desc', 'all', 'any', 'array', 'case', 'column',
      'constraint', 'create', 'distinct', 'do', 'else', 'end', 'except', 'for', 'foreign', 'grant', 'having', 'in', 'into',
      'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'primary', 'references', 'some', 'then', 'to', 'union', 'unique',
      'using', 'when', 'window', 'with'];
    const word = reserved.join('|');
    // Words that can legitimately follow a table name as a clause (ORDER BY, LIMIT, ON, ...) are not flagged as aliases.
    const clauseWords = new Set(['limit', 'on', 'for', 'using', 'with', 'union', 'except', 'having', 'offset', 'window', 'into', 'group', 'order']);
    const aliasWord = reserved.filter((name) => !clauseWords.has(name)).join('|');
    const aliasDecl = new RegExp(`\\b(?:FROM|JOIN)\\s+"[A-Za-z0-9_]+"\\s+(?:AS\\s+)?(${aliasWord})\\b(?!\\s*\\()`, 'gi');
    const qualified = new RegExp(`(?<![\\w."$])(${word})\\.\\s*"`, 'gi');
    const offenders = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/`([^`]*)`|'([^'\n]*)'/g)) {
        const sql = match[1] ?? match[2] ?? '';
        if (!/\b(SELECT|UPDATE|INSERT|DELETE)\b/.test(sql)) continue;
        for (const re of [aliasDecl, qualified]) {
          re.lastIndex = 0;
          for (const hit of sql.matchAll(re)) {
            offenders.push(`${path.relative(SRC, file)}:${text.slice(0, match.index).split('\n').length} uses reserved word "${hit[1]}"`);
          }
        }
      }
    }
    assert.deepEqual(offenders, [], 'rename the alias (e.g. appUser) so PostgreSQL can parse the statement');
  });

  it('forbidden() keeps its extensions so clients get entitlement, limit and used', () => {
    const body = problemBody(AppError.forbidden('plan_limit_reached', 'limit', { entitlement: 'designs.max', limit: 2, used: 2 }));
    assert.equal(body.status, 403);
    assert.equal(body.code, 'plan_limit_reached');
    assert.deepEqual([body.entitlement, body.limit, body.used], ['designs.max', 2, 2]);
  });
});
