/* Lost Lead WhatsApp — screens. Plain JS, no build step, no inline handlers (strict CSP).
   Every number shown comes from the REST API (docs/openapi.yaml). */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const main = $('#main');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n == null ? '—' : Number(n).toLocaleString('en-GB'));
const pct = x => (x * 100).toFixed(1) + '%';
const pp = x => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1) + ' pts';
const BH = { timeZone: 'Asia/Bahrain' };
const dt = s => s ? new Date(s).toLocaleString('en-GB', { ...BH, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const dd = s => s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('en-GB', { ...BH, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const todayBH = () => new Date().toLocaleDateString('en-CA', BH);

let ME = null; // {user, csrf, perms, provider, goLive, killSwitch, halted}
const can = p => !!ME && ME.perms.includes(p);

/* ---------- API ---------- */
async function api(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (ME && method !== 'GET') opt.headers['X-CSRF-Token'] = ME.csrf;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401 && url !== '/api/login') { ME = null; showLogin(); throw new Error('Please sign in'); }
  const data = r.headers.get('content-type') && r.headers.get('content-type').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
  return data;
}
async function uploadFile(file) {
  const r = await fetch('/api/uploads', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': ME.csrf, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' }, body: file });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Upload failed');
  return data;
}
let toastTimer;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3500);
}

/* ---------- small renderers ---------- */
const tile = (k, v, n, cls) => `<div class="tile ${cls || ''}"><span class="k">${esc(k)}</span><span class="v">${typeof v === 'number' ? fmt(v) : esc(v)}</span><span class="n">${esc(n || '')}</span></div>`;
const table = (cols, rows, empty, rowAttr) => `<div class="tablewrap"><table><thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${
  rows.length ? rows.map(r => `<tr ${rowAttr ? rowAttr(r) : ''}>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.html ? c.html(r) : esc(c.v(r))}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="empty">${esc(empty || 'Nothing here yet.')}</td></tr>`}</tbody></table></div>`;
const STATUS = { queued: ['Waiting', ''], active: ['In sequence', 'steel'], asked: ['Asked permission', 'test'], optout: ['Opted out', 'bad'], handover: ['With salesperson', 'live'],
  quiet: ['No reply', ''], declined: ['Declined', ''], failed: ['Not delivered', 'bad'], listed: ['On a list', 'bad'], holdout: ['Holdout', 'hold'], done: ['Resolved', 'live'],
  draft: ['Draft', ''], pending_approval: ['Waiting for approval', 'test'], approved: ['Approved', 'steel'], running: ['Running', 'live'], paused: ['Paused', 'test'], completed: ['Completed', ''], cancelled: ['Cancelled', 'bad'],
  accepted: ['Accepted by Meta', 'steel'], sent: ['Sent', 'steel'], delivered: ['Delivered', 'live'], read: ['Read', 'live'], blocked: ['Blocked', 'bad'], sending: ['Sending', ''], received: ['Received', 'accent'],
  APPROVED: ['Approved', 'live'], PENDING: ['Pending', 'test'], REJECTED: ['Rejected', 'bad'], PAUSED: ['Paused', 'bad'], DISABLED: ['Disabled', 'bad'], UNKNOWN: ['Not synced', ''], NOT_FOUND: ['Not in Meta', 'bad'] };
const pill = s => { const x = STATUS[s] || [s, '']; return `<span class="pill ${x[1]}">${esc(x[0])}</span>`; };
const BUCKET = { price: 'Price or finance', stock: 'Waiting for stock', thinking: 'Still thinking', competitor: 'Bought elsewhere', features: "Product didn't fit", family: 'Family said no', noresp: 'Stopped responding', noreason: 'No reason recorded', disq: 'Disqualified', ask: 'Asked the reason' };
function bars() { main.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; }); }

/* ---------- shell ---------- */
const NAV = [['', 'Dashboard'], ['import', 'Import'], ['campaigns', 'Campaigns'], ['inbox', 'Inbox'], ['customers', 'Customers'], ['templates', 'Templates'], ['lists', 'Opt-outs & lists'], ['results', 'Results'], ['settings', 'Settings'], ['audit', 'Audit log', 'audit.view'], ['users', 'Users']];
async function shell() {
  ME = await api('GET', '/api/me');
  let inbox = 0; try { inbox = (await api('GET', '/api/inbox')).length; } catch { /* ignore */ }
  const route = location.hash.replace(/^#\/?/, '').split('/')[0];
  $('#nav').hidden = false;
  $('#nav').innerHTML = NAV.filter(n => !n[2] || can(n[2])).map(([h, label]) => `<a href="#/${h}" class="${route === h ? 'on' : ''}">${esc(label)}${h === 'inbox' && inbox ? `<span class="count">${inbox}</span>` : ''}</a>`).join('') +
    `<span class="spacer"></span><a href="#" data-act="logout">Sign out ${esc(ME.user.name)} (${esc(ME.user.role)})</a>`;
  const strip = $('#strip'); strip.hidden = false;
  strip.innerHTML = (ME.killSwitch ? '<span class="pill kill">KILL SWITCH ON · nothing is sent</span>' : '') +
    (ME.halted ? '<span class="pill kill">SENDING HALTED · see Settings</span>' : '') +
    (ME.goLive ? '<span class="pill live">LIVE · customers can receive messages</span>' : '<span class="pill test">TEST MODE · allow-listed numbers only</span>') +
    `<span class="pill steel">Provider: ${esc(ME.provider)}</span>`;
}
function showLogin(msg) {
  $('#nav').hidden = true; $('#strip').hidden = true;
  main.innerHTML = `<form class="panel login" data-form="login"><h2>Sign in</h2>
    ${msg ? `<div class="banner bad">${esc(msg)}</div>` : ''}
    <label class="f">Email<input type="email" name="email" autocomplete="username" required></label>
    <label class="f">Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Sign in</button>
    <p class="hint">No account? An admin creates users. The first admin is created on the server: <span class="mono">node cli.js create-admin</span>.</p></form>`;
}

/* ---------- screens ---------- */
const screens = {};

screens[''] = async () => {
  const d = await api('GET', '/api/dashboard');
  const banners = [];
  if (d.killSwitch) banners.push(`<div class="banner bad">The kill switch is on. Nothing is being sent to anyone.</div>`);
  if (d.halted) banners.push(`<div class="banner bad">Sending stopped itself after an account-level error from Meta: ${esc(d.halted.label)}. Fix it, then resume from Settings.</div>`);
  if (!d.goLive) banners.push(`<div class="banner warn">Test mode. Only numbers on the allow-list (Settings) can receive anything. Customers in running campaigns wait until an admin turns go-live on.</div>`);
  if (d.provider !== 'cloud') banners.push(`<div class="banner steel">Provider is <b>${esc(d.provider)}</b>: no message reaches WhatsApp. ${d.provider === 'mock' ? 'Delivery, read and reply events are simulated.' : 'Sends are recorded only.'}</div>`);
  if (!d.approvedTemplates) banners.push(`<div class="banner warn">No approved templates are known. Sync them on the Templates screen.</div>`);
  return `${banners.join('')}
  <div class="tiles">
    ${tile('Sent today', `${fmt(d.sentToday)} / ${fmt(d.dailyCap)}`, 'templates against the daily cap', 'send')}
    ${tile('Queued', d.queued, 'waiting in the outbox')}
    ${tile('Inbox', d.inbox, 'customers with a salesperson', d.inbox ? 'good' : '')}
    ${tile('Opted out', d.optouts, 'never messaged again', 'hold')}
    ${tile('Dead letters', d.deadLetters, 'gave up after retries', d.deadLetters ? 'bad' : '')}
    ${tile('Webhook backlog', d.webhookBacklog, 'events not yet processed', d.webhookBacklog > 50 ? 'bad' : '')}
  </div>
  <div class="grid2">
    <section class="panel"><h3>Controls</h3>
      <div class="row">${can('kill.engage') ? (d.killSwitch ? (ME.user.role === 'admin' ? '<button data-act="kill" data-on="0">Release kill switch</button>' : '<span class="hint">Only an admin can release the kill switch.</span>') : '<button class="danger" data-act="kill" data-on="1">Stop all sending now</button>') : ''}
      <a class="btn" href="#/import">Import a lost-sales export</a><a class="btn" href="#/campaigns">Campaigns</a></div>
      <dl class="kv"><dt>Campaigns</dt><dd>${Object.entries(d.campaigns).map(([s, n]) => `${pill(s)} ${fmt(n)}`).join(' ') || 'none yet'}</dd>
      <dt>Templates approved</dt><dd>${fmt(d.approvedTemplates)} · last sync ${dt(d.lastSync)}</dd></dl>
    </section>
    <section class="panel"><h3>Waiting for a second person to approve</h3>
      ${d.pendingApproval.length ? d.pendingApproval.map(c => `<a class="btn" href="#/campaigns/${c.id}">${esc(c.name)}</a>`).join(' ') : '<p class="hint">Nothing waiting.</p>'}
      <p class="hint">A campaign is approved by someone other than the person who built it.</p>
    </section>
  </div>
  <section class="panel"><h3>Latest messages</h3>
  ${table([{ h: 'When', v: r => dt(r.created_at) }, { h: 'Mobile', html: r => `<a href="#/customers/${encodeURIComponent(r.mobile)}" class="mono">${esc(r.mobile)}</a>` }, { h: 'Direction', v: r => r.dir === 'in' ? 'From customer' : 'To customer' },
    { h: 'Kind', v: r => r.kind }, { h: 'Status', html: r => pill(r.status) }, { h: 'Outcome', v: r => r.outcome || '' }], d.recent, 'No messages yet.')}</section>`;
};

/* import */
let UPLOAD = null;
screens.import = async () => {
  const imps = await api('GET', '/api/imports');
  const map = UPLOAD ? `<section class="panel"><h3>2 · Check the columns</h3>
    <p class="hint">${esc(UPLOAD.fileName)} · ${fmt(UPLOAD.rowCount)} rows${UPLOAD.headerless ? ' · no header row found, so columns were matched from their contents' : ''}. Mobile and loss reason are required.</p>
    <form data-form="runImport" class="grid3">${UPLOAD.fields.map(f => `<label class="f">${esc(f.label)}${f.req ? ' *' : ''}<select name="${esc(f.key)}"><option value="">— not in file —</option>${UPLOAD.headers.map(h => `<option ${UPLOAD.map[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}
    <div class="row"><button class="primary" type="submit">Run the engine</button><button type="button" data-act="clearUpload">Choose another file</button></div></form>
    ${table(UPLOAD.headers.slice(0, 9).map(h => ({ h, v: r => typeof r[h] === 'string' && /^\d{4}-\d\d-\d\dT/.test(r[h]) ? r[h].slice(0, 10) : r[h] })), UPLOAD.sample, '')}</section>` : '';
  return `<section class="panel"><h3>1 · Load the CRM lost-sales export</h3>
    <div class="drop" data-drop="main"><p class="hint">Drop an .xlsx or .csv here, or choose it. The file is read on this server and kept in its database; nothing goes to WhatsApp until a campaign is approved and started.</p>
    <div class="row"><label class="btn">Choose file<input type="file" accept=".xlsx,.xls,.csv,.txt" data-file="main" hidden></label>
    ${can('import') ? '<button data-act="sample">Use the sample data (fictional)</button>' : ''}</div></div></section>
  ${map}
  <section class="panel"><h3>Earlier imports</h3>
  ${table([{ h: 'File', html: r => `<a href="#/imports/${r.id}">${esc(r.file_name)}</a>` }, { h: 'When', v: r => dt(r.created_at) }, { h: 'By', v: r => r.uploaded_by || '' },
    { h: 'Rows', num: 1, v: r => fmt(r.row_count) }, { h: 'Ready', num: 1, v: r => fmt(r.summary.send) }, { h: 'Holdout', num: 1, v: r => fmt(r.summary.holdout) }, { h: 'Meta', num: 1, v: r => fmt(r.summary.meta) }, { h: 'Excluded', num: 1, v: r => fmt(r.summary.excluded) }], imps, 'No imports yet.')}</section>`;
};

screens.imports = async id => {
  const p = await api('GET', '/api/imports/' + id);
  const s = p.import.summary, total = Math.max(1, s.send + s.holdout + s.meta + s.excluded);
  const w = n => (n / total * 100).toFixed(2);
  const exRows = Object.entries(s.exCount).filter(([, n]) => n).map(([k, n]) => ({ k, n, label: (p.excluded.find(x => x.ex_reason === k) || {}).ex_label || k }));
  return `<div class="row between"><h2>${esc(p.import.file_name)}</h2><span class="hint">Imported ${dt(p.import.created_at)} · holdout ${p.import.options.holdPct}% (key ${p.import.options.seed}) · consent from ${esc(p.import.options.consentFrom || '—')}</span></div>
  <div class="tiles">${tile('Rows', s.total, 'in the file')}${tile('Customers', s.unique, 'unique valid mobiles')}${tile('Excluded', s.excluded, 'see reasons below', 'bad')}${tile('Holdout', s.holdout, 'deliberately sent nothing', 'hold')}${tile('Meta audience', s.meta, 'disqualified: ads, not WhatsApp')}${tile('Ready', s.send, 'to message once approved', 'send')}</div>
  <section class="panel"><div class="bar"><span class="send" data-w="${w(s.send)}"></span><span class="hold" data-w="${w(s.holdout)}"></span><span class="meta" data-w="${w(s.meta)}"></span><span class="ex" data-w="${w(s.excluded)}"></span></div>
  <div class="legend"><span><i class="send"></i>Ready ${fmt(s.send)}</span><span><i class="hold"></i>Holdout ${fmt(s.holdout)}</span><span><i class="meta"></i>Meta ${fmt(s.meta)}</span><span><i class="ex"></i>Excluded ${fmt(s.excluded)}</span></div></section>
  <div class="grid2"><section class="panel"><h3>Buckets</h3>${table([{ h: 'Bucket', v: r => BUCKET[r[0]] || r[0] }, { h: 'To message', num: 1, v: r => fmt(r[1].send) }, { h: 'Holdout', num: 1, v: r => fmt(r[1].hold) }], Object.entries(s.bucketCount))}</section>
  <section class="panel"><h3>Why leads were left out</h3>${table([{ h: 'Reason', v: r => r.label }, { h: 'Leads', num: 1, v: r => fmt(r.n) }], exRows, 'Nobody was excluded.')}
  <div class="row"><a class="btn" href="/api/imports/${id}/export/send">Send list CSV</a><a class="btn" href="/api/imports/${id}/export/holdout">Holdout CSV</a><a class="btn" href="/api/imports/${id}/export/meta">Meta audience CSV</a><a class="btn" href="/api/imports/${id}/export/excluded">Excluded CSV</a></div></section></div>
  ${can('campaign.build') ? `<form class="panel" data-form="buildCampaign" data-import="${id}"><h3>Build a campaign from this import</h3>
    <div class="grid3"><label class="f">Name<input type="text" name="name" value="${esc(p.import.file_name.replace(/\.\w+$/, ''))} — ${todayBH()}" required></label>
    <label class="f">Day 0 (Bahrain date)<input type="date" name="startDate" min="${todayBH()}" value="${todayBH()}" required></label>
    <div class="row"><button class="primary" type="submit">Create draft</button></div></div>
    <p class="hint">The draft then needs a second person to approve it before it can start.</p></form>` : ''}
  <section class="panel"><h3>Ready to message (first ${Math.min(p.send.length, 50)})</h3>
  ${table([{ h: 'Mobile', v: r => r.mobile }, { h: 'Customer', v: r => r.name }, { h: 'Brand', v: r => r.brand }, { h: 'Model', v: r => r.model }, { h: 'Bucket', v: r => BUCKET[r.bucket] || r.bucket },
    { h: 'Track', v: r => r.track === 'permission' ? 'Permission first' : 'Standard' }, { h: 'Day 0 template', html: r => `<span class="mono">${esc(r.tpl_name)}</span>` }, { h: 'Salesperson', v: r => r.sales }], p.send.slice(0, 50))}</section>`;
};

/* campaigns */
screens.campaigns = async id => {
  if (id) return campaignDetail(id);
  const list = await api('GET', '/api/campaigns');
  return `<div class="row between"><h2>Campaigns</h2><a class="btn" href="#/import">New: import a file</a></div>
  ${table([{ h: 'Campaign', html: r => `<a href="#/campaigns/${r.id}">${esc(r.name)}</a>` }, { h: 'Status', html: r => pill(r.status) }, { h: 'Day 0', v: r => dd(r.start_date) },
    { h: 'Built by', v: r => r.created_by_name }, { h: 'Approved by', v: r => r.approved_by_name || '—' }, { h: 'Customers', num: 1, v: r => fmt(r.enrolled) }], list, 'No campaigns yet. Import a file to build one.')}`;
};
async function campaignDetail(id) {
  const d = await api('GET', '/api/campaigns/' + id), c = d.campaign;
  const order = ['draft', 'pending_approval', 'approved', 'running', 'completed'];
  const at = order.indexOf(c.status);
  const steps = order.map((s, i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}">${esc(STATUS[s][0])}</span>`).join('');
  const mine = c.created_by === ME.user.id;
  const btn = (act, label, cls) => `<button class="${cls || ''}" data-act="camp" data-do="${act}" data-id="${c.id}">${label}</button>`;
  const controls = [];
  if (c.status === 'draft' && (mine || ME.user.role === 'admin')) controls.push(btn('submit', 'Submit for approval', 'primary'));
  if (c.status === 'pending_approval' && can('campaign.approve')) controls.push(mine ? '<span class="hint">You built this campaign, so someone else must approve it.</span>' : btn('approve', 'Approve', 'primary') + btn('reject', 'Send back'));
  if (c.status === 'approved' && can('campaign.control')) controls.push(btn('start', 'Start the campaign', 'primary'));
  if (c.status === 'running' && can('campaign.control')) controls.push(btn('pause', 'Pause'));
  if (c.status === 'paused' && can('campaign.control')) controls.push(btn('resume', 'Resume', 'primary'));
  if (['running', 'paused'].includes(c.status) && can('campaign.control')) controls.push(btn('complete', 'Mark completed'));
  if (!['completed', 'cancelled'].includes(c.status) && can('campaign.control')) controls.push(btn('cancel', 'Cancel campaign', 'danger'));
  const s = d.statuses, f = d.funnel, sum = d.import ? d.import.summary : {};
  const waiting = d.waiting.test_mode || d.waiting.template ? `<div class="banner warn">${d.waiting.test_mode ? `${fmt(d.waiting.test_mode)} customers are due but waiting for go-live (test mode). ` : ''}${d.waiting.template ? `${fmt(d.waiting.template)} are waiting for template approval: ${d.waiting.templates.map(esc).join(', ')}.` : ''}</div>` : '';
  return `<div class="row between"><h2>${esc(c.name)}</h2>${pill(c.status)}</div>
  <div class="steps">${steps}</div>
  ${c.note ? `<div class="banner warn">Sent back: ${esc(c.note)}</div>` : ''}${waiting}
  <section class="panel"><dl class="kv"><dt>Day 0</dt><dd>${dd(c.start_date)} (Bahrain)</dd><dt>From</dt><dd><a href="#/imports/${c.import_id}">${esc(d.import && d.import.file_name)}</a> · ${fmt(sum.send)} to message, ${fmt(sum.holdout)} holdout</dd>
    <dt>Built by</dt><dd>${esc(c.created_by_name)} · ${dt(c.created_at)}</dd><dt>Approved by</dt><dd>${c.approved_by_name ? esc(c.approved_by_name) + ' · ' + dt(c.approved_at) : '—'}</dd>
    <dt>Started</dt><dd>${dt(c.started_at)}</dd><dt>Template language</dt><dd class="mono">${esc(c.language)}</dd></dl>
    <div class="row">${controls.join('')}</div></section>
  ${c.status === 'draft' || c.status === 'pending_approval' || c.status === 'approved' ? '' : `
  <div class="tiles">${tile('In sequence', (s.active || 0) + (s.queued || 0), 'waiting or active', 'send')}${tile('With sales', (s.handover || 0) + (s.done || 0), 'handed over')}${tile('Opted out', s.optout || 0, '', 'hold')}${tile('No reply', s.quiet || 0, '3 unanswered')}${tile('Not delivered', s.failed || 0, '', 'bad')}${tile('Holdout', s.holdout || 0, 'never messaged', 'hold')}</div>
  <div class="grid2"><section class="panel"><h3>Templates sent</h3>${table([{ h: 'Status', html: r => pill(r[0]) }, { h: 'Messages', num: 1, v: r => fmt(r[1]) }], Object.entries(f), 'Nothing sent yet.')}
    <p class="hint">${fmt(d.replied)} customers have replied since the start.</p></section>
  <section class="panel"><h3>What went wrong</h3>${table([{ h: 'Outcome', v: r => r.outcome || 'unknown' }, { h: 'Messages', num: 1, v: r => fmt(r.n) }], d.failures, 'No failures.')}</section></div>
  <div class="row"><a class="btn" href="/api/campaigns/${c.id}/export/crm">CRM write-back CSV</a><a class="btn" href="#/results/${c.id}">Results: send vs holdout</a></div>`}`;
}

/* templates */
screens.templates = async () => {
  const d = await api('GET', '/api/templates');
  return `<div class="row between"><h2>WhatsApp templates</h2><div class="row">${can('templates.sync') ? '<button class="primary" data-act="sync">Sync from Meta</button>' : ''}<a class="btn" href="/api/templates/export">Export bodies to submit (CSV)</a></div></div>
  <p class="hint">WhatsApp only delivers a business-initiated message if it matches an approved template word for word, so bodies are fixed here. Only <b>Approved</b> templates are ever sent; pending, rejected, paused or unknown ones are refused. The Day 2 / 7 / 30 messages are <b>drafts</b> and Arabic versions are placeholders: both need wording signed off and Meta approval before use.</p>
  ${d.templates.map(t => `<section class="panel"><div class="row between"><div class="row"><b class="mono">${esc(t.name)}</b>${t.draft ? '<span class="pill test">DRAFT wording</span>' : ''}</div>
    <div class="row">English ${pill(t.status)} Arabic ${pill(t.arabicStatus)}</div></div>
    <pre class="tplbody">${esc(t.metaBody)}</pre><p class="hint">Variables: ${t.variables.map((v, i) => `{{${i + 1}}} = ${esc(v)}`).join(' · ') || 'none'}${t.reason ? ` · Meta reason: ${esc(t.reason)}` : ''} · synced ${dt(t.synced_at)}</p></section>`).join('')}`;
};

/* inbox */
screens.inbox = async id => {
  const list = await api('GET', '/api/inbox');
  let right = '<section class="panel"><p class="hint">Choose a customer on the left.</p></section>';
  if (id) {
    const item = list.find(x => String(x.id) === String(id));
    if (item) {
      const t = await api('GET', '/api/customers/' + encodeURIComponent(item.mobile));
      right = `<section class="panel"><div class="row between"><h3>${esc(item.customer_name || item.mobile)} · <span class="mono">${esc(item.mobile)}</span></h3><a class="btn" href="#/customers/${encodeURIComponent(item.mobile)}">Timeline</a></div>
        <p class="hint">${esc(item.brand || '')} ${esc(item.model || '')} · ${esc(item.campaign)} · ${esc(item.brief || '')}</p>
        ${thread(t.messages)}
        ${item.window_open ? `<form data-form="reply" data-id="${item.id}"><label class="f">Reply (free text is allowed until ${dt(item.window_closes_at)}, 24 hours after the customer's last message)<textarea name="body" maxlength="4096" required></textarea></label>
          <div class="row"><button class="primary" type="submit">Send reply</button><button type="button" data-act="resolve" data-id="${item.id}">Mark resolved</button></div></form>`
        : `<div class="banner warn">The 24-hour window is closed: the customer last wrote ${dt(item.last_inbound_at)}. WhatsApp only allows an approved template now, so call them instead.</div><div class="row"><button data-act="resolve" data-id="${item.id}">Mark resolved</button></div>`}
        ${ME.provider === 'mock' ? `<form data-form="simulate" data-mobile="${esc(item.mobile)}" class="row"><input type="text" name="text" placeholder="Mock only: type what the customer says" required><button type="submit">Simulate customer reply</button></form>` : ''}</section>`;
    }
  }
  return `<h2>Salesperson inbox</h2><p class="hint">Customers who wrote something the automation should not answer. Their sequence is paused; reply here or call them.</p>
  <div class="grid2"><section class="panel">${table([{ h: 'Customer', html: r => `<a href="#/inbox/${r.id}">${esc(r.customer_name || r.mobile)}</a>` }, { h: 'Said', v: r => (r.last_message || '').slice(0, 60) },
    { h: 'Salesperson', v: r => r.handover_user_name || r.sales || 'unassigned' }, { h: 'Window', html: r => r.window_open ? '<span class="pill live">open</span>' : '<span class="pill">closed</span>' }], list, 'Nobody is waiting.')}</section>${right}</div>`;
};
function thread(msgs) {
  return `<div class="thread">${msgs.length ? msgs.map(m => `<div class="bubble ${m.dir}${m.dir === 'out' && !m.automated ? ' person' : ''}">${esc(m.body || (m.tpl_name ? '[' + m.tpl_name + ']' : ''))}
    <span class="meta">${dt(m.created_at)} · ${m.dir === 'in' ? 'customer' : m.automated ? (m.tpl_name ? 'template ' + esc(m.tpl_name) : 'automatic reply') : esc(m.sent_by || 'staff')} · ${esc((STATUS[m.status] || [m.status])[0])}${m.outcome ? ' · ' + esc(m.outcome) : ''}</span></div>`).join('') : '<p class="hint">No messages yet.</p>'}</div>`;
}

/* customers */
screens.customers = async mobile => {
  if (mobile) return customerDetail(decodeURIComponent(mobile));
  return `<h2>Customers</h2><form class="panel row" data-form="search"><input type="search" name="q" placeholder="Mobile (3999 1001) or name" value="${esc(sessionStorage.getItem('q') || '')}"><button class="primary" type="submit">Search</button></form><div id="results"></div>`;
};
async function customerDetail(mobile) {
  const t = await api('GET', '/api/customers/' + encodeURIComponent(mobile)), c = t.customer || {};
  return `<div class="row between"><h2>${esc(c.name || t.mobile)} <span class="mono">${esc(t.mobile)}</span></h2><div class="row">
    ${t.optout ? `<span class="pill bad">Opted out ${dd(t.optout.at)} (${esc(t.optout.source)})</span>` : can('optout.add') ? '<button data-act="optout" data-mobile="' + esc(t.mobile) + '">Add to opt-out list</button>' : ''}
    ${t.suppressions.map(s => `<span class="pill bad">${esc(s.list === 'dnc' ? 'Do not contact' : 'Recent buyer')}</span>`).join('')}${t.allowlisted ? '<span class="pill test">On test allow-list</span>' : ''}</div></div>
  <div class="grid2"><section class="panel"><h3>Customer</h3><dl class="kv"><dt>Brand / model</dt><dd>${esc(c.brand || '—')} ${esc(c.model || '')}</dd><dt>Salesperson</dt><dd>${esc(c.sales || '—')}</dd>
    <dt>Last wrote to us</dt><dd>${dt(c.last_inbound_at)}</dd><dt>Last message from us</dt><dd>${dt(c.last_outbound_at)}</dd></dl>
    <h3>Campaigns</h3>${table([{ h: 'Campaign', v: r => r.campaign }, { h: 'Group', v: r => r.grp }, { h: 'Bucket', v: r => BUCKET[r.bucket] || r.bucket }, { h: 'Status', html: r => pill(r.status) }, { h: 'Brief', v: r => r.brief || '' }], t.enrollments, 'Not in a campaign.')}
    <h3>Imports</h3>${table([{ h: 'File', v: r => r.file_name }, { h: 'Group', v: r => r.grp }, { h: 'Reason given', v: r => r.reason }, { h: 'Excluded', v: r => r.ex_reason || '' }], t.imports, 'In no import.')}
    ${can('customer.erase') ? `<form data-form="erase" data-mobile="${esc(t.mobile)}" class="panel"><h3>Erase this customer</h3><p class="hint">Deletes their messages, campaign history and import rows. An opt-out or do-not-contact entry is kept, so they stay unmessageable. Cannot be undone.</p>
      <label class="f">Type the mobile to confirm<input type="text" name="confirm" autocomplete="off"></label><button class="danger" type="submit">Erase</button></form>` : ''}</section>
  <section class="panel"><h3>Timeline</h3>${thread(t.messages)}</section></div>`;
}

/* lists */
screens.lists = async () => {
  const [opt, dnc, rb, allow] = await Promise.all([api('GET', '/api/optouts'), api('GET', '/api/suppressions?list=dnc'), api('GET', '/api/suppressions?list=recent_buyer'), api('GET', '/api/allowlist')]);
  const listPanel = (key, title, rows, hint) => `<section class="panel"><h3>${title} · ${fmt(rows.length)}</h3><p class="hint">${hint}</p>
    ${can('suppression.edit') ? `<form data-form="suppress" data-list="${key}"><label class="f">Add mobiles (one per line)<textarea name="mobiles"></textarea></label><div class="row"><button type="submit">Add</button>
      <label class="btn">Import a file<input type="file" data-file="suppress-${key}" accept=".xlsx,.xls,.csv,.txt" hidden></label></div></form>` : ''}
    ${table([{ h: 'Mobile', html: r => `<a class="mono" href="#/customers/${encodeURIComponent(r.mobile)}">${esc(r.mobile)}</a>` }, { h: 'Added', v: r => dd(r.added_at) }, { h: 'Source', v: r => r.source || '' },
      { h: '', html: r => can('suppression.edit') ? `<button class="ghost" data-act="unsuppress" data-list="${key}" data-mobile="${esc(r.mobile)}">Remove</button>` : '' }], rows.slice(0, 200), 'Empty.')}</section>`;
  return `<h2>Opt-outs and do-not-contact lists</h2>
  <section class="panel"><div class="row between"><h3>Opt-outs · ${fmt(opt.length)}</h3><a class="btn" href="/api/optouts/export">Export CSV</a></div>
    <p class="hint">A STOP reply (English or Arabic), the Unsubscribe button, or Meta reporting the customer has turned off marketing messages adds the number here at once, across every campaign. Opt-outs are permanent: nothing in this system deletes one, not even erasing the customer.</p>
    <div class="row">${can('optout.add') ? '<form data-form="optout" class="row"><input type="text" name="mobile" placeholder="Mobile"><button type="submit">Add opt-out</button></form>' : ''}
    ${can('suppression.edit') ? '<label class="btn">Import a replies export or opt-out list<input type="file" data-file="optouts" accept=".xlsx,.xls,.csv,.txt" hidden></label>' : ''}</div>
    ${table([{ h: 'Mobile', html: r => `<a class="mono" href="#/customers/${encodeURIComponent(r.mobile)}">${esc(r.mobile)}</a>` }, { h: 'Since', v: r => dt(r.at) }, { h: 'How', v: r => r.source }], opt.slice(0, 200), 'Nobody has opted out.')}</section>
  <div class="grid2">${listPanel('dnc', 'Do not contact', dnc, 'Numbers the business must never message (complaints, staff, legal requests). Templates are refused for them.')}
  ${listPanel('recent_buyer', 'Recent buyers', rb, 'Import the latest sales / invoice export so someone who just bought is not chased as a lost lead.')}</div>
  <section class="panel"><h3>Test allow-list · ${fmt(allow.length)}</h3><p class="hint">In test mode only these numbers receive anything. Use IT and pilot staff phones registered as Meta test recipients.</p>
    ${can('settings.edit') ? '<form data-form="allow" class="row"><input type="text" name="mobile" placeholder="Mobile"><input type="text" name="note" placeholder="Whose phone"><button type="submit">Add</button></form>' : ''}
    ${table([{ h: 'Mobile', v: r => r.mobile }, { h: 'Note', v: r => r.note || '' }, { h: 'Added', v: r => dd(r.added_at) }, { h: '', html: r => can('settings.edit') ? `<button class="ghost" data-act="unallow" data-mobile="${esc(r.mobile)}">Remove</button>` : '' }], allow, 'Empty: in test mode nobody can receive anything.')}</section>`;
};

/* results */
screens.results = async id => {
  const camps = (await api('GET', '/api/campaigns')).filter(c => c.started_at);
  const files = await api('GET', '/api/outcomes');
  const win = Number(sessionStorage.getItem('window') || 60);
  const chosen = id || (camps[0] && camps[0].id);
  let body = '<p class="hint">Start a campaign first.</p>';
  if (chosen) {
    const r = await api('GET', `/api/campaigns/${chosen}/results?window=${win}`);
    body = !r.ready ? `<div class="tiles">${tile('Messaged', r.messaged.n, 'send group')}${tile('Holdout', r.holdout.n, 'sent nothing', 'hold')}</div><div class="banner warn">${esc(r.message)}</div>`
      : `<div class="tiles">${tile('Messaged', r.messaged.n, 'send group')}${tile('Holdout', r.holdout.n, 'deliberately sent nothing', 'hold')}${tile('Came back', r.messaged.conv + r.holdout.conv, 'matched in the outcome files')}${tile('Difference', pp(r.compare.diff), 'messaged minus holdout', 'send')}</div>
      ${table([{ h: 'Group', v: x => x[0] }, { h: 'Customers', num: 1, v: x => fmt(x[1].n) }, { h: 'Came back', num: 1, v: x => fmt(x[1].conv) }, { h: 'Rate', num: 1, v: x => pct(x[1].rate) }], [['Messaged', r.messaged], ['Holdout', r.holdout]])}
      <div class="verdict ${r.verdict.direction}"><b>${esc(r.verdict.headline.split('. ')[0])}.</b> ${esc(r.verdict.headline.split('. ').slice(1).join('. '))}<br>${esc(r.verdict.interval)}</div>
      <div class="notes">${r.notes.map(n => `<span class="${n.warn ? 'warn' : ''}">${esc(n.text)}</span>`).join('')}</div>`;
  }
  return `<h2>Results: did the messages make a difference?</h2>
  <section class="panel"><div class="row"><label class="f">Campaign<select data-change="pickCampaign">${camps.map(c => `<option value="${c.id}" ${String(c.id) === String(chosen) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label class="f">Days after Day 0<input type="number" min="1" max="365" value="${win}" data-change="window"></label></div>${body}</section>
  <section class="panel"><h3>Outcome files</h3><p class="hint">Any later export with mobile numbers — invoices, test drives, service jobs. A customer counts once, the first time they appear, if it is within the window.</p>
    ${can('results.edit') ? '<label class="btn">Add an outcome file<input type="file" data-file="outcome" accept=".xlsx,.xls,.csv,.txt" hidden></label>' : ''}
    ${table([{ h: 'File', v: f => f.source_file }, { h: 'Added', v: f => dt(f.added_at) }, { h: 'Mobiles', num: 1, v: f => fmt(f.mobiles) }, { h: '', html: f => can('results.edit') ? `<button class="ghost" data-act="dropOutcome" data-batch="${esc(f.batch_id)}">Remove</button>` : '' }], files, 'None yet.')}</section>`;
};

/* settings */
screens.settings = async () => {
  const [s, dl] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/dead-letters')]);
  const v = s.values, admin = can('settings.edit');
  const field = (k, type) => `<label class="f">${esc(s.describe[k].label)}<input type="${type}" name="${k}" value="${esc(v[k])}" ${admin ? '' : 'disabled'}></label>`;
  const box = k => `<label class="check"><input type="checkbox" name="${k}" ${v[k] ? 'checked' : ''} ${admin ? '' : 'disabled'}> ${esc(s.describe[k].label)}</label>`;
  return `<h2>Settings</h2>
  ${ME.halted ? `<div class="banner bad">Sending is halted: ${esc(ME.halted.label)} (${dt(ME.halted.at)}). ${can('deadletter.retry') ? '<button data-act="resumeSending">Resume sending</button>' : ''}</div>` : ''}
  <div class="grid2"><section class="panel"><h3>Go-live and safety</h3>
    <div class="banner ${v.go_live ? 'good' : 'warn'}">${v.go_live ? 'LIVE: customers in running campaigns can receive messages.' : 'TEST MODE: only allow-listed numbers can receive anything.'}</div>
    ${admin ? `<div class="row">${v.go_live ? '<button data-act="golive" data-on="0">Back to test mode</button>' : '<button class="primary" data-act="golive" data-on="1">Go live…</button>'}
      ${v.kill_switch ? '<button data-act="kill" data-on="0">Release kill switch</button>' : '<button class="danger" data-act="kill" data-on="1">Kill switch: stop all sending</button>'}</div>` : '<p class="hint">Only an admin changes these.</p>'}
    <h3>WhatsApp connection</h3><dl class="kv"><dt>Provider</dt><dd>${esc(s.provider)}</dd><dt>Graph API version</dt><dd class="mono">${esc(s.graphVersion)}</dd><dt>Phone number ID</dt><dd class="mono">${esc(s.phoneNumberId || '—')}</dd>
      <dt>WhatsApp Business account ID</dt><dd class="mono">${esc(s.wabaId || '—')}</dd><dt>Webhook URL</dt><dd class="mono">${esc((s.publicUrl || location.origin) + s.webhookPath)}</dd></dl>
    ${admin ? '<div class="row"><button data-act="testConn">Test WhatsApp connection</button><span id="connResult" class="hint"></span></div>' : ''}
    <p class="hint">Credentials are set by IT in the server environment (docs/INTEGRATION.md), never on this screen.</p></section>
  <form class="panel" data-form="settings"><h3>Sending rules</h3>
    <div class="grid2">${field('daily_cap', 'number')}${field('max_per_second', 'number')}${field('send_time', 'time')}${field('quiet_start', 'time')}${field('quiet_end', 'time')}${field('max_attempts', 'number')}
    ${field('holdout_pct', 'number')}${field('holdout_key', 'number')}${field('consent_from', 'date')}${field('recent_days', 'number')}${field('template_language', 'text')}</div>
    ${box('friday_skip')}
    <p class="hint">Changing the holdout % or key mid-pilot moves customers between groups and spoils the comparison.</p>
    ${admin ? '<div class="row"><button class="primary" type="submit">Save</button></div>' : ''}</form></div>
  <section class="panel"><h3>Dead letters · ${fmt(dl.length)}</h3><p class="hint">Messages that kept failing for temporary reasons, or were interrupted mid-send. Check the customer's timeline before retrying.</p>
    ${table([{ h: 'When', v: r => dt(r.created_at) }, { h: 'Mobile', html: r => `<a class="mono" href="#/customers/${encodeURIComponent(r.mobile)}">${esc(r.mobile)}</a>` }, { h: 'What', v: r => r.tpl_name || r.kind }, { h: 'Why', v: r => r.reason },
      { h: '', html: r => can('deadletter.retry') ? `<button data-act="dl" data-do="retry" data-id="${r.id}">Retry</button> <button class="ghost" data-act="dl" data-do="discard" data-id="${r.id}">Discard</button>` : '' }], dl, 'None.')}</section>`;
};

screens.audit = async () => {
  const rows = await api('GET', '/api/audit?limit=300');
  return `<h2>Audit log</h2><p class="hint">Every action by a person or the system. Mobiles are masked.</p>
  ${table([{ h: 'When', v: r => dt(r.at) }, { h: 'Who', v: r => r.user_email }, { h: 'Action', html: r => `<span class="mono">${esc(r.action)}</span>` }, { h: 'Target', v: r => r.target || '' }, { h: 'Detail', html: r => `<span class="mono">${esc(r.detail ? JSON.stringify(r.detail) : '')}</span>` }], rows)}`;
};

screens.users = async () => {
  const users = await api('GET', '/api/users');
  const admin = can('users.manage');
  return `<h2>Users</h2><p class="hint">Admin: everything. Marketing: import, build and approve campaigns (not their own), lists, results. Sales: inbox and replies. Viewer: read only. A salesperson's inbox is matched on their name as it appears in the CRM export.</p>
  ${table([{ h: 'Name', v: u => u.name }, { h: 'Email', v: u => u.email }, { h: 'Role', html: u => admin && u.id !== ME.user.id ? `<select data-change="role" data-id="${u.id}">${['admin', 'marketing', 'sales', 'viewer'].map(r => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(u.role) },
    { h: 'Active', html: u => admin && u.id !== ME.user.id ? `<button class="ghost" data-act="toggleUser" data-id="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : (u.active ? 'yes' : 'no') }], users)}
  ${admin ? `<form class="panel" data-form="newUser"><h3>Add a user</h3><div class="grid3"><label class="f">Name (as in the CRM for sales)<input type="text" name="name" required></label><label class="f">Email<input type="email" name="email" required></label>
    <label class="f">Role<select name="role"><option>sales</option><option>marketing</option><option>viewer</option><option>admin</option></select></label><label class="f">Temporary password (12+ characters)<input type="password" name="password" minlength="12" required autocomplete="new-password"></label></div>
    <div class="row"><button class="primary" type="submit">Create user</button></div></form>` : ''}`;
};

/* ---------- actions ---------- */
async function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
const acts = {
  logout: async () => { await api('POST', '/api/logout'); ME = null; showLogin(); },
  kill: async el => { const on = el.dataset.on === '1'; if (on && !confirm('Stop all sending now?')) return; await api('POST', '/api/system/kill', { on }); toast(on ? 'Kill switch on. Nothing will be sent.' : 'Kill switch released.'); render(); },
  golive: async el => {
    const on = el.dataset.on === '1';
    if (on && prompt('Going live lets running campaigns message real customers. Type GO LIVE to confirm.') !== 'GO LIVE') return;
    await api('PUT', '/api/settings', { go_live: on }); toast(on ? 'Live.' : 'Back in test mode.'); render();
  },
  sample: async () => { const r = await api('POST', '/api/imports/sample'); go('#/imports/' + r.importId); },
  clearUpload: async () => { UPLOAD = null; render(); },
  camp: async el => {
    const a = el.dataset.do; let note;
    if (a === 'cancel' && !confirm('Cancel this campaign? Queued messages are dropped.')) return;
    if (a === 'start' && !confirm('Start the campaign? Messages go out from Day 0 at the send time' + (ME.goLive ? '.' : ' (test mode: allow-listed numbers only).'))) return;
    if (a === 'reject') { note = prompt('What needs changing?'); if (note == null) return; }
    await api('POST', `/api/campaigns/${el.dataset.id}/${a}`, { note }); toast('Done.'); render();
  },
  sync: async () => { const r = await api('POST', '/api/templates/sync'); toast(`Synced ${r.total} templates, ${r.approved} approved.`); render(); },
  resolve: async el => { const note = prompt('Outcome (optional, e.g. "booked a test drive")') ; if (note === null) return; await api('POST', `/api/inbox/${el.dataset.id}/resolve`, { note }); toast('Resolved.'); go('#/inbox'); },
  optout: async el => { if (!confirm('Add to the opt-out list? This cannot be undone.')) return; await api('POST', '/api/optouts', { mobile: el.dataset.mobile }); render(); },
  unsuppress: async el => { await api('DELETE', `/api/suppressions/${el.dataset.list}/${encodeURIComponent(el.dataset.mobile)}`); render(); },
  unallow: async el => { await api('DELETE', `/api/allowlist/${encodeURIComponent(el.dataset.mobile)}`); render(); },
  dropOutcome: async el => { await api('DELETE', `/api/outcomes/${encodeURIComponent(el.dataset.batch)}`); render(); },
  testConn: async () => { const out = $('#connResult'); out.textContent = 'Testing…'; const r = await api('POST', '/api/settings/test-connection'); out.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail; out.className = r.ok ? 'hint' : 'hint banner bad'; },
  resumeSending: async () => { await api('POST', '/api/system/resume-sending'); toast('Sending resumed.'); render(); },
  dl: async el => { await api('POST', `/api/dead-letters/${el.dataset.id}/${el.dataset.do}`); render(); },
  toggleUser: async el => { await api('PATCH', `/api/users/${el.dataset.id}`, { active: el.dataset.on === '1' }); render(); }
};
const forms = {
  login: async f => { try { await api('POST', '/api/login', { email: f.email.value, password: f.password.value }); render(); } catch (e) { showLogin(e.message); } },
  runImport: async f => {
    const map = {}; UPLOAD.fields.forEach(x => { if (f[x.key].value) map[x.key] = f[x.key].value; });
    const r = await api('POST', '/api/imports', { uploadId: UPLOAD.uploadId, map }); UPLOAD = null; go('#/imports/' + r.importId);
  },
  buildCampaign: async f => { const c = await api('POST', '/api/campaigns', { importId: Number(f.dataset.import), name: f.name.value, startDate: f.startDate.value }); go('#/campaigns/' + c.id); },
  reply: async f => { await api('POST', `/api/inbox/${f.dataset.id}/reply`, { body: f.body.value }); toast('Queued. It goes out within a few seconds.'); setTimeout(render, 2500); },
  simulate: async f => { await api('POST', '/api/dev/simulate-reply', { mobile: f.dataset.mobile, text: f.text.value }); render(); },
  search: async f => {
    sessionStorage.setItem('q', f.q.value);
    const rows = await api('GET', '/api/customers?q=' + encodeURIComponent(f.q.value));
    $('#results').innerHTML = table([{ h: 'Mobile', html: r => `<a class="mono" href="#/customers/${encodeURIComponent(r.mobile)}">${esc(r.mobile)}</a>` }, { h: 'Name', v: r => r.name }, { h: 'Brand', v: r => r.brand }, { h: 'Model', v: r => r.model }, { h: 'Salesperson', v: r => r.sales }], rows, 'No match.');
  },
  erase: async f => { await api('POST', `/api/customers/${encodeURIComponent(f.dataset.mobile)}/erase`, { confirm: f.confirm.value }); toast('Erased. The opt-out (if any) is kept.'); go('#/customers'); },
  optout: async f => { if (!confirm('Add to the opt-out list? This cannot be undone.')) return; await api('POST', '/api/optouts', { mobile: f.mobile.value }); render(); },
  suppress: async f => { const r = await api('POST', '/api/suppressions', { list: f.dataset.list, mobiles: f.mobiles.value.split(/[\s,;]+/).filter(Boolean) }); toast(`${r.added} added${r.invalid ? `, ${r.invalid} not valid Bahrain mobiles` : ''}.`); render(); },
  allow: async f => { await api('POST', '/api/allowlist', { mobile: f.mobile.value, note: f.note.value }); render(); },
  settings: async f => {
    const body = {};
    f.querySelectorAll('input[name]').forEach(i => { body[i.name] = i.type === 'checkbox' ? i.checked : i.value; });
    await api('PUT', '/api/settings', body); toast('Saved.'); render();
  },
  newUser: async f => { await api('POST', '/api/users', { name: f.name.value, email: f.email.value, role: f.role.value, password: f.password.value }); toast('User created.'); render(); }
};
const changes = {
  pickCampaign: el => go('#/results/' + el.value),
  window: el => { sessionStorage.setItem('window', el.value); render(); },
  role: async el => { await api('PATCH', `/api/users/${el.dataset.id}`, { role: el.value }); toast('Role changed.'); }
};
async function onFile(kind, file) {
  try {
    const u = await uploadFile(file);
    if (kind === 'main') { UPLOAD = u; return render(); }
    if (kind === 'optouts') { const r = await api('POST', '/api/optouts/import', { uploadId: u.uploadId }); toast(`${r.added} opt-outs added${r.outbound ? `, ${r.outbound} of our own outgoing rows ignored` : ''}${r.noText ? ' (no message column: every number taken as an opt-out)' : ''}.`); return render(); }
    if (kind.startsWith('suppress-')) { const r = await api('POST', '/api/suppressions/import', { uploadId: u.uploadId, list: kind.slice(9) }); toast(`${r.added} numbers added.`); return render(); }
    if (kind === 'outcome') { const r = await api('POST', '/api/outcomes/import', { uploadId: u.uploadId }); toast(`${r.mobiles} mobiles read from ${r.rows} rows.`); return render(); }
  } catch (e) { toast(e.message, true); }
}

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  ev.preventDefault();
  try { el.disabled = true; await acts[el.dataset.act](el, ev); } catch (e) { toast(e.message, true); } finally { el.disabled = false; }
});
document.addEventListener('submit', async ev => {
  const f = ev.target.closest('form[data-form]'); if (!f) return;
  ev.preventDefault();
  const b = f.querySelector('button[type=submit]');
  try { if (b) b.disabled = true; await forms[f.dataset.form](f); } catch (e) { toast(e.message, true); } finally { if (b) b.disabled = false; }
});
document.addEventListener('change', async ev => {
  const el = ev.target;
  if (el.dataset && el.dataset.file && el.files && el.files[0]) { const f = el.files[0]; el.value = ''; return onFile(el.dataset.file, f); }
  if (el.dataset && el.dataset.change) { try { await changes[el.dataset.change](el); } catch (e) { toast(e.message, true); } }
});
document.addEventListener('dragover', ev => { const d = ev.target.closest('[data-drop]'); if (d) { ev.preventDefault(); d.classList.add('over'); } });
document.addEventListener('dragleave', ev => { const d = ev.target.closest('[data-drop]'); if (d) d.classList.remove('over'); });
document.addEventListener('drop', ev => { const d = ev.target.closest('[data-drop]'); if (!d) return; ev.preventDefault(); d.classList.remove('over'); if (ev.dataTransfer.files[0]) onFile(d.dataset.drop, ev.dataTransfer.files[0]); });

/* ---------- router ---------- */
async function render() {
  try {
    await shell();
    const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
    const fn = screens[name] || screens[''];
    main.innerHTML = await fn(arg);
    bars();
    if (name === 'customers' && !arg && sessionStorage.getItem('q')) { const f = main.querySelector('form[data-form=search]'); if (f) forms.search(f); }
  } catch (e) {
    if (e.message === 'Please sign in') return;
    main.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
render();
})();
