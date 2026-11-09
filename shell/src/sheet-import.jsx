import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';
import { createDocument, saveDocumentVersion } from './document/api.js';

// Import a spreadsheet as a sheet doc: Create a doc → "Import a spreadsheet",
// or a .csv / .tsv / .xlsx dropped on My docs. The file is read in the
// browser (shared/sheet-import.mjs, the same code bin/tdoc-new runs), a doc
// is created and its first save replaces the blank scaffold, so the import
// is v1 and its heading names the doc. SheetJS is loaded only for an .xlsx.

export const SHEET_ACCEPT = '.csv,.tsv,.tab,.xlsx,.xlsm,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET_NAME = /\.(csv|tsv|tab|xlsx|xlsm)$/i;

export function isSheetFileName(name) {
  return SHEET_NAME.test(String(name || ''));
}

const loadXlsx = () => import('xlsx/dist/xlsx.mini.min.js').then((m) => m.default || m);

async function readFile(file, kind) {
  if (kind === 'xlsx') return { bytes: new Uint8Array(await file.arrayBuffer()) };
  return { text: await file.text() };
}

export async function importSheetDocument(file, team) {
  const { importSheetFile, fileKind, LIMITS, SheetImportError } = await import('../../shared/sheet-import.mjs');
  const kind = fileKind(file.name);
  // Refuse a huge file before reading it into memory.
  if (file.size > LIMITS.bytes) throw new SheetImportError(`That file is ${Math.round(file.size / 1024 / 1024)} MB. Sheets import files up to ${Math.round(LIMITS.bytes / 1024 / 1024)} MB.`, 'too_large');
  const contents = kind === 'xlsx' || kind === 'csv' || kind === 'tsv' ? await readFile(file, kind) : {};
  const sheet = await importSheetFile({ name: file.name, size: file.size, ...contents }, { loadXlsx });
  const created = await createDocument(team || '');
  const saved = await saveDocumentVersion(created.slug, created.version || 1, sheet.html);
  return { url: saved.url || created.url, warnings: sheet.warnings, sheets: sheet.sheets.length };
}

// "New sheet": a blank sheet doc, opened straight into Edit mode. The same
// create + first save as an import, so it is v1 and titled from its heading.
export async function createBlankSheet(team) {
  const { blankSheetHtml } = await import('../../shared/sheet-markup.mjs');
  const created = await createDocument(team || '');
  const saved = await saveDocumentVersion(created.slug, created.version || 1, blankSheetHtml());
  const next = new URL(saved.url || created.url, location.origin);
  next.searchParams.set('edit', '1');
  return { url: `${next.pathname}${next.search}` };
}

export function sheetErrorText(error) {
  return errorText(error);
}

function errorText(error) {
  if (!error) return '';
  if (error.name === 'SheetImportError') return error.message;
  if (error.body?.error === 'quota_docs') return 'You have reached your plan\'s doc limit. Delete a doc or upgrade, then import again.';
  if (error.body?.error === 'payload_too_large') return 'This sheet is larger than a doc can be. Remove rows or columns, or split the file.';
  if (error.status === 401) return 'Sign in to import a spreadsheet.';
  return error.message || 'The import failed. Try again.';
}

// One dialog for both doors. `start` imports at once (the file was chosen
// from the menu); otherwise it asks first (a file dropped on the page).
export function SheetImportDialog({ file, team, start = false, onClose }) {
  const [state, setState] = useState(start ? 'working' : 'confirm');
  const [error, setError] = useState('');
  const began = useRef(false);
  const run = useCallback(async () => {
    setState('working');
    setError('');
    try {
      const done = await importSheetDocument(file, team);
      location.href = done.url;
    } catch (failure) {
      setError(errorText(failure));
      setState('error');
    }
  }, [file, team]);
  useEffect(() => {
    if (start && !began.current) { began.current = true; run(); }
  }, [start, run]);
  const size = file.size >= 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open && state !== 'working') onClose(); }}
      title={state === 'error' ? 'Could not import this file' : 'Import as sheet'}
      actions={(
        <>
          <AppButton onClick={onClose} disabled={state === 'working'}>Cancel</AppButton>
          {state === 'error' ? null : (
            <AppButton variant="primary" className="primary" onClick={run} disabled={state === 'working'}>
              {state === 'working' ? 'Importing…' : 'Import as sheet'}
            </AppButton>
          )}
        </>
      )}
    >
      <p className="sheet-import-file"><b>{file.name}</b> <span className="muted">{size}</span></p>
      {state === 'error' ? <p className="sheet-import-error" role="alert">{error}</p> : (
        <p className="muted">
          {state === 'working'
            ? 'Reading the file and creating the doc…'
            : 'Each worksheet becomes a tab. Column types (numbers, dates, tags, checkboxes, links) are worked out from the values; you can change them in Edit mode.'}
        </p>
      )}
    </AppDialog>
  );
}

// The file chooser behind Create a doc → Import a spreadsheet. It lives in
// the hub, not in the menu: the menu unmounts its items when it closes, and
// the chooser outlives that.
export const SheetFilePicker = forwardRef(function SheetFilePicker({ onFile }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      accept={SHEET_ACCEPT}
      hidden
      aria-label="Spreadsheet to import"
      data-testid="sheet-import-input"
      onChange={(event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (file) onFile(file);
      }}
    />
  );
});

// A spreadsheet dragged over the page: say what a drop will do, then hand
// the file to the dialog. Only files, never text or links dragged in.
export function useSheetFileDrop({ enabled, onFile }) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let depth = 0;
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    const enter = (event) => { if (!hasFiles(event)) return; depth += 1; setOver(true); };
    const leave = (event) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setOver(false); };
    const overHandler = (event) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } };
    const drop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) onFile(file);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overHandler);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', overHandler);
      window.removeEventListener('drop', drop);
    };
  }, [enabled, onFile]);
  return over;
}

export function SheetDropHint() {
  return (
    <div className="sheet-drop-hint" aria-hidden="true">
      <div>
        <b>Drop to import as a sheet</b>
        <span>.csv, .tsv or .xlsx</span>
      </div>
    </div>
  );
}
