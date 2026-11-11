import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from '@base-ui/react/drawer';
import { ChevronDown, ChevronRight, Link2, RotateCcw, Sparkles, X } from 'lucide-react';
import { AppButton } from '../ui/button.jsx';
import { AppDialog } from '../ui/dialog.jsx';
import { AppSwitch } from '../ui/switch.jsx';
import { SideResizeHandle, useSideWidth } from '../ui/side-resize.jsx';
import { readStored, writeStored } from '../safe-storage.js';
import { ComparisonFrames } from './version-diff.jsx';
import { copyText } from './model.js';
import { getHistory, getHistorySummaries, restoreVersion } from './api.js';
import './version-history.css';

// Version history. Two layers: every save is still a
// version underneath (/d/<slug>/v/<n>), and the panel lists them as rows --
// consecutive saves by one person or agent within 30 minutes, grouped on the
// server (worker historyRows) -- saying who, when and what changed. A row
// opens to its saves. With Show changes on, a row shows its red/green against
// the save before it (the version compare's own frames, one column); off, the
// document as it was. One component on both widths: a resizable panel at the
// right on a desktop, a bottom drawer on a phone, the same rows in both.

const SHOW_CHANGES_KEY = 'tdoc-history-show-changes';
const PANEL_WIDTH = { storageKey: 'tdoc-history-width', initial: 340, min: 280, max: 560 };

// "Today, 9:41 AM" / "Yesterday, 6:19 PM" / "Nov 4, 3:26 PM" (and the year
// when it is not this one).
export function historyWhen(iso, now = new Date()) {
  const t = new Date(iso || '');
  if (Number.isNaN(t.getTime())) return '';
  const time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(t)) / 86400000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const date = t.toLocaleDateString(undefined, t.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${time}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a row says it did, from what the server knows (restore, accepted
// suggestions, the first version) and the cached change summary.
export function historyWhat(row) {
  if (row.restored_from) return 'Restored an earlier version';
  if (row.accepted_from) return `Accepted suggestions from ${row.accepted_from.join(', ')}`;
  if (row.created_doc) return 'Created the document';
  const s = row.summary;
  if (!s) return null;
  // A sheet too big to diff: how its row count moved.
  if (Array.isArray(s.rows) && s.rows.length === 2) {
    const [was, now] = s.rows.map((n) => Number(n) || 0);
    const rows = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'row' : 'rows'}`;
    return was === now ? `Edited the sheet · ${rows(now)}` : `Sheet: ${was.toLocaleString('en-US')} → ${rows(now)}`;
  }
  if (s.places === null || s.places === undefined) return 'Edited';
  if (!s.places) return 'No text changes';
  const where = s.sections && s.sections.length
    ? `Edited ${s.sections.slice(0, 3).join(', ')}${s.sections.length > 3 ? ` +${s.sections.length - 3}` : ''}`
    : 'Edited';
  return `${where} · ${plural(s.places, 'place')}`;
}

function WhoFace({ who }) {
  const name = who?.name || '?';
  if (who?.kind === 'agent') {
    return <span className="tdoc-history-face is-agent" aria-hidden="true"><Sparkles size={12} /></span>;
  }
  return <span className="tdoc-history-face" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

// The rows, a page at a time, and their summaries as the server computes them
// (a few per request; the first visible ones first).
export function useVersionHistory({ slug, open }) {
  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [latest, setLatest] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(new Set());

  const load = useCallback(async (before) => {
    setLoading(true);
    setError('');
    try {
      const body = await getHistory(slug, before);
      setLatest(Number(body.latest_version) || 0);
      setRows((current) => (before ? [...current, ...(body.rows || [])] : (body.rows || [])));
      setNext(body.next_before || null);
    } catch (err) {
      setError(err?.status === 403 ? 'The owner keeps this document’s history private.' : 'The history could not be loaded. Try again.');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    if (!open) return;
    asked.current = new Set();
    load(null);
  }, [open, load]);

  // Summaries for rows that need one, six per request, one request at a time.
  useEffect(() => {
    if (!open) return undefined;
    const missing = rows.filter((r) => !r.summary && !r.restored_from && !r.accepted_from && !r.created_doc
      && !asked.current.has(`${r.from}-${r.to}`)).slice(0, 6);
    if (!missing.length) return undefined;
    let live = true;
    missing.forEach((r) => asked.current.add(`${r.from}-${r.to}`));
    getHistorySummaries(slug, missing.map((r) => `${r.from}-${r.to}`)).then((body) => {
      if (!live) return;
      const found = body?.summaries || {};
      setRows((current) => current.map((r) => {
        const id = `${r.from}-${r.to}`;
        if (found[id]) return { ...r, summary: found[id] };
        // Asked and nothing came back: say "Edited" rather than wait forever.
        return missing.some((m) => m.from === r.from && m.to === r.to) ? { ...r, summary: { places: null, sections: [] } } : r;
      }));
    }).catch(() => {
      if (!live) return;
      setRows((current) => current.map((r) => (missing.some((m) => m.from === r.from && m.to === r.to) ? { ...r, summary: { places: null, sections: [] } } : r)));
    });
    return () => { live = false; };
  }, [open, rows, slug]);

  return { rows, next, latest, loading, error, loadMore: () => next && load(next), reload: () => load(null) };
}

// What a selection compares: a row against the save before it (the next
// row's newest save, or the number before), or one save against the one
// before it in the row.
function selectionFor(rows, index, saveN = null) {
  const row = rows[index];
  if (!row) return null;
  const older = rows[index + 1];
  const rowBefore = older ? older.to : Math.max(0, row.from - 1);
  if (saveN === null) return { key: `${row.from}-${row.to}`, row: index, n: row.to, before: rowBefore, after: row.to };
  const at = row.saves.findIndex((s) => s.n === saveN);
  const before = at >= 0 && row.saves[at + 1] ? row.saves[at + 1].n : rowBefore;
  return { key: `save-${saveN}`, row: index, n: saveN, before, after: saveN };
}

function HistoryRow({ row, index, rows, latest, devMode, selection, expanded, onToggle, onSelect, actions }) {
  const what = historyWhat(row);
  const selectedHere = selection && selection.row === index;
  const many = row.saves.length > 1;
  const range = row.from === row.to ? `v${row.to}` : `v${row.from}–v${row.to}`;
  return (
    <li className={`tdoc-history-row${selectedHere && selection.key === `${row.from}-${row.to}` ? ' is-selected' : ''}`} data-row={`${row.from}-${row.to}`}>
      <div className="tdoc-history-rowline">
        <button type="button" className="tdoc-history-rowmain" aria-pressed={Boolean(selectedHere && selection.key === `${row.from}-${row.to}`)} onClick={() => onSelect(selectionFor(rows, index))}>
          <WhoFace who={row.who} />
          <span className="tdoc-history-rowtext">
            <span className="tdoc-history-who">
              {row.who?.name || 'Someone'}
              {row.who?.owner && row.who.owner !== row.who.name ? <span className="tdoc-history-owner"> · {row.who.owner}</span> : null}
            </span>
            <span className={`tdoc-history-what${what ? '' : ' is-pending'}`}>{what || 'Edited…'}</span>
            <span className="tdoc-history-meta">
              {row.to === latest ? 'Latest · ' : ''}{historyWhen(row.created)}
              {many ? ` · ${plural(row.saves.length, 'save')}` : ''}
              {devMode ? ` · ${range}` : ''}
            </span>
          </span>
        </button>
        {many ? (
          <AppButton variant="icon" size="s" className="tdoc-history-expand" aria-expanded={expanded}
            aria-label={expanded ? 'Hide the saves in this row' : 'Show each save'} onClick={() => onToggle(row)}>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </AppButton>
        ) : null}
      </div>
      {selectedHere && selection.key === `${row.from}-${row.to}` ? actions : null}
      {many && expanded ? (
        <ul className="tdoc-history-saves" aria-label="Saves in this row">
          {row.saves.map((save) => {
            const chosen = selection && selection.key === `save-${save.n}`;
            return (
              <li key={save.n} className={chosen ? 'is-selected' : ''}>
                <button type="button" className="tdoc-history-save" aria-pressed={Boolean(chosen)} onClick={() => onSelect(selectionFor(rows, index, save.n))}>
                  {historyWhen(save.created)}{devMode ? ` · v${save.n}` : ''}{save.n === latest ? ' · Latest' : ''}
                </button>
                {chosen ? actions : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function HistoryList({ history, selection, onSelect, devMode, showChanges, onShowChanges, suggestionCount, onOpenSuggestions, actions, onClose, closeLabel }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (row) => setExpanded((current) => {
    const nextSet = new Set(current);
    const id = `${row.from}-${row.to}`;
    if (nextSet.has(id)) nextSet.delete(id); else nextSet.add(id);
    return nextSet;
  });
  return (
    <>
      <div className="tdoc-history-head">
        <h2 className="tdoc-history-title">Version history</h2>
        {onClose ? <AppButton variant="icon" size="s" aria-label={closeLabel} onClick={onClose}><X size={16} /></AppButton> : null}
      </div>
      <div className="tdoc-history-toggle">
        <AppSwitch id="tdoc-history-show-changes" checked={showChanges} onCheckedChange={onShowChanges} label="Show changes" />
      </div>
      <div className="tdoc-history-scroll">
        <ul className="tdoc-history-list" aria-label="Versions">
          {suggestionCount > 0 ? (
            <li className="tdoc-history-row is-pending-suggestions">
              <div className="tdoc-history-rowline">
                <button type="button" className="tdoc-history-rowmain" onClick={onOpenSuggestions}>
                  <span className="tdoc-history-face is-agent" aria-hidden="true"><Sparkles size={12} /></span>
                  <span className="tdoc-history-rowtext">
                    <span className="tdoc-history-who">{plural(suggestionCount, 'suggestion')} waiting</span>
                    <span className="tdoc-history-meta">Not in the document yet · Review</span>
                  </span>
                </button>
              </div>
            </li>
          ) : null}
          {history.rows.map((row, index) => (
            <HistoryRow
              key={`${row.from}-${row.to}`}
              row={row}
              index={index}
              rows={history.rows}
              latest={history.latest}
              devMode={devMode}
              selection={selection}
              expanded={expanded.has(`${row.from}-${row.to}`)}
              onToggle={toggle}
              onSelect={onSelect}
              actions={actions}
            />
          ))}
        </ul>
        {history.error ? <p className="tdoc-history-note" role="alert">{history.error}</p> : null}
        {history.loading ? <p className="tdoc-history-note" role="status">Loading…</p> : null}
        {history.next && !history.loading ? (
          <div className="tdoc-history-more"><AppButton variant="quiet" size="s" onClick={history.loadMore}>Show older</AppButton></div>
        ) : null}
      </div>
    </>
  );
}

// The document beside the panel: the selection's changes, the document as
// that selection left it, or (nothing chosen) the version the page is on.
function HistoryDocument({ slug, selection, showChanges, fallbackVersion, theme, latest, onBack }) {
  const frame = useRef(null);
  const n = selection ? selection.after : fallbackVersion;
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ source: 'tdoc-shell', type: 'tdoc:theme', theme }, '*');
  }, [theme, n, showChanges]);
  return (
    <main className="tdoc-history-doc" aria-label={selection ? (showChanges ? 'Changes in this version' : 'This version') : 'Document'}>
      {selection ? (
        <div className="tdoc-history-strip" role="status">
          <span>{showChanges ? 'Showing what changed' : 'Showing this version'}{selection.after === latest ? ' (the latest)' : ''}</span>
          <AppButton variant="quiet" size="s" onClick={onBack}>{fallbackVersion === latest ? 'Back to latest' : 'Back'}</AppButton>
        </div>
      ) : null}
      {selection && showChanges ? (
        <ComparisonFrames key={`${selection.before}:${selection.after}`} slug={slug} before={selection.before} after={selection.after} narrow bare theme={theme} />
      ) : (
        <iframe
          key={n}
          ref={frame}
          className="tdoc-history-frame"
          aria-label="Document version"
          sandbox="allow-scripts"
          src={`/d/${encodeURIComponent(slug)}/v/${n}/frame?tdoc_compare=1`}
          onLoad={() => frame.current?.contentWindow?.postMessage({ source: 'tdoc-shell', type: 'tdoc:theme', theme }, '*')}
        />
      )}
    </main>
  );
}

export function VersionHistory({ config, narrow, theme, devMode = false, suggestions = null, onClose, onToast }) {
  const history = useVersionHistory({ slug: config.slug, open: true });
  const [selection, setSelection] = useState(null);
  const [showChanges, setShowChangesState] = useState(() => readStored(SHOW_CHANGES_KEY) !== '0');
  const [restoring, setRestoring] = useState(null);
  const [busy, setBusy] = useState(false);
  const [snap, setSnap] = useState(0.6);
  const side = useSideWidth(PANEL_WIDTH);
  const setShowChanges = (on) => { setShowChangesState(on); writeStored(SHOW_CHANGES_KEY, on ? '1' : '0'); };
  const latest = history.latest || Math.max(0, ...(config.versions || []).map((v) => Number(v.n) || 0));
  const suggestionCount = suggestions?.enabled ? (suggestions.pending || []).length : 0;

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !restoring) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, restoring]);

  // On a phone the chosen row stays in view at the top of the lowered drawer.
  useEffect(() => {
    if (!narrow || !selection) return undefined;
    const id = setTimeout(() => {
      document.querySelector('.tdoc-history-drawer .tdoc-history-row.is-selected, .tdoc-history-drawer .tdoc-history-saves li.is-selected')
        ?.scrollIntoView({ block: 'start' });
    }, 250);
    return () => clearTimeout(id);
  }, [narrow, selection]);
  const select = (next) => {
    setSelection((current) => (current && next && current.key === next.key ? null : next));
    // On a phone the drawer drops low so the document shows above it.
    if (narrow && next) setSnap('260px');
  };
  const share = async (n) => {
    const ok = await copyText(`${location.origin}/d/${encodeURIComponent(config.slug)}/v/${n}`);
    onToast(ok ? 'Link to this version copied' : 'Could not copy the link', !ok);
  };
  const restore = async () => {
    if (!restoring) return;
    setBusy(true);
    try {
      const body = await restoreVersion(config.slug, restoring.n);
      onToast('Restored. Opening the new version…');
      location.href = body?.url ? `${body.url.replace(/\/v\/\d+$/, '')}` : `/d/${encodeURIComponent(config.slug)}`;
    } catch (err) {
      const code = err?.body?.error;
      onToast(code === 'version_conflict' || code === 'save_in_progress'
        ? 'The doc was just updated. Try again in a moment.'
        : code === 'already_latest' ? 'This is already the latest version.'
          : err?.body?.message || 'Could not restore this version.', true);
      setBusy(false);
      setRestoring(null);
    }
  };

  const actionsFor = (n) => (
    <div className="tdoc-history-actions">
      <AppButton variant="secondary" size="s" onClick={() => share(n)}><Link2 size={14} /> Share this version</AppButton>
      {config.canRestore && n !== latest ? (
        <AppButton variant="secondary" size="s" onClick={() => setRestoring({ n })}><RotateCcw size={14} /> Restore</AppButton>
      ) : null}
    </div>
  );
  const actions = selection ? actionsFor(selection.n) : null;
  const openSuggestions = () => {
    onClose();
    const first = suggestions?.ordered?.[0];
    if (first) setTimeout(() => suggestions.focus(first.key), 50);
    // Not placed in this page's document (it opened on the history, or on an
    // older version): the latest version, where the review bar shows them.
    else location.assign(`/d/${encodeURIComponent(config.slug)}`);
  };

  const list = (
    <HistoryList
      history={history}
      selection={selection}
      onSelect={select}
      devMode={devMode}
      showChanges={showChanges}
      onShowChanges={setShowChanges}
      suggestionCount={suggestionCount}
      onOpenSuggestions={openSuggestions}
      actions={actions}
      onClose={onClose}
      closeLabel="Close version history"
    />
  );

  return (
    <div className={`tdoc-history-stage${narrow ? ' is-narrow' : ''}`}>
      <HistoryDocument
        slug={config.slug}
        selection={selection}
        showChanges={showChanges}
        fallbackVersion={Number(config.version)}
        theme={theme}
        latest={latest}
        onBack={() => setSelection(null)}
      />
      {narrow ? (
        <Drawer.Root open modal={false} onOpenChange={(open) => { if (!open) onClose(); }} swipeDirection="down"
          snapPoints={['260px', 0.6, 0.92]} snapPoint={snap} onSnapPointChange={(point) => setSnap(point)}>
          <Drawer.Portal>
            <Drawer.Viewport className="tdoc-history-drawer-viewport">
              <Drawer.Popup className="tdoc-history-drawer" aria-label="Version history">
                <Drawer.Title className="tdoc-visually-hidden">Version history</Drawer.Title>
                <Drawer.Close className="tdoc-drawer-handle" aria-label="Close version history" />
                <Drawer.Content className="tdoc-history-drawer-body">{list}</Drawer.Content>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
      ) : (
        <aside className="tdoc-history-panel" style={{ width: side.width }} aria-label="Version history">
          <SideResizeHandle side={side} label="Resize version history" />
          {list}
        </aside>
      )}
      <AppDialog
        open={Boolean(restoring)}
        onOpenChange={(open) => { if (!open && !busy) setRestoring(null); }}
        title="Restore this version?"
        description="The document goes back to how it was then, saved as a new version. Nothing is lost: what it says now stays in the history."
        actions={(
          <>
            <AppButton disabled={busy} onClick={() => setRestoring(null)}>Cancel</AppButton>
            <AppButton variant="primary" disabled={busy} onClick={restore}>{busy ? 'Restoring…' : 'Restore'}</AppButton>
          </>
        )}
      />
    </div>
  );
}
