'use client';

import { groupPermissions, toggle } from '@/lib/team';

interface Props {
  idPrefix: string;
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function PermissionPicker({ idPrefix, available, selected, onChange, disabled }: Props) {
  const groups = groupPermissions(available);
  return (
    <div className="ap-perms">
      {groups.map((g) => {
        const all = g.items.every((i) => selected.includes(i.permission));
        return (
          <fieldset key={g.key} className="ap-fieldset" disabled={disabled}>
            <legend>{g.label}</legend>
            <button
              type="button"
              className="ap-link ap-small"
              onClick={() => {
                const keys = g.items.map((i) => i.permission);
                onChange(all ? selected.filter((s) => !keys.includes(s)) : [...new Set([...selected, ...keys])]);
              }}
            >
              {all ? 'Clear all' : 'Select all'}
            </button>
            {g.items.map((i) => {
              const id = `${idPrefix}-${i.permission}`;
              return (
                <div key={i.permission} className="ap-check">
                  <input id={id} type="checkbox" checked={selected.includes(i.permission)} onChange={(e) => onChange(toggle(selected, i.permission, e.target.checked))} aria-describedby={i.hint ? `${id}-h` : undefined} />
                  <label htmlFor={id}>{i.label}{i.hint && <span id={`${id}-h`} className="ap-hint"> {i.hint}</span>}</label>
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
