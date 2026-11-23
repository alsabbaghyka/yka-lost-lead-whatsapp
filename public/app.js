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
const MODE = { mock: ['Practice mode', 'Nothing reaches a real phone. Deliveries, reads and replies are pretended, so you can safely try every step.'],
  'dry-run': ['Dry run', 'Messages are only written down here, never sent.'], cloud: ['Connected to WhatsApp', "Messages go to real phones through Meta's WhatsApp Cloud API."] };
const TPL_LABEL = { ask: 'Ask why they did not buy', permission: 'Ask permission to message', price: 'Price or finance', stock: 'Stock arriving', thinking: 'Still thinking', competitor: 'Bought elsewhere: after-sales offer', features: 'Other models', family: 'Family test drive', nudge: 'Day 2 reminder', voucher: 'Day 7 voucher', monthly: 'Monthly news' };
const names = list => list.length ? list.map(u => u.name).join(', ') : 'nobody yet: add a marketing user on the Users screen';
const plural = (n, w) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;
function themeButtons() {
  let t = 'light'; try { t = localStorage.getItem('theme') || 'light'; } catch { /* storage blocked */ }
  document.querySelectorAll('[data-act=theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
}
function bars() { main.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; }); }

/* ---------- shell ---------- */
const NAV = [['start', 'Start here'], ['', 'Dashboard'], ['import', 'Upload file'], ['campaigns', 'Campaigns'], ['inbox', 'Inbox'], ['customers', 'Customers'], ['connect', 'Connect WhatsApp'], ['templates', 'Templates'], ['lists', 'Opt-outs & lists'], ['results', 'Results'], ['settings', 'Settings'], ['audit', 'Audit log', 'audit.view'], ['users', 'Users']];
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
    (ME.goLive ? '<span class="pill live">LIVE · customers receive messages</span>' : '<span class="pill test">TEST MODE · only test phones receive messages</span>') +
    `<a class="pill steel" href="#/connect" title="${esc(MODE[ME.provider][1])}">${esc(MODE[ME.provider][0])}</a>`;
}
function showLogin(msg) {
  $('#nav').hidden = true; $('#strip').hidden = true;
  main.innerHTML = `<form class="panel login" data-form="login"><h2>Sign in</h2>
    ${msg ? `<div class="banner bad">${esc(msg)}</div>` : ''}
    <label class="f">Email<input type="email" name="email" autocomplete="username" required></label>
    <label class="f">Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">Sign in</button>
    <p class="hint">No account? Ask an admin: users are added on the Users screen.</p></form>
    <section class="panel login"><h3>What this is</h3><p class="hint">It messages customers whose car sale was lost in the CRM, on WhatsApp, with a message that fits the reason, and passes every reply to their salesperson. After signing in, <b>Start here</b> walks you through it.</p></section>`;
}

/* ---------- screens ---------- */
const screens = {};

screens[''] = async () => {
  const [d, g] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/guide')]);
  const st = guideSteps(g), nx = st.find(x => !x.done && !x.soft);
  const banners = [nx ? `<div class="next"><b class="h">Your next step</b>${esc(nx.t)}: ${nx.what} <a class="btn primary" href="${nx.go[0]}">${esc(nx.go[1])}</a> <a class="btn" href="#/start">See all steps</a></div>` : ''];
  if (d.killSwitch) banners.push(`<div class="banner bad">The kill switch is on. Nothing is being sent to anyone.</div>`);
  if (d.halted) banners.push(`<div class="banner bad">Sending stopped itself after an account-level error from Meta: ${esc(d.halted.label)}. Fix it, then resume from Settings.</div>`);
  if (!d.goLive) banners.push(`<div class="banner warn">Test mode: only the test phones (Connect WhatsApp) receive anything. Customers in running campaigns wait until an admin turns on Go live.</div>`);
  if (d.provider !== 'cloud') banners.push(`<div class="banner steel">${esc(MODE[d.provider][0])}: ${esc(MODE[d.provider][1])} <a href="#/connect">How to connect WhatsApp</a></div>`);
  if (!d.approvedTemplates) banners.push(`<div class="banner warn">No approved templates are known. Sync them on the Templates screen.</div>`);
  return `${banners.join('')}
  <div class="tiles">
    ${tile('Sent today', `${fmt(d.sentToday)} / ${fmt(d.dailyCap)}`, 'templates against the daily cap', 'send')}
    ${tile('Queued', d.queued, 'waiting in the outbox')}
    ${tile('Inbox', d.inbox, 'customers with a salesperson', d.inbox ? 'good' : '')}
    ${tile('Opted out', d.optouts, 'never messaged again', 'hold')}
    ${tile('Failed messages', d.deadLetters, 'gave up after retries', d.deadLetters ? 'bad' : '')}
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
      <p class="hint">A campaign is approved by someone other than the person who built it. Who can approve: ${esc(names(g.approvers))}.</p>
    </section>
  </div>
  <section class="panel"><h3>Latest messages</h3>
  ${table([{ h: 'When', v: r => dt(r.created_at) }, { h: 'Mobile', html: r => `<a href="#/customers/${encodeURIComponent(r.mobile)}" class="mono">${esc(r.mobile)}</a>` }, { h: 'Direction', v: r => r.dir === 'in' ? 'From customer' : 'To customer' },
    { h: 'Kind', v: r => r.kind }, { h: 'Status', html: r => pill(r.status) }, { h: 'Outcome', v: r => r.outcome || '' }], d.recent, 'No messages yet.')}</section>`;
};

/* start here */
function guideSteps(g) {
  const c = g.campaigns, n = (...ks) => ks.reduce((a, k) => a + (c[k] || 0), 0);
  return [
    { done: g.provider === 'cloud', soft: g.provider !== 'cloud', t: 'Connect WhatsApp', who: 'IT, once',
      what: g.provider === 'cloud' ? "Connected to Meta's WhatsApp Cloud API." : `Not connected yet: the system is in <b>${esc(MODE[g.provider][0].toLowerCase())}</b>. You can still try every step below; nothing reaches a real phone until IT connects it.`, go: ['#/connect', 'Connect WhatsApp'] },
    { done: g.approvedTemplates > 0, t: 'Get the messages approved by Meta', who: 'Marketing and IT',
      what: `WhatsApp only lets a business start a chat with a message Meta has approved word for word. ${fmt(g.approvedTemplates)} of ${fmt(g.totalTemplates)} approved.`, go: ['#/templates', 'See the messages'] },
    { done: g.allowlist > 0, t: 'Add your test phones', who: 'Admin',
      what: `While test mode is on, only these phones receive anything. ${plural(g.allowlist, 'phone')} added.`, go: ['#/connect', 'Add test phones'] },
    { done: g.imports > 0, t: 'Upload the CRM lost-sales file', who: 'Marketing',
      what: 'The system reads each lost lead, picks the right message from the reason, and leaves out open deals, wrong numbers and opt-outs.', go: ['#/import', 'Upload a file'] },
    { done: n('pending_approval', 'approved', 'running', 'paused', 'completed') > 0, t: 'Build a campaign and send it for approval', who: 'Marketing',
      what: 'Open the uploaded file, choose the date the first message goes out, and press Create and send for approval.', go: ['#/import', 'Open the file'] },
    { done: n('approved', 'running', 'paused', 'completed') > 0, t: 'A second person approves it', who: 'Admin or marketing, not the builder',
      what: `Someone other than the builder checks and approves it. Who can approve: <b>${esc(names(g.approvers))}</b>.`, go: ['#/campaigns', 'Campaigns'] },
    { done: n('running', 'paused', 'completed') > 0, t: 'Start the campaign', who: 'Admin or marketing',
      what: `Press Start sending on the approved campaign. Messages go out at ${esc(g.sendTime)} Bahrain time on the first-message date.`, go: ['#/campaigns', 'Campaigns'] },
    { done: g.goLive, t: 'Go live', who: 'Admin',
      what: 'When the test phones received the right messages, an admin turns on Go live in Settings. From then on real customers receive them.', go: ['#/settings', 'Settings'] }
  ];
}
screens.start = async () => {
  const g = await api('GET', '/api/guide');
  const st = guideSteps(g), next = st.findIndex(x => !x.done && !x.soft);
  return `<h2>Start here</h2><p class="hint">Eight steps from a CRM file to messages on customers' phones. The ticks fill in by themselves as you go.</p>
  <ol class="guide">${st.map((x, i) => `<li class="${x.done ? 'done' : i === next ? 'now' : ''}"><span class="num">${x.done ? '✓' : i + 1}</span><div>
    <div class="row between"><b class="t">${esc(x.t)}</b><span class="row">${x.soft ? `<span class="pill steel">${esc(MODE[g.provider][0])}</span>` : ''}<span class="pill">${esc(x.who)}</span></span></div>
    <p>${x.what}</p>${i === next || x.soft ? `<a class="btn ${i === next ? 'primary' : ''}" href="${x.go[0]}">${esc(x.go[1])}</a>` : ''}</div></li>`).join('')}</ol>
  <div class="grid2"><section class="panel"><h3>What a customer receives</h3>
    <dl class="timeline"><dt>Day 0</dt><dd>The <b>first-message date</b> you pick for the campaign, at ${esc(g.sendTime)}. The message matches the reason the sale was lost (price, stock, still thinking…), or asks why if no reason was written. Leads older than the permission date get a short "may we message you?" first.</dd>
    <dt>Day 2</dt><dd>A short reminder, only if they have not replied.</dd><dt>Day 7</dt><dd>A test-drive voucher, only if still no reply.</dd><dt>Day 30</dt><dd>Monthly news, then once a month.</dd></dl>
    <p class="hint">It stops at once when the customer replies (the reply goes to their salesperson's Inbox), writes STOP or presses Unsubscribe. Nothing is sent ${g.fridaySkip ? 'on Fridays or ' : ''}between ${esc(g.quietStart)} and ${esc(g.quietEnd)}. The Day 2, 7 and 30 messages are still drafts waiting for sign-off.</p>
    <p class="hint"><b>Holdout:</b> a small share of customers is deliberately not messaged, so Results can show whether the messages made a difference.</p></section>
  <section class="panel"><h3>Who does what</h3>${table([{ h: 'Role', v: r => r[0] }, { h: 'Can', v: r => r[1] }], [
    ['Admin', 'Everything: test phones, Go live, kill switch, users and settings.'],
    ['Marketing', 'Upload files, build campaigns, approve campaigns built by someone else, start and pause them, results.'],
    ['Sales', 'Answer their customers in the Inbox.'], ['Viewer', 'Look only.']])}
    <p class="hint">You are signed in as <b>${esc(ME.user.role)}</b>.</p></section></div>`;
};

/* connect whatsapp */
screens.connect = async () => {
  const [g, allow, tpls] = await Promise.all([api('GET', '/api/guide'), api('GET', '/api/allowlist'), api('GET', '/api/templates')]);
  const admin = can('settings.edit'), m = MODE[g.provider], cloud = g.provider === 'cloud';
  const approved = tpls.templates.filter(t => t.status === 'APPROVED' && !t.draft);
  const ok = b => b ? '<span class="pill live">set</span>' : '<span class="pill bad">not set</span>';
  const hook = (g.webhookUrl.startsWith('http') ? '' : location.origin) + g.webhookUrl;
  const phones = allow.map(a => `<option value="${esc(a.mobile)}">${esc(a.mobile)}${a.note ? ' · ' + esc(a.note) : ''}</option>`).join('');
  return `<h2>Connect WhatsApp</h2>
  <div class="banner ${cloud ? 'good' : 'steel'}"><b>${esc(m[0])}.</b> ${esc(m[1])}</div>
  <div class="grid2"><section class="panel"><h3>1 · Test phones</h3>
    <p class="hint">In test mode only these phones receive anything. Add your own and a colleague's. With Meta's free test number, each phone must also be added as a recipient in Meta (WhatsApp → API Setup → "To").</p>
    ${admin ? '<form data-form="allow" class="row"><input type="text" name="mobile" placeholder="Mobile, e.g. 3999 1001" required><input type="text" name="note" placeholder="Whose phone"><button class="primary" type="submit">Add test phone</button></form>' : '<p class="hint">Only an admin adds test phones.</p>'}
    ${table([{ h: 'Mobile', v: r => r.mobile }, { h: 'Whose', v: r => r.note || '' }, { h: '', html: r => admin ? `<button class="ghost" data-act="unallow" data-mobile="${esc(r.mobile)}">Remove</button>` : '' }], allow, 'No test phones yet.')}</section>
  <section class="panel"><h3>2 · Send a test message now</h3>
    ${!admin ? '<p class="hint">Only an admin can send a test message.</p>' : !allow.length ? '<p class="hint">Add a test phone first.</p>' : !approved.length ? '<div class="banner warn">No message is approved by Meta yet. Sync the messages on the Templates screen once Meta has approved them.</div>' :
      `<form data-form="testMessage" class="grid2"><label class="f">To<select name="mobile">${phones}</select></label>
      <label class="f">Message<select name="template">${approved.map(t => `<option value="${esc(t.name)}" ${t.key === 'ask' ? 'selected' : ''}>${esc(TPL_LABEL[t.key] || t.key)} · ${esc(t.name)}</option>`).join('')}</select></label>
      <div class="row"><button class="primary" type="submit">Send test message</button></div></form><div id="testResult"></div>`}
    <p class="hint">Goes out at once (quiet hours do not apply) and fills the customer name with "Test". ${cloud ? 'It arrives on the phone within a few seconds.' : 'In ' + esc(m[0].toLowerCase()) + ' it is only pretended: check it on the phone\'s timeline in Customers.'}</p>
    ${g.provider === 'mock' && allow.length ? `<h3>Pretend the customer replied</h3><p class="hint">Practice mode only. Try "1" (price), "STOP", or a question, and see where it goes.</p>
      <form data-form="simulate" class="row" data-pick="1"><select name="mobile">${phones}</select><input type="text" name="text" placeholder="What the customer writes" required><button type="submit">Pretend reply</button></form>` : ''}
    <p class="hint">To test a whole campaign, the test phone must also be in the uploaded file: add a row with your own mobile to a copy of the CRM export.</p></section></div>
  <section class="panel"><h3>3 · Connect the real WhatsApp (for IT, once)</h3>
    <ol class="howto">
      <li>In <b>Meta Business Suite</b> (business.facebook.com), use the Y.K. Almoayyed business and create a <b>WhatsApp Business account</b>. Add the phone number customers will see. It must not be in use on the WhatsApp app. To try first, Meta gives a free <b>test number</b> that can message up to 5 phones.</li>
      <li>At <b>developers.facebook.com</b>, create an app of type <b>Business</b> and add the <b>WhatsApp</b> product. On WhatsApp → API Setup, copy the <b>Phone number ID</b> and the <b>WhatsApp Business Account ID</b>.</li>
      <li>In Business Settings → Users → <b>System users</b>, create one and generate a <b>permanent token</b> with the permissions <span class="mono">whatsapp_business_messaging</span> and <span class="mono">whatsapp_business_management</span>.</li>
      <li>In the app's Settings → Basic, copy the <b>App secret</b>. Invent a long random <b>verify token</b> (any text, kept private).</li>
      <li>In <b>Vercel</b> → this project → Settings → Environment Variables, set the values below, then <b>Redeploy</b>.</li>
      <li>In the Meta app → WhatsApp → <b>Configuration</b>, set the Callback URL to <span class="mono">${esc(hook)}</span> and the same verify token, then subscribe to <span class="mono">messages</span> and <span class="mono">message_template_status_update</span>. Meta must be able to reach this address: Vercel Authentication (Deployment Protection) blocks it, so IT turns that off for production or moves the app to a company server.</li>
      <li>Back here: press <b>Test connection</b>, then sync the messages on the Templates screen, then send a test message to your phone (step 2).</li>
      <li>Submit the message wording to Meta for approval (Templates → Export bodies to submit). Meta usually answers within a day.</li></ol>
    ${table([{ h: 'Environment variable', html: r => `<span class="mono">${r[0]}</span>` }, { h: 'What it is', v: r => r[1] }, { h: 'Now', html: r => r[2] }], [
      ['WA_PROVIDER', 'cloud to send for real (now: ' + g.provider + ')', cloud ? '<span class="pill live">cloud</span>' : `<span class="pill">${esc(g.provider)}</span>`],
      ['WA_ACCESS_TOKEN', 'the permanent system-user token', ok(g.connection.WA_ACCESS_TOKEN)], ['WA_PHONE_NUMBER_ID', 'Phone number ID', ok(g.connection.WA_PHONE_NUMBER_ID)],
      ['WA_WABA_ID', 'WhatsApp Business Account ID', ok(g.connection.WA_WABA_ID)], ['WA_APP_SECRET', 'App secret (checks that webhooks really come from Meta)', ok(g.connection.WA_APP_SECRET)],
      ['WA_VERIFY_TOKEN', 'the verify token you invented', ok(g.connection.WA_VERIFY_TOKEN)], ['PUBLIC_URL', 'this site\'s address, e.g. ' + location.origin, ok(g.connection.PUBLIC_URL)]])}
    ${admin ? '<div class="row"><button data-act="testConn">Test connection</button><span id="connResult" class="hint"></span></div>' : ''}
    <p class="hint">The token and secret are typed only into Vercel, never on this screen or in an email. Details for IT: docs/INTEGRATION.md and docs/GO-LIVE-CHECKLIST.md in the code.</p></section>`;
};

/* import */
let UPLOAD = null;
screens.import = async () => {
  const imps = await api('GET', '/api/imports');
  const map = UPLOAD ? `<section class="panel"><h3>2 · Check the columns</h3>
    <p class="hint">${esc(UPLOAD.fileName)} · ${fmt(UPLOAD.rowCount)} rows${UPLOAD.headerless ? ' · no header row found, so columns were matched from their contents' : ''}. Mobile and loss reason are required.</p>
    <form data-form="runImport" class="grid3">${UPLOAD.fields.map(f => `<label class="f">${esc(f.label)}${f.req ? ' *' : ''}<select name="${esc(f.key)}"><option value="">— not in file —</option>${(UPLOAD.map[f.key] && !UPLOAD.headers.includes(UPLOAD.map[f.key]) ? [UPLOAD.map[f.key]] : []).concat(UPLOAD.headers).map(h => `<option ${UPLOAD.map[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`).join('')}
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
  const [p, g] = await Promise.all([api('GET', '/api/imports/' + id), api('GET', '/api/guide')]);
  const others = g.approvers.filter(u => u.id !== ME.user.id);
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
  ${can('campaign.build') ? `<form class="panel" data-form="buildCampaign" data-import="${id}"><h3>Build a campaign from this file</h3>
    <div class="steps"><span class="now">1 You build it</span><span>2 ${esc(names(others))} approves</span><span>3 Someone presses Start sending</span><span>4 Messages go out</span></div>
    <div class="grid3"><label class="f">Campaign name<input type="text" name="name" value="${esc(p.import.file_name.replace(/\.\w+$/, ''))} — ${todayBH()}" required></label>
    <label class="f">First message goes out on<input type="date" name="startDate" min="${todayBH()}" value="${todayBH()}" required>
      <span class="fieldhint">This is "Day 0": the first WhatsApp goes at ${esc(g.sendTime)} Bahrain time that day. Reminders follow 2, 7 and 30 days later, only to people who have not replied.</span></label>
    <div class="row"><button class="primary" type="submit">Create and send for approval</button></div></div>
    <p class="hint">Nothing is sent yet. ${others.length ? esc(names(others)) + (others.length > 1 ? ' can' : ' must') + ' approve it' : 'Someone else must approve it, but nobody else can yet: add a marketing user on the Users screen'}. You cannot approve your own campaign.</p></form>` : ''}
  <section class="panel"><h3>Ready to message (first ${Math.min(p.send.length, 50)})</h3>
  ${table([{ h: 'Mobile', v: r => r.mobile }, { h: 'Customer', v: r => r.name }, { h: 'Brand', v: r => r.brand }, { h: 'Model', v: r => r.model }, { h: 'Bucket', v: r => BUCKET[r.bucket] || r.bucket },
    { h: 'Track', v: r => r.track === 'permission' ? 'Permission first' : 'Standard' }, { h: 'First message', html: r => `<span class="mono">${esc(r.tpl_name)}</span>` }, { h: 'Salesperson', v: r => r.sales }], p.send.slice(0, 50))}</section>`;
};

/* campaigns */
screens.campaigns = async id => {
  if (id) return campaignDetail(id);
  const list = await api('GET', '/api/campaigns');
  return `<div class="row between"><h2>Campaigns</h2><a class="btn" href="#/import">New: import a file</a></div>
  ${table([{ h: 'Campaign', html: r => `<a href="#/campaigns/${r.id}">${esc(r.name)}</a>` }, { h: 'Status', html: r => pill(r.status) }, { h: 'First message', v: r => dd(r.start_date) },
    { h: 'Built by', v: r => r.created_by_name }, { h: 'Approved by', v: r => r.approved_by_name || '—' }, { h: 'Customers', num: 1, v: r => fmt(r.enrolled) }], list, 'No campaigns yet. Import a file to build one.')}`;
};
async function campaignDetail(id) {
  const [d, g] = await Promise.all([api('GET', '/api/campaigns/' + id), api('GET', '/api/guide')]), c = d.campaign;
  const order = ['draft', 'pending_approval', 'approved', 'running', 'completed'];
  const LBL = ['1 Built', '2 Approved by a second person', '3 Ready to start', '4 Sending', '5 Finished'];
  const at = c.status === 'paused' ? 3 : order.indexOf(c.status);
  const steps = LBL.map((l, i) => `<span class="${i < at ? 'done' : i === at ? 'now' : ''}">${esc(i === 1 && at <= 1 ? '2 Waiting for a second person' : l)}</span>`).join('');
  const mine = c.created_by === ME.user.id;
  const others = g.approvers.filter(u => u.id !== c.created_by);
  const btn = (act, label, cls) => `<button class="${cls || ''}" data-act="camp" data-do="${act}" data-id="${c.id}">${label}</button>`;
  const controls = [];
  if (c.status === 'draft' && (mine || ME.user.role === 'admin')) controls.push(btn('submit', 'Send for approval', 'primary'));
  if (c.status === 'pending_approval' && can('campaign.approve') && !mine) controls.push(btn('approve', 'Approve', 'primary') + btn('reject', 'Send back with a note'));
  if (c.status === 'approved' && can('campaign.control')) controls.push(btn('start', 'Start sending', 'primary'));
  if (c.status === 'running' && can('campaign.control')) controls.push('<button class="primary" data-act="runDue">Send due messages now</button>' + btn('pause', 'Pause'));
  if (c.status === 'paused' && can('campaign.control')) controls.push(btn('resume', 'Resume', 'primary'));
  if (['running', 'paused'].includes(c.status) && can('campaign.control')) controls.push(btn('complete', 'Mark finished'));
  if (!['completed', 'cancelled'].includes(c.status) && can('campaign.control')) controls.push(btn('cancel', 'Cancel campaign', 'danger'));
  const nowBH = new Date().toLocaleTimeString('en-GB', { ...BH, hour: '2-digit', minute: '2-digit', hour12: false });
  const when = c.start_date === todayBH() && nowBH >= g.sendTime ? `today (${dd(c.start_date)}): it is already past ${esc(g.sendTime)}, so they go as soon as it starts, outside quiet hours` : c.start_date < todayBH() ? `${dd(c.start_date)} (already begun)` : `${dd(c.start_date)} at ${esc(g.sendTime)} Bahrain time`;
  const test = g.goLive ? '' : ` <b>Test mode is on:</b> ${g.allowlist === 1 ? 'only the 1 test phone receives' : 'only the ' + plural(g.allowlist, 'test phone') + ' receive'} anything; every other customer waits until an admin turns on Go live.`;
  const NEXT = {
    draft: mine || ME.user.role === 'admin' ? 'Not sent for approval yet. Press <b>Send for approval</b>.' : `${esc(c.created_by_name)} built it and still has to send it for approval.`,
    pending_approval: mine ? `Waiting for <b>${esc(names(others))}</b> to approve it. You cannot approve your own campaign: send them the link to this page.`
      : can('campaign.approve') ? 'Your turn: check the numbers and the file below (and the wording on the Templates screen), then press <b>Approve</b> or <b>Send back with a note</b>.' : `Waiting for ${esc(names(others))} to approve it.`,
    approved: `Approved by ${esc(c.approved_by_name)}. Press <b>Start sending</b>. The first messages go out on ${when}.${test}`,
    running: `Sending. First messages on ${when}; reminders 2, 7 and 30 days later to anyone who has not replied. The system sends due messages by itself; <b>Send due messages now</b> does it straight away.${test}`,
    paused: 'Paused: nothing goes out until someone presses <b>Resume</b>.',
    completed: 'Finished. Replies still reach the Inbox. See Results to compare messaged customers with the holdout.',
    cancelled: 'Cancelled. Nothing more is sent.'
  };
  const sum0 = d.import ? d.import.summary : {}, s = d.statuses, f = d.funnel;
  return `<div class="row between"><h2>${esc(c.name)}</h2>${pill(c.status)}</div>
  <div class="steps">${steps}</div>
  <div class="next"><b class="h">What happens now</b>${NEXT[c.status] || ''}<div class="row nextbtns">${controls.join('')}</div></div>
  ${c.note ? `<div class="banner warn">Sent back: ${esc(c.note)}</div>` : ''}
  ${d.waiting.test_mode || d.waiting.template ? `<div class="banner warn">${d.waiting.test_mode ? `${fmt(d.waiting.test_mode)} customers are due but waiting for Go live (test mode). ` : ''}${d.waiting.template ? `${fmt(d.waiting.template)} are waiting for Meta to approve: ${d.waiting.templates.map(esc).join(', ')}.` : ''}</div>` : ''}
  <section class="panel"><dl class="kv"><dt>First message (Day 0)</dt><dd>${when}</dd><dt>From file</dt><dd><a href="#/imports/${c.import_id}">${esc(d.import && d.import.file_name)}</a> · ${fmt(sum0.send)} to message, ${fmt(sum0.holdout)} holdout (not messaged, for comparison)</dd>
    <dt>Built by</dt><dd>${esc(c.created_by_name)} · ${dt(c.created_at)}</dd><dt>Approved by</dt><dd>${c.approved_by_name ? esc(c.approved_by_name) + ' · ' + dt(c.approved_at) : 'not yet · can approve: ' + esc(names(others))}</dd>
    <dt>Started</dt><dd>${dt(c.started_at)}</dd><dt>Message language</dt><dd class="mono">${esc(c.language)}</dd></dl></section>
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
    <h3>WhatsApp connection</h3><p class="hint"><a href="#/connect">Connect WhatsApp</a> has the step-by-step set-up, the test phones and a test message.</p><dl class="kv"><dt>Provider</dt><dd>${esc(s.provider)}</dd><dt>Graph API version</dt><dd class="mono">${esc(s.graphVersion)}</dd><dt>Phone number ID</dt><dd class="mono">${esc(s.phoneNumberId || '—')}</dd>
      <dt>WhatsApp Business account ID</dt><dd class="mono">${esc(s.wabaId || '—')}</dd><dt>Webhook URL</dt><dd class="mono">${esc((s.publicUrl || location.origin) + s.webhookPath)}</dd></dl>
    ${admin ? '<div class="row"><button data-act="testConn">Test WhatsApp connection</button><span id="connResult" class="hint"></span></div>' : ''}
    <p class="hint">Credentials are set by IT in the server environment (docs/INTEGRATION.md), never on this screen.</p></section>
  <form class="panel" data-form="settings"><h3>Sending rules</h3>
    <div class="grid2">${field('daily_cap', 'number')}${field('max_per_second', 'number')}${field('send_time', 'time')}${field('quiet_start', 'time')}${field('quiet_end', 'time')}${field('max_attempts', 'number')}
    ${field('holdout_pct', 'number')}${field('holdout_key', 'number')}${field('consent_from', 'date')}${field('recent_days', 'number')}${field('template_language', 'text')}${field('default_brand', 'text')}</div>
    ${box('friday_skip')}
    <p class="hint">Changing the holdout % or key mid-pilot moves customers between groups and spoils the comparison.</p>
    ${admin ? '<div class="row"><button class="primary" type="submit">Save</button></div>' : ''}</form></div>
  <section class="panel"><h3>Failed messages · ${fmt(dl.length)}</h3><p class="hint">Messages that kept failing for temporary reasons, or were interrupted mid-send. Check the customer's timeline before retrying.</p>
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
  theme: async el => { const t = el.dataset.t; try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t); themeButtons(); },
  runDue: async () => {
    const r = await api('POST', '/api/system/run-due');
    const WHY = { 'before the send time': 'it is before the daily send time (Settings)', 'quiet hours': 'it is quiet hours', Friday: 'it is Friday', 'kill switch': 'the kill switch is on', 'sending halted': 'sending is halted (Settings)', 'daily cap reached': 'the daily limit is reached' };
    const q = r.scheduler ? r.scheduler.enqueued : 0, sent = r.outbox ? r.outbox.sent : 0, why = r.scheduler && r.scheduler.skipped;
    toast(why && !sent ? `Nothing sent: ${WHY[why] || why}. It goes out by itself when that ends.` : `${plural(q, 'new message')} queued, ${plural(sent, 'message')} sent.`); render();
  },
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
    if (a === 'start' && !confirm('Start sending? Messages go out from the first-message date at the send time' + (ME.goLive ? ' to real customers.' : ' (test mode: only test phones receive them).'))) return;
    if (a === 'approve' && !confirm('Approve this campaign? Anyone with marketing or admin rights can then start it.')) return;
    if (a === 'reject') { note = prompt('What needs changing?'); if (note == null) return; }
    await api('POST', `/api/campaigns/${el.dataset.id}/${a}`, { note }); toast({ submit: 'Sent for approval.', approve: 'Approved.', reject: 'Sent back.', start: 'Started.', pause: 'Paused.', resume: 'Resumed.', complete: 'Finished.', cancel: 'Cancelled.' }[a] || 'Done.'); render();
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
  buildCampaign: async f => {
    const c = await api('POST', '/api/campaigns', { importId: Number(f.dataset.import), name: f.name.value, startDate: f.startDate.value });
    try { await api('POST', `/api/campaigns/${c.id}/submit`, {}); toast('Created and sent for approval.'); } catch (e) { toast('Created as a draft, not yet sent for approval: ' + e.message, true); }
    go('#/campaigns/' + c.id);
  },
  testMessage: async f => {
    const out = $('#testResult'); out.innerHTML = '<p class="hint">Sending…</p>';
    const r = await api('POST', '/api/test-message', { mobile: f.mobile.value, template: f.template.value });
    out.innerHTML = `<div class="banner ${['sent', 'delivered', 'read', 'accepted'].includes(r.status) ? 'good' : r.status === 'queued' || r.status === 'sending' ? 'steel' : 'bad'}">${esc((STATUS[r.status] || [r.status])[0])}${r.outcome ? ': ' + esc(r.outcome) : ''}.
      ${r.provider === 'cloud' ? 'Check the phone.' : 'Practice mode: no phone received it.'} <a href="#/customers/${encodeURIComponent(f.mobile.value)}">See the timeline</a></div>`;
  },
  reply: async f => { await api('POST', `/api/inbox/${f.dataset.id}/reply`, { body: f.body.value }); toast('Queued. It goes out within a few seconds.'); setTimeout(render, 2500); },
  simulate: async f => { const mobile = f.dataset.mobile || f.mobile.value; await api('POST', '/api/dev/simulate-reply', { mobile, text: f.text.value }); if (f.dataset.pick) { toast('Reply received. Opening the timeline.'); go('#/customers/' + encodeURIComponent(mobile)); } else render(); },
  search: async f => {
    sessionStorage.setItem('q', f.q.value);
    const rows = await api('GET', '/api/customers?q=' + encodeURIComponent(f.q.value));
    $('#results').innerHTML = table([{ h: 'Mobile', html: r => `<a class="mono" href="#/customers/${encodeURIComponent(r.mobile)}">${esc(r.mobile)}</a>` }, { h: 'Name', v: r => r.name }, { h: 'Brand', v: r => r.brand }, { h: 'Model', v: r => r.model }, { h: 'Salesperson', v: r => r.sales }], rows, 'No match.');
  },
  erase: async f => { await api('POST', `/api/customers/${encodeURIComponent(f.dataset.mobile)}/erase`, { confirm: f.confirm.value }); toast('Erased. The opt-out (if any) is kept.'); go('#/customers'); },
  optout: async f => { if (!confirm('Add to the opt-out list? This cannot be undone.')) return; await api('POST', '/api/optouts', { mobile: f.mobile.value }); render(); },
  suppress: async f => { const r = await api('POST', '/api/suppressions', { list: f.dataset.list, mobiles: f.mobiles.value.split(/[\s,;]+/).filter(Boolean) }); toast(`${r.added} added${r.invalid ? `, ${r.invalid} not valid Bahrain mobiles` : ''}.`); render(); },
  allow: async f => { await api('POST', '/api/allowlist', { mobile: f.mobile.value, note: f.note.value }); toast('Test phone added.'); render(); },
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
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
themeButtons();
render();
})();
