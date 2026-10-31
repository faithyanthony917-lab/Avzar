import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBlank, matchEnum, parseEnum } from '../../src/http/enums.js';

const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];

describe('enum parsing like C# Parse.Value', () => {
  it('trims and ignores case, returning the canonical spelling', () => {
    assert.equal(matchEnum(' hIgH ', PRIORITIES), 'High');
    assert.equal(matchEnum('URGENT', PRIORITIES), 'Urgent');
    assert.equal(matchEnum('Low', PRIORITIES), 'Low');
  });

  it('returns undefined for unknown, empty and non-string values', () => {
    assert.equal(matchEnum('critical', PRIORITIES), undefined);
    assert.equal(matchEnum('', PRIORITIES), undefined);
    assert.equal(matchEnum('   ', PRIORITIES), undefined);
    assert.equal(matchEnum(undefined, PRIORITIES), undefined);
    assert.equal(matchEnum(null, PRIORITIES), undefined);
    assert.equal(matchEnum(2, PRIORITIES), undefined);
    assert.equal(matchEnum(['High'], PRIORITIES), undefined);
  });

  it('parseEnum throws 400 invalid_<field> for an unknown value, like C#', () => {
    assert.equal(parseEnum(' normal', PRIORITIES, 'priority'), 'Normal');
    assert.throws(() => parseEnum('critical', PRIORITIES, 'priority'), (error) => error.status === 400 && error.code === 'invalid_priority');
    assert.throws(() => parseEnum('', PRIORITIES, 'priority'), (error) => error.code === 'invalid_priority');
  });

  it('isBlank matches string.IsNullOrWhiteSpace', () => {
    assert.equal(isBlank(undefined), true);
    assert.equal(isBlank(null), true);
    assert.equal(isBlank(''), true);
    assert.equal(isBlank(' \t '), true);
    assert.equal(isBlank('a'), false);
  });
});
