import { describe, expect, it } from 'vitest';
import { NAV, NAV_GROUP_LABELS, PRIMARY_NAV_HREFS, extraSections, visibleNav } from '../src/lib/nav';

describe('nav groups (UI step 1)', () => {
  it('every page is either a primary tab page or sits in a group with a blurb', () => {
    for (const i of NAV) {
      if ((PRIMARY_NAV_HREFS as readonly string[]).includes(i.href)) expect(i.group, i.href).toBeUndefined();
      else {
        expect(i.group, i.href).toBeTruthy();
        expect(i.blurb, i.href).toBeTruthy();
      }
    }
  });

  it('menu links are unique and the primary pages come first', () => {
    expect(new Set(NAV.map((i) => i.href)).size).toBe(NAV.length);
    expect(NAV.slice(0, PRIMARY_NAV_HREFS.length).map((i) => i.href)).toEqual([...PRIMARY_NAV_HREFS]);
  });

  it('an owner sees every grouped page, in section order, with no primary page among them', () => {
    const sections = extraSections(visibleNav({ isOwner: true, permissions: [] }));
    expect(sections.map((s) => s.group)).toEqual(['workroom', 'business', 'tools']);
    expect(sections.map((s) => s.label)).toEqual(Object.values(NAV_GROUP_LABELS));
    const hrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.sort()).toEqual(NAV.filter((i) => i.group).map((i) => i.href).sort());
    for (const h of PRIMARY_NAV_HREFS) expect(hrefs).not.toContain(h);
  });

  it('a user with no permissions has nothing under Extras', () => {
    expect(extraSections(visibleNav({ isOwner: false, permissions: [] }))).toEqual([]);
  });

  it('empty sections are left out', () => {
    const sections = extraSections(visibleNav({ isOwner: false, permissions: ['payments.view'] }));
    expect(sections.map((s) => s.group)).toEqual(['business']);
    expect(sections[0]?.items.map((i) => i.href)).toEqual(['/finance']);
  });
});
