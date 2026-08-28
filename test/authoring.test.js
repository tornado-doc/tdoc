// authoring/ contract guard.
//
// The point of authoring/ is that generation cannot quietly stop going
// through it. A prose rule set that nothing references is a file nobody
// reads, and that failure is silent: docs keep generating, just without
// the contract. These tests convert "the reference was dropped" and "the
// vendored copy was edited in place" into build failures.
//
// What this CANNOT test: whether a model actually obeys voice.md at
// generation time. The offline suite has no model. It tests that the
// contract is wired in and intact — necessary, not sufficient.
//
// Run with: node test/authoring.test.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

console.log('authoring/ contract');

t('all three slots exist', () => {
  for (const p of ['authoring/README.md', 'authoring/voice.md',
                   'authoring/style/README.md', 'authoring/structure/README.md']) {
    assert(exists(p), `missing ${p}`);
  }
});

t('structure/ carries the component library, and SKILL.md knows about it', () => {
  // structure/ stopped being an empty slot when the components moved out of
  // style/default.md. A component here must stay style-free: the moment one
  // hardcodes a colour, swapping style stops being a swap.
  const c = read('authoring/structure/components.md');
  assert(/stat tile|container frame|label chip/i.test(c),
    'components.md does not describe the parts');
  const hex = c.match(/#[0-9a-fA-F]{6}/g) || [];
  assert(hex.length === 0, `components.md hardcodes colour: ${hex.join(', ')} — treatment belongs in style/`);
  assert(read('SKILL.md').includes('authoring/structure/components.md'),
    'SKILL.md does not point at the component library');
});

t('every style gives the same components a treatment', () => {
  // The swap is only real if each style answers for the same parts. A style
  // that skips one leaves that component undefined the moment it is selected.
  const parts = ['Container frame', 'Label chip', 'Numbered group', 'Description box',
                 'Primary arrow', 'Secondary arrow', 'Accent fill', 'Textured variant', 'Stacked bar'];
  for (const entry of ['default', 'technical', 'paper', 'editorial']) {
    const text = read(`authoring/style/${entry}.md`);
    const missing = parts.filter(part => !text.includes(part));
    assert(missing.length === 0,
      `style/${entry}.md gives no treatment for: ${missing.join(', ')}`);
    // Tokens are what let a component nobody anticipated pick up this style.
    // Without them the listed parts still work and everything else is undressed,
    // which is the failure that made styles unswappable in the first place.
    const tokens = ['ink', 'rule', 'muted', 'surface',
                    'accent-fill', 'accent-stroke', 'accent-text', 'label-type'];
    const noToken = tokens.filter(tk => !new RegExp('`' + tk + '`').test(text));
    assert(noToken.length === 0,
      `style/${entry}.md declares no value for: ${noToken.join(', ')}`);
  }
});

t('the component list is open, not a vocabulary limit', () => {
  const c = read('authoring/structure/components.md');
  assert(/not on this list/i.test(c),
    'components.md does not say how to write a component it does not list');
  // The extension contract is the whole point: meet these and a user's own
  // component behaves like a listed one. If they drift, an invented component
  // silently stops swapping style or stops being commentable.
  for (const rule of ['token', 'data-tdoc-artifact']) {
    assert(c.includes(rule), `components.md extension contract lost "${rule}"`);
  }
});

t('style/ ships a default entry with its vocabulary', () => {
  assert(exists('authoring/style/default.md'), 'authoring/style/default.md missing');
  const d = read('authoring/style/default.md');
  // The default is the stark-sans / OpenAI-diagram aesthetic. Its whole point
  // is the diagram vocabulary and textured fills; an emptied file would pass a
  // mere existence check.
  for (const mark of ['Inter', 'pattern', 'hatch']) {
    assert(d.includes(mark), `default.md no longer carries "${mark}"`);
  }
  assert(/component treatment/i.test(d), 'default.md lost its component treatment section');
});

t('the default style sets its stark typography', () => {
  // The default is now the stark-sans aesthetic, which deliberately DOES set
  // typography: a clean sans everywhere and an oversized tight-tracked
  // headline. (The research-note style, which trusts overlay typography, lives
  // on as research.md.)
  const d = read('authoring/style/default.md');
  assert(/letter-spacing/i.test(d) && /Inter/i.test(d),
    'default.md no longer sets the stark sans typography (Inter + tight tracking)');
});

// Single source of truth. Every entry in style/ must be selectable by name
// from SKILL.md — otherwise the agent is offered a style it cannot be told
// to use, or a user names one the agent has never heard of. Both fail
// silently: the doc still generates, just with the wrong look.
t('every style/ entry is selectable from SKILL.md', () => {
  const s = read('SKILL.md');
  const entries = fs.readdirSync(path.join(root, 'authoring/style'))
    .filter(e => e.endsWith('.md') && e !== 'README.md');
  assert(entries.length > 0, 'authoring/style has no entries at all');
  const unreferenced = entries.filter(e => !s.includes(`authoring/style/${e}`));
  assert(unreferenced.length === 0,
    `style entries SKILL.md never mentions: ${unreferenced.join(', ')}\n` +
    '    An entry the agent cannot be told to use is a file nobody reads.');
});

t('a style is picked and applied on the generation path, not merely listed', () => {
  const s = read('SKILL.md');
  const a = s.indexOf('### `/tdoc new');
  const b = s.indexOf('### `bin/tdoc-new');
  assert(a !== -1 && b !== -1, '/tdoc new section not found');
  const section = s.slice(a, b);
  assert(/authoring\/style\//.test(section), '/tdoc new does not read an authoring/style/ entry');
  // The choice is the agent's. If this reverts to "the user names a style",
  // every doc silently gets `default` again whatever the content is.
  assert(/Choose the style that fits/.test(s),
    'SKILL.md no longer asks the agent to choose a style from the content');
});

t('visuals.md is a wired-in visual-first floor', () => {
  assert(exists('authoring/visuals.md'), 'authoring/visuals.md missing');
  const v = read('authoring/visuals.md');
  assert(/visual-first/i.test(v) && /flowchart/i.test(v),
    'visuals.md is not the visual-first floor (no visual-first / flowchart guidance)');
  // must be $SKILL_DIR-anchored and on both generation paths, like voice.md
  const s = read('SKILL.md');
  const seg=(a,b)=>{const x=s.indexOf(a);const y=b?s.indexOf(b,x):s.length;return s.slice(x,y===-1?s.length:y);};
  assert(seg('### `/tdoc new','### `bin/tdoc-new').includes('authoring/visuals.md'),
    '/tdoc new does not read authoring/visuals.md');
  assert(seg('### `/tdoc edit','### `/tdoc fork').includes('authoring/visuals.md'),
    '/tdoc edit does not read authoring/visuals.md');
});

t('SKILL.md makes voice.md required reading before generating', () => {
  const s = read('SKILL.md');
  assert(/authoring\/voice\.md/.test(s), 'SKILL.md never references authoring/voice.md');
  assert(/## Authoring contract/.test(s), 'SKILL.md lost the top-level Authoring contract section');
});

// The agent's cwd is the USER'S project, not the skill install. A bare
// relative path like `authoring/voice.md` resolves to nothing there, so the
// agent silently reads no contract and generation looks fine while being
// completely ungoverned. Every reference must carry $SKILL_DIR.
t('every authoring/ reference is $SKILL_DIR-anchored, never a bare relative path', () => {
  const s = read('SKILL.md');
  // Only real file paths -- not the prose phrase "Local skill is
  // authoring/scaffold" in the source-of-truth line.
  const PATHS = ['authoring/voice.md', 'authoring/style/',
                 'authoring/structure/', 'authoring/vendor/'];
  const bare = [];
  for (const ref of PATHS) {
    let i = 0;
    while ((i = s.indexOf(ref, i)) !== -1) {
      const prefix = s.slice(Math.max(0, i - 11), i);
      if (!prefix.endsWith('$SKILL_DIR/')) {
        const line = s.slice(0, i).split('\n').length;
        bare.push(`${ref} (line ${line})`);
      }
      i += ref.length;
    }
  }
  assert(bare.length === 0,
    `bare authoring/ paths in SKILL.md: ${bare.join(', ')}\n` +
    '    The agent runs in the user\'s project directory, so these resolve to nothing.\n' +
    '    Prefix with $SKILL_DIR/ (resolved in the Setup check section).');
});

t('SKILL.md says what $SKILL_DIR is, so the variable is not dangling', () => {
  const s = read('SKILL.md');
  const i = s.indexOf('## Authoring contract');
  assert(i !== -1, 'Authoring contract section missing');
  const sect = s.slice(i, s.indexOf('\n## ', i + 10));
  assert(/\.claude\/skills\/tdoc/.test(sect),
    'the Authoring contract section never says where $SKILL_DIR points');
  assert(/not.*working directory/i.test(sect),
    'the section does not warn that $SKILL_DIR is not the cwd');
});

t('the reference sits on BOTH generation paths (/tdoc new and /tdoc edit)', () => {
  const s = read('SKILL.md');
  const section = (start, end) => {
    const a = s.indexOf(start);
    assert(a !== -1, `section not found: ${start}`);
    const b = end ? s.indexOf(end, a) : s.length;
    return s.slice(a, b === -1 ? s.length : b);
  };
  const nw = section('### `/tdoc new', '### `bin/tdoc-new');
  const ed = section('### `/tdoc edit', '### `/tdoc fork');
  assert(/authoring\/voice\.md/.test(nw), '/tdoc new no longer reads authoring/voice.md');
  assert(/authoring\/voice\.md/.test(ed), '/tdoc edit no longer reads authoring/voice.md');
});

t('HTML generation rules point at the prose contract', () => {
  const s = read('SKILL.md');
  const i = s.indexOf('## HTML generation rules');
  assert(i !== -1, 'HTML generation rules section is gone');
  const sect = s.slice(i, s.indexOf('\n## ', i + 10));
  assert(/authoring\/voice\.md/.test(sect),
    'HTML generation rules no longer reference authoring/voice.md');
});

t('voice.md defers to the vendored rule set instead of forking it', () => {
  const v = read('authoring/voice.md');
  assert(/vendor\/no-ai-slop\.md/.test(v), 'voice.md does not point at the vendored rules');
  // The banned-word lists must have exactly one home. A second copy in
  // voice.md would drift from upstream the first time it is updated.
  assert(!/^Banned outright:/m.test(v),
    'voice.md duplicates the banned-word list — it must cite vendor/no-ai-slop.md as the authority');
});

t('voice.md carries the no-bullshit / efficiency stance as a default', () => {
  const v = read('authoring/voice.md');
  assert(/no bullshit/i.test(v) || /keep it efficient/i.test(v),
    'voice.md lost the explicit no-bullshit / keep-it-efficient stance');
  // It was asked to be a DEFAULT on every doc — assert it says so, not just
  // that the words appear once in passing.
  assert(/every doc|no doc.*exempt|by default/i.test(v),
    'the efficiency stance is present but not stated as applying to every doc by default');
});

t('voice.md fences off spans the prose rules must not rewrite', () => {
  const v = read('authoring/voice.md');
  // A prose rule applied to an error string or an API name corrupts it.
  for (const term of ['code', 'identifiers', 'quoted', 'data']) {
    assert(new RegExp(term, 'i').test(v), `voice.md does not fence off ${term}`);
  }
});

t('vendored no-ai-slop copy is present and unmodified', () => {
  assert(exists('authoring/vendor/no-ai-slop.md'), 'vendored copy missing');
  const body = read('authoring/vendor/no-ai-slop.md');
  assert(body.length > 2000, 'vendored copy looks truncated');
  const actual = crypto.createHash('sha256').update(body).digest('hex');
  const readme = read('authoring/README.md');
  const m = /Content sha256 of that file: `([0-9a-f]{64})`/.exec(readme);
  assert(m, 'authoring/README.md does not record the vendored sha256');
  assert(actual === m[1],
    `vendored copy was edited in place (sha ${actual.slice(0, 12)} vs recorded ${m[1].slice(0, 12)}).\n` +
    '    Adapt tdoc behavior in authoring/voice.md, not by editing the vendored file.\n' +
    '    If this is a genuine upstream refresh, update the sha and the pinned commit in README.');
});

t('MIT attribution ships with the vendored copy', () => {
  assert(exists('authoring/vendor/LICENSE-no-ai-slop'), 'upstream LICENSE not vendored');
  const lic = read('authoring/vendor/LICENSE-no-ai-slop');
  assert(/MIT License/.test(lic), 'vendored LICENSE is not the MIT text');
  assert(/Copyright \(c\)/.test(lic), 'vendored LICENSE has no copyright line');
  assert(/upstream|no-ai-slop/i.test(read('authoring/README.md')), 'README does not credit upstream');
});

t('upstream commit is pinned so a refresh is a deliberate diff', () => {
  const readme = read('authoring/README.md');
  assert(/\b[0-9a-f]{40}\b/.test(readme), 'README does not pin an upstream commit sha');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
