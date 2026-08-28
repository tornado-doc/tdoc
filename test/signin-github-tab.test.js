// GitHub device sign-in remains a deliberate native-link handoff from the
// reusable React dialog. No scripted popup may steal the current interaction.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const src = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'sign-in-dialog.jsx'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document', 'api.js'), 'utf8');

console.log('React sign-in GitHub handoff');

t('the dialog uses the shared dialog primitive and a real anchor', () => {
  assert(/<AppDialog/.test(src), 'shared dialog primitive missing');
  assert(/<a[\s\S]*className="tds-open"[\s\S]*href=\{verificationUrl\}/.test(src), 'verification anchor missing');
});

t('the anchor opens a protected new tab', () => {
  assert(/target="_blank"/.test(src), 'anchor must target _blank');
  assert(/rel="noopener noreferrer"/.test(src), 'anchor must isolate the new tab');
});

t('only an HTTPS github.com URL is linked', () => {
  assert(/url\.protocol === 'https:'/.test(src), 'HTTPS check missing');
  assert(/github\\\.com\$/.test(src), 'github.com hostname check missing');
  assert(/isGitHubUrl\(verificationUrl\)/.test(src), 'anchor is not guarded');
});

t('nothing opens GitHub automatically', () => {
  assert(!/window\.open|\bopen\(/.test(src), 'dialog opens GitHub itself');
  assert(/onClick=\{\(\) => device\?\.user_code && copyText/.test(src), 'anchor tap should copy the device code');
});

t('polling continues after the handoff and can be cancelled', () => {
  assert(/const poll = \(deviceCode\)/.test(src) && /pollDeviceSignIn\(deviceCode\)/.test(src), 'poll loop missing');
  // The effect's `device` state is the value captured at mount (null); polling
  // through it never sends a real code. The code must travel via the closure.
  assert(!/pollDeviceSignIn\(device\.device_code\)/.test(src), 'poll reads device_code from stale React state');
  assert(/poll\(result\.device_code\)/.test(src), 'start() must hand the fresh device code to the poll loop');
  assert(/cancelled = true/.test(src) && /clearTimeout\(timer\)/.test(src), 'poll cleanup missing');
  assert(/authorization_pending/.test(src) && /slow_down/.test(src), 'device-flow polling states missing');
});

t('device endpoints stay behind the client API boundary', () => {
  assert(/export function startDeviceSignIn/.test(api), 'start API wrapper missing');
  assert(/export function pollDeviceSignIn/.test(api), 'poll API wrapper missing');
  assert(!/fetch\('/.test(src), 'dialog bypasses the API module');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
