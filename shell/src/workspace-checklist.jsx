import React from 'react';

// Which workspaces an agent connection reaches: My docs and each team, one
// checkbox each. The Allow page (/activate) and Settings > Agents tick from
// the same list; the server decides what the ticks mean (all of them is the
// whole account, some is just those).

export function WorkspaceChecklist({ workspaces, picked, onChange, disabled = false, label }) {
  const toggle = (id) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    // Keep the server's order (My docs first, then teams) whatever the
    // order of the clicks.
    onChange(workspaces.map((w) => w.id).filter((x) => next.includes(x)));
  };
  return (
    <fieldset className="tdoc-ws-pick" disabled={disabled}>
      <legend className="ui-sr-only">{label}</legend>
      {workspaces.map((w) => (
        <label key={w.id} className="tdoc-ws-option">
          <input type="checkbox" checked={picked.includes(w.id)} onChange={() => toggle(w.id)} />
          <span className="tdoc-ws-name">{w.name}</span>
          <span className="tdoc-ws-kind">{w.id === 'me' ? 'Your own docs' : 'Team'}</span>
        </label>
      ))}
    </fieldset>
  );
}

// "My docs and BeFreed", "All workspaces". `ids` null is the whole account.
export function workspaceSummary(workspaces, ids) {
  if (!Array.isArray(ids)) return 'All workspaces';
  const names = ids.map((id) => {
    const known = (workspaces || []).find((w) => w.id === id);
    return known ? known.name : (id === 'me' ? 'My docs' : null);
  }).filter(Boolean);
  if (!names.length) return 'No workspaces';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
