'use client';

import { useState } from 'react';
import { reorderItems } from '@/lib/storefront-editor';
import {
  COLOR_LABELS, addItem, contrastIssues, effectiveColors, fieldIssue, hideBlockReason, isScalarKind, labelFor, normalizeHex, removeItem,
  planForTier, setItemProp, setProp, templateStatus, themeAbilities, upgradePath, type Capabilities, type PropSpec, type Props, type TemplateInfo,
} from '@/lib/storefront-guided';

/* ---------- Template gallery ---------- */

export function TemplateGallery({ templates, currentKey, selectedKey, capabilities, disabled, onSelect, onSample }: {
  templates: TemplateInfo[]; currentKey: string; selectedKey: string; capabilities: Pick<Capabilities, 'templateTier'>;
  disabled: boolean; onSelect: (key: string) => void; onSample?: (key: string) => void;
}) {
  return <div className="ap-tpl-grid" role="radiogroup" aria-label="Storefront template">
    {templates.map((template) => {
      const status = templateStatus(template, currentKey, capabilities);
      const locked = status.state === 'locked';
      const chosen = (selectedKey || currentKey) === template.key;
      return <div key={template.key} className={`ap-tpl-card${chosen ? ' ap-tpl-chosen' : ''}${locked ? ' ap-tpl-locked' : ''}`}>
        <div className={`ap-tpl-thumb ap-tpl-thumb-${template.key}`} aria-hidden="true"><span className="ap-tpl-bar" /><span className="ap-tpl-hero" /><span className="ap-tpl-row" /><span className="ap-tpl-row ap-tpl-short" /></div>
        <strong>{template.name}</strong>
        <p className="ap-foot">{template.description}</p>
        {status.state === 'current' && <p className="ap-foot"><strong>In use on this draft</strong></p>}
        {locked && <p className="ap-foot" id={`tpl-lock-${template.key}`}>{status.reason}</p>}
        <div className="ap-tpl-actions">
        <button type="button" role="radio" aria-checked={chosen} className={`ap-btn ${chosen ? '' : 'ap-btn-quiet'} ap-btn-sm`} disabled={disabled || locked}
          aria-describedby={locked ? `tpl-lock-${template.key}` : undefined} onClick={() => onSelect(template.key)}>
          {locked ? 'Locked' : chosen ? 'Selected' : 'Use this template'}
        </button>
        {status.state !== 'current' && template.sample && onSample && <button type="button" className="ap-btn ap-btn-sm" aria-label={`See a sample of the ${template.name} template`} onClick={() => onSample(template.key)}>See a sample</button>}
        {locked && upgradePath(template.tier) && <a className="ap-btn ap-btn-quiet ap-btn-sm" href={upgradePath(template.tier) ?? undefined}>Upgrade to {planForTier(template.tier)}</a>}
        </div>
      </div>;
    })}
  </div>;
}

/* ---------- Content editor ---------- */

export type GuidedSection = { id: string; type: string; variant: string; visible: boolean; props: Props };
export type GuidedPage = { id: string; kind: string; title: string; visible: boolean; sections: GuidedSection[] };
export type GuidedSectionType = { type: string; label: string; props: PropSpec[] };
export type GuidedMedia = { id: string; fileName: string };

const ACTIONS: [string, string][] = [['action:inquiry', 'Enquiry form'], ['action:booking', 'Booking form'], ['action:custom-order', 'Custom order form'], ['action:contact', 'Contact details']];

function ScalarField({ id, spec, value, disabled, media, pages, onChange }: {
  id: string; spec: PropSpec; value: unknown; disabled: boolean; media: GuidedMedia[]; pages: GuidedPage[]; onChange: (value: unknown) => void;
}) {
  const label = labelFor(spec.name);
  const issue = fieldIssue(spec, value);
  const hint = issue ? <p id={`${id}-err`} className="ap-err" role="alert">{issue}</p> : null;
  const describedBy = issue ? `${id}-err` : undefined;
  if (spec.kind === 'Bool') {
    return <label className="ap-check"><input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
  }
  if (spec.kind === 'Guid' && /category/i.test(spec.name)) {
    const current = typeof value === 'string' ? value : '';
    return <div className="ap-field"><label htmlFor={id}>Category</label>
      <select id={id} className="ap-input" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All categories</option>
        {current && <option value={current}>Current category</option>}
      </select>
      <p className="ap-foot">Shows designs from every category. Showing only one category is not available in this editor yet.</p></div>;
  }
  if (spec.kind === 'Guid') {
    const current = typeof value === 'string' ? value : '';
    const known = media.some((asset) => asset.id === current);
    return <div className="ap-field"><label htmlFor={id}>{label}</label>
      <select id={id} className="ap-input" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">None</option>
        {current && !known && <option value={current}>Current image</option>}
        {media.map((asset) => <option key={asset.id} value={asset.id}>{asset.fileName}</option>)}
      </select>
      <p className="ap-foot">Choose from your uploaded images. Upload a new one in the media picker further down this page.</p></div>;
  }
  if (spec.kind === 'Link') {
    const current = typeof value === 'string' ? value : '';
    const targets = [...ACTIONS, ...pages.map((page): [string, string] => [page.id, `Page: ${page.title}`])];
    const known = targets.some(([target]) => target === current);
    return <div className="ap-field"><label htmlFor={id}>{label}</label>
      <select id={id} className="ap-input" value={current} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">No link</option>
        {current && !known && <option value={current}>{current}</option>}
        {targets.map(([target, name]) => <option key={target} value={target}>{name}</option>)}
      </select></div>;
  }
  if (spec.kind === 'Int') {
    return <div className="ap-field"><label htmlFor={id}>{label}</label>
      <input id={id} type="number" className="ap-input" min={spec.min || undefined} max={spec.max || undefined} value={typeof value === 'number' ? value : ''} disabled={disabled}
        aria-invalid={issue ? true : undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />{hint}</div>;
  }
  const text = typeof value === 'string' ? value : '';
  return <div className="ap-field"><label htmlFor={id}>{label}{spec.required ? ' (required)' : ''}</label>
    {spec.multiline
      ? <textarea id={id} className="ap-input" rows={5} maxLength={spec.max || undefined} value={text} disabled={disabled} aria-invalid={issue ? true : undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      : <input id={id} className="ap-input" maxLength={spec.max || undefined} value={text} disabled={disabled} aria-invalid={issue ? true : undefined} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />}
    {spec.max > 0 && <p className="ap-foot">{text.length} of {spec.max} characters</p>}{hint}</div>;
}

function ListField({ id, spec, props, disabled, media, pages, onProps }: {
  id: string; spec: PropSpec; props: Props; disabled: boolean; media: GuidedMedia[]; pages: GuidedPage[]; onProps: (props: Props) => void;
}) {
  const items = Array.isArray(props[spec.name]) ? (props[spec.name] as Record<string, unknown>[]) : [];
  if (spec.kind === 'StringList') {
    return <p className="ap-foot">{labelFor(spec.name)} is edited under Advanced content (JSON) when your plan includes it.</p>;
  }
  return <fieldset className="ap-fieldset ap-stack"><legend>{labelFor(spec.name)}</legend>
    {items.length === 0 && <p className="ap-foot">Nothing here yet.</p>}
    {items.map((item, index) => <div key={index} className="ap-stack ap-tpl-item">
      <strong>{labelFor(spec.name)} {index + 1}</strong>
      {(spec.fields ?? []).filter((child) => isScalarKind(child.kind)).map((child) =>
        <ScalarField key={child.name} id={`${id}-${index}-${child.name}`} spec={child} value={item[child.name]} disabled={disabled} media={media} pages={pages}
          onChange={(value) => onProps(setItemProp(props, spec.name, index, child.name, value))} />)}
      <button type="button" className="ap-btn ap-btn-danger ap-btn-sm" disabled={disabled} onClick={() => onProps(removeItem(props, spec.name, index))}>Remove this item</button>
    </div>)}
    <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={disabled || (spec.max > 0 && items.length >= spec.max)} onClick={() => onProps(addItem(props, spec))}>Add an item</button>
  </fieldset>;
}

export function GuidedContent<P extends GuidedPage>({ pages, sectionTypes, structureLock, disabled, media, onChangePages }: {
  pages: P[]; sectionTypes: GuidedSectionType[]; structureLock: string | null; disabled: boolean; media: GuidedMedia[]; onChangePages: (pages: P[]) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const page = pages[pageIndex] ?? pages[0];
  const structureOff = disabled || structureLock !== null;

  function changeSections(sections: GuidedSection[]) {
    if (!page) return;
    onChangePages(pages.map((item) => (item.id === page.id ? { ...item, sections } as P : item)));
  }
  function changeSection(index: number, patch: Partial<GuidedSection>) {
    if (!page) return;
    changeSections(page.sections.map((section, i) => (i === index ? { ...section, ...patch } : section)));
  }

  if (!page) return <p className="ap-foot">This storefront has no pages yet.</p>;
  return <div className="ap-stack">
    {structureLock && <p className="ap-foot" role="note">{structureLock}</p>}
    <div className="ap-field"><label htmlFor="guided-page">Page</label>
      <select id="guided-page" className="ap-input" value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))}>
        {pages.map((item, index) => <option key={item.id} value={index}>{item.title}{item.visible ? '' : ' (hidden)'}</option>)}
      </select></div>
    {page.sections.map((section, index) => {
      const definition = sectionTypes.find((entry) => entry.type === section.type);
      const specs = definition?.props ?? [];
      const base = `guided-${page.id}-${section.id}`;
      const hideBlock = structureLock !== null ? hideBlockReason(page.sections, index) : null;
      return <section key={section.id} className="ap-fieldset ap-stack" aria-label={`${definition?.label ?? section.type} section`}>
        <div className="ap-row"><strong>{index + 1}. {definition?.label ?? section.type}{section.visible ? '' : ' (hidden)'}</strong>
          <div className="ap-actions">
            <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={structureOff || index === 0} aria-label={`Move ${definition?.label ?? section.type} up`}
              onClick={() => changeSections(reorderItems(page.sections, index, index - 1))}>Up</button>
            <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={structureOff || index >= page.sections.length - 1} aria-label={`Move ${definition?.label ?? section.type} down`}
              onClick={() => changeSections(reorderItems(page.sections, index, index + 1))}>Down</button>
          </div></div>
        <label className="ap-check"><input type="checkbox" checked={section.visible} disabled={disabled || hideBlock !== null} onChange={(e) => changeSection(index, { visible: e.target.checked })} /> Show this section on the site</label>
        {hideBlock && <p className="ap-foot" style={{ margin: 0 }}>{hideBlock}</p>}
        {specs.filter((spec) => isScalarKind(spec.kind)).map((spec) =>
          <ScalarField key={spec.name} id={`${base}-${spec.name}`} spec={spec} value={section.props[spec.name]} disabled={disabled} media={media} pages={pages}
            onChange={(value) => changeSection(index, { props: setProp(section.props, spec.name, value) })} />)}
        {specs.filter((spec) => !isScalarKind(spec.kind)).map((spec) =>
          <ListField key={spec.name} id={`${base}-${spec.name}`} spec={spec} props={section.props} disabled={disabled} media={media} pages={pages}
            onProps={(props) => changeSection(index, { props })} />)}
      </section>;
    })}
  </div>;
}

/* ---------- Colour and font controls ---------- */

export type GuidedTheme = { preset?: string; colors?: Record<string, string>; headingFont?: string | null; bodyFont?: string | null };
export type GuidedPreset = { key: string; name: string; colors: Record<string, string>; headingFont: string; bodyFont: string };

export function ThemeControls({ theme, presets, fonts, capabilities, disabled, onChange }: {
  theme: GuidedTheme; presets: GuidedPreset[]; fonts: string[]; capabilities: Pick<Capabilities, 'themeLevel'>; disabled: boolean; onChange: (theme: GuidedTheme) => void;
}) {
  const ability = themeAbilities(capabilities);
  const preset = presets.find((entry) => entry.key === theme.preset) ?? presets[0];
  const colors = effectiveColors(preset?.colors ?? {}, theme.colors);
  const issues = contrastIssues(colors);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  function setColor(key: string, raw: string) {
    setDrafts((old) => ({ ...old, [key]: raw }));
    const hex = normalizeHex(raw);
    if (hex) onChange({ ...theme, colors: { ...(theme.colors ?? {}), [key]: hex } });
  }
  function resetColors() { setDrafts({}); onChange({ ...theme, colors: {} }); }

  return <div className="ap-stack">
    <div className="ap-field"><label htmlFor="guided-preset">Colour theme (starting point)</label>
      <select id="guided-preset" className="ap-input" value={presets.some((entry) => entry.key === theme.preset) ? theme.preset : (preset?.key ?? '')} disabled={disabled || !ability.choosePreset}
        onChange={(e) => onChange({ ...theme, preset: e.target.value, colors: {}, headingFont: null, bodyFont: null })}>
        {presets.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
      </select>
      {ability.presetReason ? <p className="ap-foot">{ability.presetReason}</p> : <p className="ap-foot">Choosing another theme clears your own colours and fonts.</p>}</div>
    <fieldset className="ap-fieldset ap-stack"><legend>Colours</legend>
      {ability.colorReason && <p className="ap-foot">{ability.colorReason}</p>}
      <div className="ap-grid2">
        {Object.keys(COLOR_LABELS).map((key) => {
          const editable = !disabled && ability.colorKeys.includes(key);
          const raw = drafts[key] ?? colors[key] ?? '';
          const bad = raw !== '' && normalizeHex(raw) === null;
          return <div key={key} className="ap-field"><label htmlFor={`guided-color-${key}`}>{COLOR_LABELS[key]}</label>
            <div className="ap-actions"><input type="color" aria-label={`${COLOR_LABELS[key]} picker`} value={normalizeHex(colors[key] ?? '')?.toLowerCase() ?? '#000000'} disabled={!editable} onChange={(e) => setColor(key, e.target.value)} />
              <input id={`guided-color-${key}`} className="ap-input" value={raw} maxLength={7} disabled={!editable} aria-invalid={bad ? true : undefined}
                aria-describedby={bad ? `guided-color-${key}-err` : undefined} onChange={(e) => setColor(key, e.target.value)} /></div>
            {bad && <p id={`guided-color-${key}-err`} className="ap-err" role="alert">Use a colour like #1A2B3C.</p>}</div>;
        })}
      </div>
      <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" disabled={disabled || ability.colorKeys.length === 0 || Object.keys(theme.colors ?? {}).length === 0} onClick={resetColors}>Reset to the theme’s colours</button>
      {issues.length > 0 && <div className="ap-alert" role="status"><strong>Contrast warnings</strong>
        <ul>{issues.map((issue) => <li key={`${issue.foreground}-${issue.background}`}>{COLOR_LABELS[issue.foreground]} on {COLOR_LABELS[issue.background]}: {issue.ratio.toFixed(2)}:1 (aim for {issue.required}:1).</li>)}</ul></div>}
    </fieldset>
    <fieldset className="ap-fieldset ap-stack"><legend>Fonts</legend>
      {ability.fontReason && <p className="ap-foot">{ability.fontReason}</p>}
      <div className="ap-grid2">
        {([['headingFont', 'Heading font', preset?.headingFont], ['bodyFont', 'Body font', preset?.bodyFont]] as const).map(([key, label, fallback]) =>
          <div key={key} className="ap-field"><label htmlFor={`guided-${key}`}>{label}</label>
            <select id={`guided-${key}`} className="ap-input" value={theme[key] ?? ''} disabled={disabled || !ability.chooseFonts}
              onChange={(e) => onChange({ ...theme, [key]: e.target.value || null })}>
              <option value="">Theme default{fallback ? ` (${fallback})` : ''}</option>
              {fonts.map((font) => <option key={font} value={font}>{font}</option>)}
            </select></div>)}
      </div>
    </fieldset>
  </div>;
}
