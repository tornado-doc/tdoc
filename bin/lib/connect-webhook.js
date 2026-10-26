// Connect an existing platform receiver. Never expose its signing secret in chat.
const fs = require('fs');
const path = require('path');
const os = require('os');
async function main(args = process.argv.slice(2)) {
  let url, label;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--label') label = args[++i];
    else throw new Error('Use --url HTTPS_RECEIVER --label PLATFORM_NAME.');
  }
  if (!url || new URL(url).protocol !== 'https:') throw new Error('Use your platform’s documented HTTPS task receiver.');
  const home = process.env.HOME || os.homedir();
  const config = JSON.parse(fs.readFileSync(process.env.TDOC_CONFIG || path.join(home, '.tdoc/published.json'), 'utf8'));
  const base = new URL(config.base);
  if (base.protocol !== 'https:' || base.username || base.password || !config.upload_token) throw new Error('Sign in to your hosted Tdoc account first.');
  const response = await fetch(new URL('/api/notify/webhook/register', base), { method: 'POST',
    headers: { Authorization: `Bearer ${config.upload_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, label }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Receiver registration failed (${response.status}).`);
  const result = await response.json();
  if (!/^wh_[a-f0-9]+$/.test(result.target?.agent_sub || '') || !result.secret) throw new Error('Receiver registration returned an invalid result.');
  const dir = process.env.TDOC_RECEIVER_DIR || path.join(home, '.tdoc', 'receivers'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${result.target.agent_sub}.json`);
  fs.writeFileSync(file, JSON.stringify({ base: base.origin, target: result.target, signing_secret: result.secret }) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`[tdoc] Receiver linked. Private signing configuration: ${file}`);
  console.log('[tdoc] Configure the receiver to verify Tdoc signatures using this file. Never paste its contents into chat. Return to Tdoc to check delivery. No daemon was started.');
}
if (require.main === module) main().catch(e => { console.error(`[tdoc] ${e.message}`); process.exitCode = 1; });
module.exports = { main };
