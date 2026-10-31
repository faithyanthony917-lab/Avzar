import { describe, expect, it } from 'vitest';
import { acceptanceRate, barPercents, summaryPath, summaryState } from '../storefront-analytics-view-model';

describe('summaryState', () => {
  const none = { accepted: 0, rejected: 0 };
  it('is off while the switch is off and nothing was ever recorded', () => {
    expect(summaryState({ enabled: false, totalViews: 0, consent: none })).toBe('off');
  });
  it('is empty when on without views in the window, and still shows history after switching off', () => {
    expect(summaryState({ enabled: true, totalViews: 0, consent: none })).toBe('empty');
    expect(summaryState({ enabled: false, totalViews: 12, consent: none })).toBe('data');
    expect(summaryState({ enabled: false, totalViews: 0, consent: { accepted: 1, rejected: 0 } })).toBe('empty');
  });
  it('has data when there are views', () => {
    expect(summaryState({ enabled: true, totalViews: 3, consent: none })).toBe('data');
  });
});

describe('barPercents', () => {
  it('scales to the busiest day with a visible minimum, and zero stays zero', () => {
    expect(barPercents([{ day: 'a', views: 0 }, { day: 'b', views: 1 }, { day: 'c', views: 100 }])).toEqual([0, 4, 100]);
    expect(barPercents([{ day: 'a', views: 0 }])).toEqual([0]);
    expect(barPercents([])).toEqual([]);
  });
});

describe('acceptanceRate and summaryPath', () => {
  it('rounds the acceptance share and is null before anyone chose', () => {
    expect(acceptanceRate({ accepted: 0, rejected: 0 })).toBeNull();
    expect(acceptanceRate({ accepted: 1, rejected: 2 })).toBe(33);
  });
  it('builds the summary query', () => {
    expect(summaryPath(30, null)).toBe('/api/business/storefront-analytics/summary?days=30');
    expect(summaryPath(7, 'abc')).toBe('/api/business/storefront-analytics/summary?days=7&storefrontId=abc');
  });
});
