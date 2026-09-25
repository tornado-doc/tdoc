// The words and the two helpers the onboarding shares, and nothing else.
//
// These used to live at the top of a 649-line wizard that no longer exists.
// Four files import from here — the setup gate, the Create-a-doc cards, the
// document shell and the comment card — and none of them should have to pull
// in a dialog to get a string.

export const RECIPE_URL = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
// The line for somebody who already has tdoc installed: FIRST-DOC.md would
// only build the same portrait again. A sentence rather than a slash command,
// because it is pasted into a conversation with an agent and the skill fires
// on a plain request -- its own front matter says the word "tdoc" is not even
// required.
export const ANOTHER_DOC_RECIPE = 'Use tdoc to write a doc about what it should be about, publish it, and give me the link';
// The line names the doc: an agent handed a bare 'read my comments' has to
// guess which of the docs on the machine is meant.
export const handoffLine = (docUrl) => `Read all comments on ${docUrl} and fix them`;
export const AGENT_DEFINITION = 'An AI that runs on your computer and can read and write files.';
export const AGENT_NAMES = 'Claude Code · Codex · Claude Cowork · ChatGPT Work';
export const NOTHING_YET = 'Check your agent’s window.';
export const COPY_FALLBACK = 'Copy the selected line.';

// Select the text of an element, for the person to copy by hand when the
// clipboard refused. Never throws.
export function selectContents(element) {
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {}
}
