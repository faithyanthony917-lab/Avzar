/**
 * Content-only editing rules for plans without the visual builder (`storefront.builder` = false).
 *
 * A shop on such a plan may change the words, images and contact details inside the sections it already has
 * (section `props`), the page search text (`seo`), and the theme and branding fields its plan level allows (those are
 * still checked by the plan rules in storefrontDocument.js). It may also hide or show a section, with two guards: a
 * section that is a way for customers to reach the shop (see ALWAYS_VISIBLE_TYPES) cannot be hidden, and a visible
 * page keeps at least one visible section. It may not change the rest of the structure: which pages and sections
 * exist, their order, layout (variant), per-section style, page visibility, the menu, the archive, the template or
 * the schema version.
 *
 * Pure functions with no imports, so they can be tested without a database or a server.
 */

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const same = (first, second) => canonical(first) === canonical(second);

/** Section types through which customers reach the shop (the same ones `missingWorkflowEntryPoints` looks for). */
export const ALWAYS_VISIBLE_TYPES = Object.freeze(['inquiryForm', 'booking', 'customOrderForm', 'contactInfo']);

/**
 * Lists every structural difference between the saved draft and the submitted document.
 * An empty list means the change is content-only. Each entry is `{ path, message }`.
 */
export function structureChanges(previous, next) {
  const changes = [];
  const add = (path, message) => changes.push({ path, message });
  if (!previous || !next) return [{ path: 'document', message: 'The document could not be compared.' }];

  if (previous.schemaVersion !== next.schemaVersion) add('schemaVersion', 'The document version cannot be changed.');
  if (previous.templateKey !== next.templateKey) add('templateKey', 'Changing the template is not included in your plan here. Use the template switch.');
  if (!same(previous.navigation, next.navigation)) add('navigation', 'The menu cannot be changed on your plan.');
  if (!same(previous.archive, next.archive)) add('archive', 'Archived sections cannot be changed on your plan.');

  const oldPages = Array.isArray(previous.pages) ? previous.pages : [];
  const newPages = Array.isArray(next.pages) ? next.pages : [];
  if (oldPages.length !== newPages.length) {
    add('pages', 'Adding or removing pages is not included in your plan.');
    return changes;
  }
  oldPages.forEach((oldPage, pageIndex) => {
    const newPage = newPages[pageIndex];
    const path = `pages[${pageIndex}]`;
    for (const key of ['id', 'kind', 'slug', 'title', 'visible']) {
      if (!same(oldPage?.[key], newPage?.[key])) add(`${path}.${key}`, `Changing a page's ${key === 'kind' ? 'type' : key} is not included in your plan.`);
    }
    const oldSections = Array.isArray(oldPage?.sections) ? oldPage.sections : [];
    const newSections = Array.isArray(newPage?.sections) ? newPage.sections : [];
    if (oldSections.length !== newSections.length) {
      add(`${path}.sections`, 'Adding or removing sections is not included in your plan.');
      return;
    }
    oldSections.forEach((oldSection, sectionIndex) => {
      const newSection = newSections[sectionIndex];
      const sectionPath = `${path}.sections[${sectionIndex}]`;
      if (oldSection?.id !== newSection?.id) add(`${sectionPath}.id`, 'Reordering or replacing sections is not included in your plan.');
      if (oldSection?.type !== newSection?.type) add(`${sectionPath}.type`, 'Changing what a section is is not included in your plan.');
      if (oldSection?.variant !== newSection?.variant) add(`${sectionPath}.variant`, 'Changing a section layout is not included in your plan.');
      if (oldSection?.visible !== newSection?.visible && newSection?.visible !== true) {
        if (newSection?.visible !== false) add(`${sectionPath}.visible`, 'A section is either shown or hidden.');
        else if (ALWAYS_VISIBLE_TYPES.includes(newSection?.type)) add(`${sectionPath}.visible`, 'This section is how customers reach you, so it cannot be hidden on your plan.');
      }
      if (!same(oldSection?.style, newSection?.style)) add(`${sectionPath}.style`, 'Section styling is not included in your plan.');
    });
    const hadVisible = oldSections.some((section) => section?.visible === true);
    const hasVisible = newSections.some((section) => section?.visible === true);
    if (hadVisible && !hasVisible) add(`${path}.sections`, 'Each page must keep at least one visible section.');
  });
  return changes;
}
