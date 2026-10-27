// The comment composer's @ list (shell/src/document/ai-answerer.js
// composerAgents): agents that may edit this doc first (the server's order,
// the last editor first), then the commenter's own and the team's agents
// that may only answer; tdoc AI only when no agent can answer. "Only me"
// starts on for tdoc AI only. A bare @AI is never a GitHub @login.
// Run with: node test/ai-answerer.test.js

(async () => {
  const { composerAgents, freeLeftText, TDOC_AI, mentionsAi, joinAiTags, AI_MENTION, withoutAskTags, onlyMeDefault, isOwnTdocAiReply } = await import('../shell/src/document/ai-answerer.js');
  let pass = 0, fail = 0;
  const t = (n, fn) => { try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } };
  const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
  console.log('Composer @ list: edit or ask only');

  const own = { provider: 'raft', server_id: 's', agent_sub: 'mine', agent_name: 'my-bot' };
  const ownLocal = { provider: 'local', server_id: 'box', device: 'box', cli: 'claude', agent_sub: 'box_claude', status: 'active' };
  const sleepy = { ...ownLocal, agent_sub: 'box_codex', cli: 'codex', status: 'inactive' };
  const team = { provider: 'local', server_id: 'tbox', device: 'tbox', cli: 'claude', agent_sub: 'tbox_claude', status: 'active', team_agent: { id: 'ta1', name: 'Acme bot' }, last_writer: true };

  t('may edit: the edit list first (last editor first), then agents that may only answer', () => {
    const list = composerAgents({ canSendToAgent: true, notifyTargets: { default: team, candidates: [] }, mine: { agents: [ownLocal], team_agents: [team], tdoc_ai: false } });
    assert(list.length === 2 && list[0].team_agent && list[0].can_edit === true, JSON.stringify(list));
    assert(list[1].agent_sub === 'box_claude' && list[1].can_edit === false, 'own agent offered to ask');
  });
  t('may not edit: own agents (reachable only), then the team agent', () => {
    const list = composerAgents({ canSendToAgent: false, mine: { agents: [sleepy, ownLocal, own], team_agents: [team], tdoc_ai: false } });
    assert(list.map((x) => x.agent_sub).join() === 'box_claude,mine,tbox_claude', JSON.stringify(list.map((x) => x.agent_sub)));
    assert(list.every((x) => x.can_edit === false), 'something may edit');
  });
  t('tdoc AI for everyone, always last; it never edits', () => {
    const list = composerAgents({ canSendToAgent: false, mine: { agents: [], team_agents: [], tdoc_ai: true } });
    assert(list.length === 1 && list[0].tdoc_ai && list[0].can_edit === false, JSON.stringify(list));
    const beside = composerAgents({ mine: { agents: [own], team_agents: [], tdoc_ai: true } });
    assert(beside.length === 2 && beside[1].tdoc_ai, 'tdoc AI not last beside an agent');
  });
  t('the free count shows only when few are left', () => {
    assert(freeLeftText(200) === null && freeLeftText(11) === null, 'a large allowance is not news');
    assert(freeLeftText(10) === '10 free left' && freeLeftText(0) === 'no free answers left');
  });
  t('"Only me" starts on for tdoc AI, off for an agent', () => {
    assert(onlyMeDefault(TDOC_AI) === true);
    assert(onlyMeDefault(own) === false);
  });
  t('a bare @AI is never a login; the question drops the tag', () => {
    for (const yes of ['@AI why?', 'why? @ai', 'ok (@AI)', 'ask @AI.', `x ${AI_MENTION} y`]) assert(mentionsAi(yes), yes);
    for (const no of ['@AIDA hi', 'mail a@ai.com', '@ai-team', 'AI please', '@aim']) assert(!mentionsAi(no), no);
    assert(!/(^|[^A-Za-z0-9_@/-])@[A-Za-z0-9]/.test(joinAiTags('@AI and @ai')), 'still reads as a login mention');
    assert(withoutAskTags('Why billing? @⁠tdoc AI', '@⁠tdoc AI') === 'Why billing?');
    assert(withoutAskTags('Why billing? @AI') === 'Why billing?');
  });
  t("the quota line is for the asker's own tdoc AI replies only", () => {
    const reply = { author: { kind: 'agent', login: 'tdoc-ai', owner: { key: 'reader', display: 'reader' } } };
    assert(isOwnTdocAiReply(reply, 'reader'));
    assert(!isOwnTdocAiReply(reply, 'other'));
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
