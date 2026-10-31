import { describe, expect, it } from 'vitest';
import { apiQueryString, blankToUndefined, channelLabel, listHref, parseListQuery, totalPages } from '../src/lib/customers';
import { formatDate, formatDateTime } from '../src/lib/dates';

describe('parseListQuery: the URL is untrusted', () => {
  it('defaults', () => expect(parseListQuery({})).toEqual({ search: '', status: '', sort: 'name', page: 1 }));
  it('reads valid values', () => expect(parseListQuery({ search: ' ada ', status: 'Active', sort: 'created-desc', page: '3' })).toEqual({ search: 'ada', status: 'Active', sort: 'created-desc', page: 3 }));
  it.each([['status', 'Hacked'], ['status', 'active'], ['sort', 'password'], ['sort', 'name; drop']])('ignores %s=%s', (k, v) => {
    const q = parseListQuery({ [k]: v });
    expect(k === 'status' ? q.status : q.sort).toBe(k === 'status' ? '' : 'name');
  });
  it.each([['0'], ['-4'], ['abc'], ['1e9'], ['99999999999']])('page %s falls back to 1', (p) => expect(parseListQuery({ page: p }).page).toBe(1));
  it('takes the first of repeated params and caps the search length', () => {
    expect(parseListQuery({ search: ['a', 'b'] }).search).toBe('a');
    expect(parseListQuery({ search: 'x'.repeat(500) }).search).toHaveLength(100);
  });
});

describe('apiQueryString', () => {
  it('maps the sort choice to the API fields', () => {
    expect(apiQueryString(parseListQuery({ sort: 'created-desc' }))).toBe('page=1&pageSize=25&sort=created&descending=true');
    expect(apiQueryString(parseListQuery({ search: 'a b', status: 'Inactive' }))).toBe('page=1&pageSize=25&search=a+b&status=Inactive&sort=name');
  });
});

describe('listHref', () => {
  const q = parseListQuery({ search: 'ada', status: 'Active', sort: 'created', page: '2' });
  it('keeps filters and leaves defaults out', () => {
    expect(listHref(q, { page: 3 })).toBe('/customers?search=ada&status=Active&sort=created&page=3');
    expect(listHref(parseListQuery({}))).toBe('/customers');
    expect(listHref(q, { page: 1 })).toBe('/customers?search=ada&status=Active&sort=created');
  });
  it('encodes the search text', () => expect(listHref(parseListQuery({ search: 'a&b=c' }))).toBe('/customers?search=a%26b%3Dc'));
});

describe('misc helpers', () => {
  it('totalPages', () => { expect(totalPages(0)).toBe(1); expect(totalPages(25)).toBe(1); expect(totalPages(26)).toBe(2); });
  it('blankToUndefined', () => { expect(blankToUndefined('  ')).toBeUndefined(); expect(blankToUndefined(' a ')).toBe('a'); });
  it('channelLabel', () => { expect(channelLabel('InPerson')).toBe('In person'); expect(channelLabel('Zzz')).toBe('Zzz'); });
});

describe('dates are shown in the business time zone', () => {
  it('converts from UTC', () => expect(formatDateTime('2026-10-16T23:30:00Z', 'Africa/Lagos')).toContain('17 Oct 2026'));
  it('treats a timestamp without a zone as UTC', () => expect(formatDate('2026-10-16T23:30:00', 'UTC')).toBe('16 Oct 2026'));
  it('survives garbage and unknown zones', () => {
    expect(formatDate('nope', 'UTC')).toBe('—');
    expect(formatDate('2026-10-16T10:00:00Z', 'Not/AZone')).toBe('16 Oct 2026');
  });
});
