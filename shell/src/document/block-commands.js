import {
  Heading1,
  Heading2,
  Heading3,
  Image,
  List,
  ListOrdered,
  Minus,
  Quote,
  Table,
  Type,
} from 'lucide-react';

// The block commands of modeless editing (flag modelessEdit): ONE list that
// both the "/" menu and the selection toolbar read, so an item added here
// shows in both.
//   id     what it is; also the block kind the frame reports for "turnInto"
//          items (the toolbar's dropdown is labelled with the current one)
//   label  the menu row; `short` the toolbar label when it is current
//   Icon   a lucide icon
//   kind   'turnInto': changes the block the caret or selection is in (the
//          toolbar's level dropdown); 'insert': adds a block (the toolbar's
//          ··· menu, after the selection's block). "/" lists both, applied
//          to its empty line.
//   run(ctx) does it. ctx.block(command, value) asks the frame
//          (frame-probe.js blockApply: p, h1-h3, quote, ul, ol, table,
//          divider, image); ctx.askImage() asks for an image address first.
export const BLOCK_COMMANDS = [
  { id: 'p', label: 'Text', short: 'Text', Icon: Type, kind: 'turnInto', run: (ctx) => ctx.block('p') },
  { id: 'h1', label: 'Heading 1', short: 'H1', Icon: Heading1, kind: 'turnInto', run: (ctx) => ctx.block('h1') },
  { id: 'h2', label: 'Heading 2', short: 'H2', Icon: Heading2, kind: 'turnInto', run: (ctx) => ctx.block('h2') },
  { id: 'h3', label: 'Heading 3', short: 'H3', Icon: Heading3, kind: 'turnInto', run: (ctx) => ctx.block('h3') },
  { id: 'ul', label: 'Bulleted list', short: 'List', Icon: List, kind: 'turnInto', run: (ctx) => ctx.block('ul') },
  { id: 'ol', label: 'Numbered list', short: '1. List', Icon: ListOrdered, kind: 'turnInto', run: (ctx) => ctx.block('ol') },
  { id: 'quote', label: 'Quote', short: 'Quote', Icon: Quote, kind: 'turnInto', run: (ctx) => ctx.block('quote') },
  { id: 'table', label: 'Table', Icon: Table, kind: 'insert', run: (ctx) => ctx.block('table') },
  { id: 'image', label: 'Image', Icon: Image, kind: 'insert', run: (ctx) => ctx.askImage() },
  { id: 'divider', label: 'Divider', Icon: Minus, kind: 'insert', run: (ctx) => ctx.block('divider') },
];

// The list in use: BLOCK_COMMANDS, plus any a page pinned before boot
// (tests: window.__TDOC_BLOCK_COMMANDS_EXTRA__ = [{ id, label, kind,
// command }], each run as ctx.block(command)).
export function blockCommands() {
  const extra = typeof window !== 'undefined' && Array.isArray(window.__TDOC_BLOCK_COMMANDS_EXTRA__)
    ? window.__TDOC_BLOCK_COMMANDS_EXTRA__
      .filter((item) => item && item.id && item.label && (item.kind === 'turnInto' || item.kind === 'insert'))
      .map((item) => ({ Icon: Minus, ...item, run: (ctx) => ctx.block(String(item.command || item.id)) }))
    : [];
  return [...BLOCK_COMMANDS, ...extra];
}
