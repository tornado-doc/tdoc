#!/usr/bin/env node
// tdoc-new --from-csv / --from-tsv / --from-xlsx: a spreadsheet file → the
// HTML of a sheet doc on stdout (one <table data-tdoc-sheet> per worksheet,
// column types inferred), through the same shared/sheet-import.mjs the
// browser import runs. Warnings go to stderr; a refusal exits 1 with the
// same friendly message the browser shows.
//
//   node bin/lib/sheet-from-file.mjs --kind csv|tsv|xlsx [--title T] [--quiet] <file>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { importSheetFile } from '../../shared/sheet-import.mjs';

const args = process.argv.slice(2);
let kind = '', title = '', file = '', quiet = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--kind') kind = args[++i] || '';
  else if (args[i] === '--title') title = args[++i] || '';
  else if (args[i] === '--quiet') quiet = true;
  else file = args[i];
}
const fail = (message) => { process.stderr.write(`tdoc-new: ${message}\n`); process.exit(1); };
if (!file) fail('a spreadsheet file is required');
if (!['csv', 'tsv', 'xlsx'].includes(kind)) fail(`unknown sheet kind: ${kind}`);

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// SheetJS (Apache-2.0) is an npm dependency, not vendored: a checkout used as
// a skill has no node_modules until `npm ci`.
async function loadXlsx() {
  try {
    return createRequire(path.join(skillDir, 'package.json'))('xlsx');
  } catch {
    const error = new Error(`reading .xlsx needs SheetJS: run \`npm ci\` in ${skillDir}, or save the workbook as .csv and use --from-csv.`);
    error.name = 'SheetImportError';
    throw error;
  }
}

try {
  const stat = fs.statSync(file);
  const input = { name: path.basename(file), size: stat.size };
  if (stat.size <= 64 * 1024 * 1024) {
    if (kind === 'xlsx') input.bytes = new Uint8Array(fs.readFileSync(file));
    else input.text = fs.readFileSync(file, 'utf8');
  }
  const out = await importSheetFile(input, { kind, title, loadXlsx });
  for (const w of out.warnings) process.stderr.write(`tdoc-new: ${w}\n`);
  const rows = out.sheets.reduce((n, s) => n + s.rows.length, 0);
  if (!quiet) process.stderr.write(`[tdoc-new] sheet: ${out.sheets.length} tab${out.sheets.length === 1 ? '' : 's'}, ${rows} rows (${out.sheets.map((s) => `${s.name}: ${s.columns.map((c) => `${c.name}=${c.type}`).join(', ')}`).join('; ')})\n`);
  process.stdout.write(out.html);
} catch (error) {
  fail(error && error.name === 'SheetImportError' ? error.message : `could not import ${file}: ${error && error.message}`);
}
