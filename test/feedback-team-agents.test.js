// The widget's @ list offers the team's agents where the doc page would: a
// member of the team that owns the space, answer only, in the thread. Only
// through the door the holder's own agents already use (the bookmarklet's
// token on tdoc's own pages, feedbackTokenOwnAgent); a token living in
// another site's page still makes no agent run.
// Run with: node test/feedback-team-agents.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const TDOC = 'https://tdoc.dev';
const APP = 'http://localhost:3000';

(async () => {
  console.log('feedback widget: team agents in the @ list, answer only');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, {});
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const home = { Origin: TDOC };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: home, body: { name: 'Acme' } })).body.team;
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  const added = (await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: home, body: { id: team.id, name: 'acme-bot' } })).body;
  const agentToken = (await call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'acme-box' } })).body.token;
  await call('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'acme-box', clis: ['claude'] } });

  // A team's feedback space for tdoc.dev itself, and one for a third-party app.
  const connect = async (who, body) => (await call('/api/feedback/connect', { method: 'POST', cookie: who.cookie, body })).body;
  const ownSpace = await connect(julie, { origin: TDOC });
  const appSpace = await connect(julie, { origin: APP });
  const moved = await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: [ownSpace.slug, appSpace.slug] } });
  assert(moved.status === 200, `move: ${moved.status} ${moved.text}`);
  const bobHome = await connect(bob, { origin: TDOC, slug: ownSpace.slug });
  const bobApp = await connect(bob, { origin: APP, slug: appSpace.slug });
  const anchor = (url) => ({ kind: 'product', url: `${url}/x`, selector: '#x', tag: 'div', text: 'x' });
  const post = async (token, slug, url) => (await call('/api/comments', { method: 'POST', token, body: { slug, version: 1, text: 'why?', anchor: anchor(url) } })).body;

  await t('a member\'s widget on tdoc\'s own pages lists the team agent and asks it in the thread', async () => {
    assert(bobHome.slug === ownSpace.slug && bobHome.own_agent === true, `bob connect ${JSON.stringify({ slug: bobHome.slug, own_agent: bobHome.own_agent, error: bobHome.error })}`);
    const got = await call(`/api/docs/${ownSpace.slug}/my-agent`, { token: bobHome.token, headers: home });
    assert(got.status === 200, `GET ${got.status} ${got.text}`);
    const target = (got.body.team_agents || [])[0];
    assert(target && target.team_agent && target.team_agent.name === 'acme-bot', `team agents ${JSON.stringify(got.body.team_agents)}`);
    assert(got.body.tdoc_ai === false, 'tdoc AI offered in the widget');
    const comment = await post(bobHome.token, ownSpace.slug, TDOC);
    assert(comment && comment.id, `comment ${JSON.stringify(comment)}`);
    const asked = await call(`/api/docs/${ownSpace.slug}/my-agent`, { method: 'POST', token: bobHome.token, headers: home, body: { comment_id: comment.id, recipient: target } });
    assert(asked.status === 200 && asked.body.ask.comment_id === comment.id && asked.body.ask.team_agent, `ask ${asked.status} ${asked.text}`);
    // The widget sees that question (in a thread), as it does an own agent's.
    const again = await call(`/api/docs/${ownSpace.slug}/my-agent`, { token: bobHome.token, headers: home });
    assert(again.body.asks.some((a) => a.ask_id === asked.body.ask.ask_id), 'the widget lost its question');
    // Never privately, never free text.
    const free = await call(`/api/docs/${ownSpace.slug}/my-agent`, { method: 'POST', token: bobHome.token, headers: home, body: { question: 'anything', recipient: target } });
    assert(free.status === 400, `free text ${free.status}`);
  });

  await t('a token on a third-party app\'s team space still reaches no agent', async () => {
    assert(bobApp.slug === appSpace.slug && bobApp.own_agent === false, `bob app connect ${JSON.stringify({ slug: bobApp.slug, own_agent: bobApp.own_agent })}`);
    const comment = await post(bobApp.token, appSpace.slug, APP);
    for (const opts of [{}, { method: 'POST', body: { comment_id: comment.id, recipient: { team_agent: { id: 'x' } } } }]) {
      for (const headers of [{ Origin: APP }, home]) {
        const r = await call(`/api/docs/${appSpace.slug}/my-agent`, { token: bobApp.token, headers, ...opts });
        assert(r.status === 403, `${opts.method || 'GET'} from ${headers.Origin}: ${r.status} ${r.text}`);
      }
    }
    // Nor does the team's hand-off (an editing run) open to any widget token.
    const handoff = await call('/api/notify/handoff', { method: 'POST', token: bobHome.token, body: { slug: ownSpace.slug, comment_ids: [] } });
    assert(handoff.status !== 200, `hand-off through a token: ${handoff.status}`);
  });

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
