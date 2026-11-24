import React, { useEffect, useState } from 'react';
import { ChevronRight, ExternalLink, Globe } from 'lucide-react';
import { AppDialog } from '../ui/dialog.jsx';
import { AppButton } from '../ui/button.jsx';
import { AppTextarea } from '../ui/textarea.jsx';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import { moveDocsToTeam } from '../document/api.js';
import { SdkSteps, SiteDemo, SiteDemoSteps } from '../feedback-install.jsx';
import { MoveToTeamDialog } from './teams.jsx';
import { day } from './rows.jsx';

// Sites: the sites people comment on (feedback spaces), as their own tab of
// My docs and of a team (commentsSitesTabs). One row per site with where its
// comments stand and one button: Settings for a site with the line
// installed (the settings open under the row), Add to your site for one only
// ever commented on with the bookmark. Comments themselves are in Comments.

// Local and preview builds: kept, but folded under "Test sites" and left out
// of the counts. localhost and 127.0.0.1 on any port, and the pr-<n>-…
// hosts the common preview services give a pull request.
const PREVIEW_SITE = /^pr-\d+-[a-z0-9.-]*\.(workers\.dev|pages\.dev|vercel\.app)$/;
export function isTestSite(origin) {
  let host = '';
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || PREVIEW_SITE.test(host);
}

export function siteHost(origin) {
  try { return new URL(origin).host; } catch { return String(origin || ''); }
}

const snippetFor = (slug) => `<script src="${location.origin}/feedback.js" data-tdoc-space="${slug}" async></script>`;

// A site's settings: its addresses, the line to paste once it is on, and
// Turn off. The same state behind the dialog (FeedbackList, flag off) and
// the inline panel under a Sites row.
function useSiteSettings(space, onSaved) {
  const [origins, setOrigins] = useState(() => ((space.site && space.site.origins) || [space.origin]).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snippet, setSnippet] = useState(space.site ? snippetFor(space.slug) : '');
  const save = async (off = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/feedback/site', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(off ? { slug: space.slug, off: true } : { slug: space.slug, origins: origins.split(/[\s,]+/).filter(Boolean) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error === 'invalid_origin' ? `Not a site address: ${body.origin}. Use the form https://example.com.` : (body.message || body.error || 'Could not save'));
      if (off) { setSnippet(''); onSaved(null); return true; }
      setSnippet(body.snippet);
      onSaved(body.site);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { origins, setOrigins, busy, error, snippet, save };
}

function cspOrigin(snippet) {
  return (snippet.match(/src="(https?:\/\/[^/"]+)\/feedback\.js"/) || [])[1] || location.origin;
}

// Turn a feedback space into the site's own comment space: the snippet any
// page can paste and which origins it works on. Who may comment is the
// space's own Share settings, as on any doc.
export function SiteEmbedDialog({ space, onClose, onSaved }) {
  const { origins, setOrigins, busy, error, snippet, save } = useSiteSettings(space, onSaved);
  return (
    <AppDialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title="Comments on your site"
      description="Paste one line into your site and the people you share this space with can comment on any page. Every comment lands here."
      actions={(
        <>
          {space.site ? <AppButton variant="danger" className="danger" disabled={busy} onClick={async () => { if (await save(true)) onClose(); }}>Turn off</AppButton> : null}
          <AppButton onClick={onClose}>Close</AppButton>
          <AppButton variant="primary" className="primary" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : 'Save'}</AppButton>
        </>
      )}
    >
      <div className="tdoc-send">
        <div className="tdoc-send-field">
          <label className="tdoc-send-label" htmlFor="tdoc-site-origins">Site addresses <span>one per line</span></label>
          <textarea id="tdoc-site-origins" className="tdoc-notify-instruction" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://example.com" />
        </div>
        <p className="tdoc-send-hint">Who can comment follows this space's <a href={`/d/${encodeURIComponent(space.slug)}?share=1`}>Share settings</a>, like any doc.</p>
        {snippet ? (
          <div className="tdoc-send-field">
            <span className="tdoc-send-label">Paste this into your site</span>
            <code className="tdoc-site-snippet">{snippet}</code>
            <CopyPromptButton text={snippet} />
            <p className="tdoc-send-hint">If your site sends a Content-Security-Policy, add <code>{cspOrigin(snippet)}</code> to <code>script-src</code>, <code>connect-src</code> and <code>img-src</code>. Nothing else is needed.</p>
          </div>
        ) : null}
        {error ? <p className="tdoc-send-result tdoc-notify-error" role="status">{error}</p> : null}
      </div>
    </AppDialog>
  );
}

// The same settings, open under the site's row.
function SiteSettingsPanel({ space, team, onSaved, onClose }) {
  const { origins, setOrigins, busy, error, snippet, save } = useSiteSettings(space, onSaved);
  const fieldId = `site-origins-${space.slug}`;
  const installed = Boolean(space.site);
  return (
    <div className="site-settings" id={`site-settings-${space.slug}`} role="region" aria-label={`${siteHost(space.origin)} settings`}>
      {installed ? null : <p className="site-settings-hint">Now only you comment here, with the bookmark. Add one line and visitors can comment too.</p>}
      <label className="site-settings-label" htmlFor={fieldId}>Site addresses <span>one per line</span></label>
      <AppTextarea id={fieldId} className="site-settings-origins" rows={2} maxHeight={160} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://example.com" />
      {snippet ? (
        <>
          <span className="site-settings-label">Paste this before <code>&lt;/head&gt;</code></span>
          <div className="site-settings-snippet">
            <code className="tdoc-site-snippet">{snippet}</code>
            <CopyPromptButton text={snippet} />
          </div>
          <p className="site-settings-hint">If your site sends a Content-Security-Policy, add <code>{cspOrigin(snippet)}</code> to <code>script-src</code>, <code>connect-src</code> and <code>img-src</code>.</p>
        </>
      ) : null}
      <p className="site-settings-hint">
        {team ? `Every ${team.name} member can comment. Admins change this in ` : 'Who can comment follows '}
        <a href={`/d/${encodeURIComponent(space.slug)}?share=1`}>Share settings</a>{team ? '.' : ', like any doc.'}
      </p>
      {error ? <p className="site-settings-error" role="status">{error}</p> : null}
      <div className="site-settings-ft">
        <a className="site-settings-open" href={`/d/${encodeURIComponent(space.slug)}`}>Open site page<ExternalLink size={13} aria-hidden="true" /></a>
        <span className="site-settings-actions">
          {installed ? <AppButton variant="danger" disabled={busy} onClick={() => save(true)}>Turn off</AppButton> : null}
          <AppButton onClick={onClose}>Close</AppButton>
          <AppButton variant="primary" disabled={busy} onClick={() => save(false)}>
            {busy ? 'Saving…' : installed ? 'Save' : 'Get the line'}
          </AppButton>
        </span>
      </div>
    </div>
  );
}

// A space's counts load when the list opens (a comment read per space), as
// the Feedback list always did; until then the boot's rows show.
export function useFeedbackSpaces(initial, team) {
  const [spaces, setSpaces] = useState(initial);
  useEffect(() => {
    let cancelled = false;
    fetch(team ? `/api/me/feedback?team=${encodeURIComponent(team.id)}` : '/api/me/feedback', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => { if (!cancelled && b && Array.isArray(b.spaces)) setSpaces(b.spaces); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [team && team.id]);
  return [spaces, setSpaces];
}

function SiteRow({ space, team, manages, open, onToggle, onAdd, onOpenComments, onSaved, test }) {
  const host = siteHost(space.origin);
  // In a team's list the binding is sent only to those who manage it, so
  // only they are told whether the line is in.
  const state = test ? null : space.site ? 'on' : manages ? 'bookmark' : null;
  const meta = [
    space.open == null ? null : <b key="open">{space.open} open</b>,
    space.replied ? `${space.replied} replied` : null,
    team || space.mine ? null : 'joined',
    state === 'on' ? <span key="on" className="site-row-on">● on the site</span> : state === 'bookmark' ? 'bookmark only' : null,
    space.updated ? `updated ${day(space.updated)}` : null,
  ].filter(Boolean);
  return (
    <>
      <div className={`doc-row flat-row site-row${open ? ' is-open' : ''}${test ? ' is-test' : ''}`} data-site={space.slug}>
        <button type="button" className="site-row-info" onClick={() => onOpenComments(space)} title={`Comments on ${host}`}>
          <span className="site-row-mark" aria-hidden="true"><Globe size={16} /></span>
          <span className="site-row-text">
            <span className="doc-title">{host}</span>
            <span className="doc-meta">{meta.map((part, i) => <React.Fragment key={i}>{i ? ' · ' : ''}{part}</React.Fragment>)}</span>
          </span>
        </button>
        {manages ? (
          <AppButton className="site-row-btn" aria-expanded={open} aria-controls={`site-settings-${space.slug}`} onClick={() => (open || space.site ? onToggle() : onAdd(space))}>
            {space.site ? 'Settings' : 'Add to your site'}
          </AppButton>
        ) : null}
      </div>
      {open && manages ? <SiteSettingsPanel space={space} team={team} onSaved={onSaved} onClose={onToggle} /> : null}
    </>
  );
}

// Nothing here yet: what this is and how to start, the same block as
// /feedback's SDK part (the demo and the two ways in). Its main button asks
// for the site's address and makes its space (the endpoint
// create_feedback_space uses), then opens that site's settings with the
// line; the second link tries the widget on /feedback first.
function SitesIntro({ team }) {
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/feedback/spaces', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origins: address.split(/[\s,]+/).filter(Boolean), ...(team ? { team: team.id } : {}) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.slug) throw new Error(body.message || body.error || 'Could not add the site');
      location.href = `/me?${team ? `team=${encodeURIComponent(team.id)}&` : ''}view=sites&site=${encodeURIComponent(body.slug)}`;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="tdoc-feedback-page fb-sites-intro" id="sites-intro">
      <h2>Comments on your own site</h2>
      <p className="fb-sites-lead">
        {team
          ? `Put comments on the ${team.name} team's sites. Every member sees them here and in Comments.`
          : 'People click anything on your site and say what is wrong. Your agent picks it up and fixes it.'}
      </p>
      <SiteDemo animated />
      <SiteDemoSteps />
      <SdkSteps scriptSrc={`${location.origin}/feedback.js`} arrive={false} />
      {adding ? (
        <div className="site-settings fb-sites-add" role="region" aria-label="Add your site">
          <label className="site-settings-label" htmlFor="sites-add-address">Your site’s address</label>
          <input
            id="sites-add-address"
            className="site-settings-origins"
            type="url"
            autoFocus
            value={address}
            placeholder="https://example.com"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && address.trim() && !busy) create(); }}
          />
          {error ? <p className="site-settings-error" role="status">{error}</p> : null}
          <div className="site-settings-ft">
            <span className="site-settings-actions">
              <AppButton onClick={() => setAdding(false)}>Cancel</AppButton>
              <AppButton variant="primary" disabled={busy || !address.trim()} onClick={create}>{busy ? 'Adding…' : 'Get the line'}</AppButton>
            </span>
          </div>
        </div>
      ) : (
        <div className="fb-sites-actions">
          <AppButton variant="primary" onClick={() => setAdding(true)}>Add to your site</AppButton>
          <a className="ui-btn ui-btn-quiet ui-btn-m" href="/feedback#try">Try it on a page first →</a>
        </div>
      )}
    </div>
  );
}

// `inScope`: which of the person's spaces this tab lists (My docs leaves a
// team's sites to that team's tab).
export function SitesPane({ spaces: initial, team = null, teams = [], inScope = () => true, onOpenComments }) {
  const [all, setSpaces] = useFeedbackSpaces(initial, team);
  const spaces = all.filter(inScope);
  // ?site=<slug>: open with that site's settings (after a move to a team).
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('site') || '');
  const [teamFirst, setTeamFirst] = useState(null);
  // As FeedbackList: a personal space whose owner runs a team is offered
  // the move first (site comments are team work), with one click to stay
  // personal. Only teams this person admins.
  const adminTeams = (teams || []).filter((item) => item.role === 'admin');
  const manages = (space) => (team ? Boolean(space.can_manage) : Boolean(space.mine));
  const add = (space) => {
    if (!space.site && !space.workspace_id && adminTeams.length) setTeamFirst({ space, busy: false, error: '' });
    else setOpen(space.slug);
  };
  const moveFirst = async (target) => {
    const { space } = teamFirst;
    setTeamFirst((current) => ({ ...current, busy: true, error: '' }));
    try {
      await moveDocsToTeam([space.slug], target.id);
      setTeamFirst(null);
      // It lives in that team now: its Sites tab, with its settings open.
      location.href = `/me?team=${encodeURIComponent(target.id)}&view=sites&site=${encodeURIComponent(space.slug)}`;
    } catch (err) {
      setTeamFirst((current) => ({ ...current, busy: false, error: err.message || 'Could not move this space.' }));
    }
  };
  const saved = (slug) => (site) => setSpaces((list) => list.map((s) => (s.slug === slug ? { ...s, site: site || undefined } : s)));
  const real = spaces.filter((space) => !isTestSite(space.origin));
  const tests = spaces.filter((space) => isTestSite(space.origin));
  const row = (space, test = false) => (
    <SiteRow
      key={space.slug}
      space={space}
      team={team}
      manages={manages(space)}
      open={open === space.slug}
      onToggle={() => setOpen(open === space.slug ? '' : space.slug)}
      onAdd={add}
      onOpenComments={onOpenComments}
      onSaved={saved(space.slug)}
      test={test}
    />
  );
  return (
    <section className="pane sites-pane" id="pane-sites" aria-label="Sites">
      {!spaces.length ? <SitesIntro team={team} /> : (
        <>
          {real.length ? <div className="doc-list sites-list">{real.map((space) => row(space))}</div> : null}
          {tests.length ? (
            <details className="sites-tests">
              <summary><ChevronRight size={15} aria-hidden="true" />Test sites · {tests.length}</summary>
              <div className="doc-list sites-list">{tests.map((space) => row(space, true))}</div>
            </details>
          ) : null}
        </>
      )}
      {teamFirst ? (
        <MoveToTeamDialog
          title="Move it to a team first?"
          intro="Comments from your site's visitors are team work: in a team, its members see them and its admins decide who else can comment."
          teams={adminTeams}
          count={1}
          busy={teamFirst.busy}
          error={teamFirst.error}
          skipLabel="Keep it personal"
          onSkip={() => { const { space } = teamFirst; setTeamFirst(null); setOpen(space.slug); }}
          onClose={() => { if (!teamFirst.busy) setTeamFirst(null); }}
          onMove={moveFirst}
        />
      ) : null}
    </section>
  );
}
