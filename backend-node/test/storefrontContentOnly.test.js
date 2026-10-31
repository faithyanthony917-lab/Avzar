import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_VISIBLE_TYPES, structureChanges } from '../src/auth/storefrontContentOnly.js';
import { starterDocument, starterTemplateKeys } from '../src/auth/storefrontStarters.js';

const fresh = (key = 'standard') => starterDocument('Atelier', key);
const edited = (doc, change) => { const copy = structuredClone(doc); change(copy); return copy; };

describe('storefront content-only comparison', () => {
  it('treats an identical document as content-only', () => {
    const doc = fresh();
    assert.deepEqual(structureChanges(doc, structuredClone(doc)), []);
  });

  it('allows text, image and contact edits inside existing sections, page search text, theme and branding', () => {
    for (const key of starterTemplateKeys) {
      const doc = fresh(key);
      const next = edited(doc, (copy) => {
        copy.pages[0].sections[0].props.headline = 'New headline';
        copy.pages[0].sections[0].props.imageMediaId = '00000000-0000-4000-8000-000000000031';
        copy.pages[0].seo.title = 'Search title';
        copy.pages.at(-2).sections[0].props.showPhone = false;
        copy.theme.colors.primary = '#112233';
        copy.branding.tagline = 'Made for you';
      });
      assert.deepEqual(structureChanges(doc, next), [], key);
    }
  });

  it('is not fooled by a different key order in an unchanged section style or menu', () => {
    const doc = fresh();
    const next = structuredClone(doc);
    const style = next.pages[0].sections[0].style;
    next.pages[0].sections[0].style = Object.fromEntries(Object.entries(style).reverse());
    next.navigation = next.navigation.map((item) => Object.fromEntries(Object.entries(item).reverse()));
    assert.deepEqual(structureChanges(doc, next), []);
  });

  const cases = {
    'removing a section': (d) => { d.pages[0].sections.pop(); },
    'adding a section': (d) => { d.pages[0].sections.push({ ...structuredClone(d.pages[0].sections[0]), id: 'extra-1' }); },
    'reordering sections': (d) => { d.pages[0].sections.reverse(); },
    'changing a section layout': (d) => { d.pages[0].sections[0].variant = 'minimal'; },
    'changing a section type': (d) => { d.pages[0].sections[0].type = 'about'; },
    'hiding a section customers use to reach the shop': (d) => { d.pages[0].sections.find((s) => s.type === 'inquiryForm').visible = false; },
    'hiding the only visible section of a page': (d) => { d.pages[1].sections[0].visible = false; },
    'a visibility value that is not true or false': (d) => { d.pages[0].sections[0].visible = 'no'; },
    'section colours': (d) => { d.pages[0].sections[0].style.background = '#000000'; },
    'section spacing': (d) => { d.pages[0].sections[0].style.spacing = 'spacious'; },
    'removing a page': (d) => { d.pages.pop(); },
    'adding a custom page': (d) => { d.pages.push({ id: 'custom-1', kind: 'custom', slug: 'extra', title: 'Extra', visible: true, seo: {}, sections: [] }); },
    'renaming a page': (d) => { d.pages[1].title = 'Renamed'; },
    'changing a page slug': (d) => { d.pages[1].slug = 'renamed'; },
    'hiding a page': (d) => { d.pages[1].visible = false; },
    'reordering pages': (d) => { d.pages.reverse(); },
    'changing the menu': (d) => { d.navigation[0].label = 'Start'; },
    'removing a menu item': (d) => { d.navigation.pop(); },
    'changing the archive': (d) => { d.archive.push({ id: 'old-1' }); },
    'changing the template': (d) => { d.templateKey = 'luxury'; },
    'changing the schema version': (d) => { d.schemaVersion = 2; },
  };
  for (const [name, change] of Object.entries(cases)) {
    it(`rejects ${name}`, () => {
      const doc = fresh();
      assert.ok(structureChanges(doc, edited(doc, change)).length > 0, name);
    });
  }

  it('allows hiding and showing sections that are not entry points, while the page keeps a visible section', () => {
    for (const key of starterTemplateKeys) {
      const doc = fresh(key);
      const home = doc.pages[0];
      const free = home.sections.filter((section) => !ALWAYS_VISIBLE_TYPES.includes(section.type));
      assert.ok(free.length >= 2, key);
      const hidden = edited(doc, (copy) => { for (const section of copy.pages[0].sections) if (!ALWAYS_VISIBLE_TYPES.includes(section.type)) section.visible = false; });
      assert.deepEqual(structureChanges(doc, hidden), [], `${key}: hide`);
      assert.deepEqual(structureChanges(hidden, doc), [], `${key}: show again`);
    }
  });

  it('never allows hiding an entry-point section on any page of any starter', () => {
    for (const key of starterTemplateKeys) {
      const doc = fresh(key);
      let checked = 0;
      doc.pages.forEach((page, pageIndex) => page.sections.forEach((section, sectionIndex) => {
        if (!ALWAYS_VISIBLE_TYPES.includes(section.type)) return;
        checked += 1;
        const changes = structureChanges(doc, edited(doc, (copy) => { copy.pages[pageIndex].sections[sectionIndex].visible = false; }));
        assert.equal(changes[0]?.path, `pages[${pageIndex}].sections[${sectionIndex}].visible`, `${key} ${section.type}`);
      }));
      assert.ok(checked >= 3, key);
    }
  });

  it('still refuses to hide a whole page, even when its sections stay visible', () => {
    const doc = fresh();
    assert.ok(structureChanges(doc, edited(doc, (d) => { d.pages[3].visible = false; })).length > 0);
  });

  it('reports the path of the first structural change and never throws on malformed input', () => {
    const doc = fresh();
    const changes = structureChanges(doc, edited(doc, (d) => { d.pages[0].sections[0].variant = 'minimal'; }));
    assert.equal(changes[0].path, 'pages[0].sections[0].variant');
    assert.ok(structureChanges(null, doc).length > 0);
    assert.ok(structureChanges(doc, { ...doc, pages: 'x' }).length > 0);
    assert.ok(structureChanges(doc, { ...doc, pages: [null] }).length >= 0);
  });
});
