// PJ Admin control centre: play & Bluetooth, users, app settings, announcements, releases,
// security & admins, and server health. Builds on the helpers in app.js (el, api, busy, toast, ...).
'use strict';

const can = {
  edit: () => state.admin?.role !== 'viewer',
  own: () => (state.admin?.role ?? 'owner') === 'owner',
};

// ---------- formatting ----------
/** Server times are UTC ("2026-10-11 07:05:25.123" or ISO); shown in the browser's local time. */
function toDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function when(value, withSeconds = false) {
  const d = toDate(value);
  return d ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: withSeconds ? 'medium' : 'short' }) : '—';
}
function ago(value) {
  const d = toDate(value);
  if (!d) return 'never';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function clock(value) {
  const d = toDate(value);
  return d ? `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}` : '—';
}
function duration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Error texts and PJ codes come from ADMIN_ERRORS in app.js (via ApiError).
const explain = (e) => e.message;

const REASONS = {
  user_disconnected: 'Player tapped Disconnect',
  bluetooth_off: 'Bluetooth turned off',
  connection_lost: 'Link dropped',
  handshake_failed: "Couldn't verify the other phone",
  host_left: 'Host ended the game',
  lobby_closed: 'Lobby closed',
  left_lobby: 'Left the lobby',
  superseded: 'Replaced by a new session',
  abandoned: 'App vanished (closed after 3 h)',
  permission_denied: 'Permission denied',
  server_unreachable: 'Server unreachable',
  radio_error: 'Bluetooth error',
  closed_by_admin: 'Closed from the admin panel',
  account_suspended: 'Account suspended',
};
const reasonText = (r) => REASONS[r] ?? r ?? '—';

const EVENT_KIND = {
  spoof_rejected: 'bad', host_rejected: 'bad', bluetooth_off: 'bad', message_rejected: 'warn', peer_dropped: 'warn',
  permissions_problem: 'warn', send_failed: 'warn', connection_rejected: 'warn', disconnected: 'warn', peer_disconnected: 'warn',
  handshake_ok: 'ok', connected: 'ok', game_started: 'ok', round_finished: 'ok', session_started: 'info', session_ended: 'info',
  server_opened: 'info', server_closed: 'info',
};

const LIMITERS = {
  global: 'All requests', login: 'App sign-in', 'admin-login': 'Admin sign-in', 'admin-sql': 'SQL editor', erase: 'Account deletion',
  'friend-request': 'Friend requests', nudge: 'Nudges', 'game-create': 'New games', 'bt-session': 'Bluetooth sessions',
  'bt-events': 'Bluetooth logs', 'discovery-tag': 'Nearby tags', 'discovery-lookup': 'Nearby lookups', apk: 'APK downloads',
  'push-token': 'Push registrations', logo: 'Logo uploads',
};

// ---------- small building blocks ----------
const chip = (text, kind = '') => el('span', { class: `chip ${kind}`, text });
const stat = (label, value, kind = '', note = '') =>
  el('div', { class: `stat ${kind}` }, el('b', { text: String(value) }), el('span', { text: label }), note ? el('small', { text: note }) : null);
const block = (title, ...children) => el('section', { class: 'block' }, el('h3', { text: title }), ...children);
const empty = (text) => el('p', { class: 'muted empty', text });
const avatar = (url, name) => (url
  ? el('img', { class: 'avatar', src: url, alt: '', referrerpolicy: 'no-referrer' })
  : el('span', { class: 'avatar initials', text: (name || '?').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() }));

/** columns: [{ label, cell: (row) => Node | string }]; onRow makes rows clickable. */
function table(columns, rows, { onRow, emptyText = 'Nothing here yet.' } = {}) {
  if (!rows.length) return empty(emptyText);
  return el('div', { class: 'grid-wrap inline' }, el('table', { class: `grid${onRow ? ' clickable' : ''}` },
    el('thead', {}, el('tr', {}, columns.map((c) => el('th', { text: c.label })))),
    el('tbody', {}, rows.map((r) => el('tr', onRow ? { onclick: () => onRow(r), tabindex: '0', onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } } : {},
      columns.map((c) => {
        const v = c.cell(r);
        return el('td', { title: typeof v === 'string' ? v : '' }, v ?? '—');
      }))))));
}

function bars(items) {
  if (!items.length) return empty('No data yet.');
  const max = Math.max(...items.map((i) => i.value), 1);
  return el('div', { class: 'bars' }, items.map((i) => el('div', { class: 'bar-row' },
    el('span', { class: 'bar-label', text: i.label }),
    el('span', { class: 'bar-track' }, el('span', { class: `bar-fill ${i.kind ?? ''}`, style: { width: `${Math.max(4, (i.value / max) * 100)}%` } })),
    el('b', { text: String(i.value) }))));
}

function copyButton(text, label = 'Copy') {
  return el('button', {
    class: 'btn ghost small', text: label, type: 'button',
    onclick: async (e) => {
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast("Couldn't copy; select the text instead.", 'err'); }
      e.currentTarget.blur();
    },
  });
}

function openInfo(...nodes) {
  $('infoContent').replaceChildren(...nodes);
  if (!$('infoDialog').open) $('infoDialog').showModal();
  $('infoDialog').scrollTop = 0;
}

/** Asks for text. With `mustEqual`, the confirm button only works once the text matches. Resolves null if cancelled. */
function promptDialog(title, text, { placeholder = '', mustEqual = null, confirmLabel = 'Confirm', danger = true } = {}) {
  $('promptTitle').textContent = title;
  $('promptText').textContent = text;
  $('promptInput').value = '';
  $('promptInput').placeholder = placeholder;
  $('promptError').textContent = '';
  $('promptOk').textContent = confirmLabel;
  $('promptOk').className = `btn ${danger ? 'danger' : 'primary'}`;
  const dlg = $('promptDialog');
  dlg.showModal();
  $('promptInput').focus();
  return new Promise((resolve) => {
    const finish = (value) => { $('promptOk').onclick = null; $('promptInput').onkeydown = null; dlg.onclose = null; dlg.close(); resolve(value); };
    const ok = () => {
      const value = $('promptInput').value.trim();
      if (!value) { $('promptError').textContent = 'Please fill this in.'; return; }
      if (mustEqual && value.toLowerCase() !== mustEqual.toLowerCase()) { $('promptError').textContent = "That doesn't match."; return; }
      finish(value);
    };
    $('promptOk').onclick = ok;
    $('promptInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    dlg.onclose = () => resolve(null);
  });
}

async function act(button, task, success) {
  return busy(button, async () => {
    try {
      const result = await task();
      if (success) toast(success);
      return result;
    } catch (e) {
      toast(explain(e), 'err');
      return undefined;
    }
  });
}

// ---------- Play & Bluetooth ----------
const playFilter = { status: '', reason: '', user: '' };

async function loadPlay() {
  const query = new URLSearchParams(Object.entries(playFilter).filter(([, v]) => v));
  const [o, lobbies, sessions] = await Promise.all([
    api('GET', '/admin/db/play/overview'),
    api('GET', '/admin/db/play/lobbies'),
    api('GET', `/admin/db/play/sessions?${query}`),
  ]);
  const c = o.counts;
  $('playBadge').textContent = c.activeSessions ? `${c.activeSessions} live` : '';

  const statusSel = el('select', { 'aria-label': 'Status' },
    [['', 'Any status'], ['active', 'Active'], ['ended', 'Ended'], ['failed', 'Failed']].map(([v, t]) => el('option', { value: v, text: t, selected: playFilter.status === v })));
  const reasonSel = el('select', { 'aria-label': 'End reason' },
    el('option', { value: '', text: 'Any reason' }),
    Object.entries(REASONS).map(([v, t]) => el('option', { value: v, text: t, selected: playFilter.reason === v })));
  const userInput = el('input', { type: 'search', placeholder: 'Player name or email…', value: playFilter.user });
  const apply = el('button', { class: 'btn small primary', text: 'Filter', onclick: (e) => {
    Object.assign(playFilter, { status: statusSel.value, reason: reasonSel.value, user: userInput.value.trim() });
    busy(e.currentTarget, loadPlay);
  } });

  $('playBody').replaceChildren(
    el('div', { class: 'stats' },
      stat('Live lobbies', c.openLobbies),
      stat('Active Bluetooth sessions', c.activeSessions, c.activeSessions ? 'ok' : ''),
      stat('Games (24 h)', c.games24h),
      stat('Nudges (24 h)', c.nudges24h),
      stat('Friendships', c.friendships),
      stat('Spoof attempts (24 h)', c.spoof24h, c.spoof24h ? 'bad' : '', `${c.spoof7d} in 7 days`)),
    el('div', { class: 'two-col' },
      block('Sessions in the last 24 hours', o.last24hByStatus.length
        ? el('div', { class: 'chips' }, o.last24hByStatus.map((s) => chip(`${s.status}: ${s.n}`, s.status === 'failed' ? 'bad' : s.status === 'active' ? 'ok' : '')))
        : empty('No Bluetooth sessions yet.')),
      block('Why sessions ended (7 days)', bars(o.endReasons7d.map((r) => ({ label: reasonText(r.reason), value: r.n, kind: ['user_disconnected', 'host_left', 'lobby_closed'].includes(r.reason) ? '' : 'warn' }))))),
    block('Alerts (7 days)', table([
      { label: 'When', cell: (a) => ago(a.at) },
      { label: 'What', cell: (a) => chip(a.type.replace(/_/g, ' '), EVENT_KIND[a.type] ?? 'warn') },
      { label: 'Reported by', cell: (a) => a.userName ?? '—' },
      { label: 'Other phone', cell: (a) => a.peerName ?? 'unknown device' },
      { label: 'Details', cell: (a) => [a.detail?.why, a.detail?.reason].filter(Boolean).join(' · ') || '—' },
    ], o.alerts, { onRow: (a) => openSession(a.sessionId), emptyText: 'No spoofing attempts or misbehaving phones. 👍' })),
    block('Live lobbies', table([
      { label: 'Lobby', cell: (l) => l.code },
      { label: 'Host', cell: (l) => l.hostName ?? '—' },
      { label: 'Players', cell: (l) => el('div', { class: 'chips' }, l.players.map((p) => chip(`${p.name ?? 'Player'} · ${p.status}`, p.status === 'accepted' ? 'ok' : p.status === 'declined' ? 'bad' : ''))) },
      { label: 'Phones connected', cell: (l) => String(l.activeSessions) },
      { label: 'Opened', cell: (l) => ago(l.createdAt) },
      { label: '', cell: (l) => (can.edit() ? el('button', { class: 'btn small danger', text: 'Close', onclick: (e) => { e.stopPropagation(); closeLobby(l, e.currentTarget); } }) : '') },
    ], lobbies.lobbies, { emptyText: 'No open lobbies right now.' })),
    block('Bluetooth sessions',
      el('div', { class: 'filters' }, statusSel, reasonSel, userInput, apply),
      table([
        { label: 'Started', cell: (s) => when(s.startedAt) },
        { label: 'Player', cell: (s) => s.userName ?? s.userEmail },
        { label: 'Role', cell: (s) => s.role },
        { label: 'Phone', cell: (s) => [s.deviceModel, s.androidSdk && `Android SDK ${s.androidSdk}`, s.appBuild && `build ${s.appBuild}`].filter(Boolean).join(' · ') || '—' },
        { label: 'Status', cell: (s) => chip(s.status, s.status === 'failed' ? 'bad' : s.status === 'active' ? 'ok' : '') },
        { label: 'Ended because', cell: (s) => (s.endReason ? reasonText(s.endReason) : '—') },
        { label: 'Length', cell: (s) => duration(s.seconds) },
        { label: 'Log', cell: (s) => `${s.events} steps` },
      ], sessions.sessions, { onRow: (s) => openSession(s.id), emptyText: 'No sessions match.' })),
  );
}

async function closeLobby(lobby, button) {
  if (!(await confirmDialog(`Close lobby ${lobby.code}?`, `${lobby.hostName ?? 'The host'}'s game ends for every player and their Bluetooth sessions are closed.`))) return;
  await act(button, () => api('POST', `/admin/db/play/lobbies/${lobby.id}/close`), 'Lobby closed');
  loadPlay().catch(() => {});
}

async function openSession(id) {
  let data;
  try {
    data = await api('GET', `/admin/db/play/sessions/${id}`);
  } catch (e) {
    return toast(explain(e), 'err');
  }
  const s = data.session;
  openInfo(
    el('div', { class: 'info-head' },
      el('div', {}, el('h3', { text: `${s.userName ?? s.userEmail} · ${s.role}` }),
        el('small', { class: 'muted', text: `Lobby ${s.lobbyCode} hosted by ${s.hostName ?? '—'}` })),
      chip(s.status, s.status === 'failed' ? 'bad' : s.status === 'active' ? 'ok' : '')),
    el('div', { class: 'facts' },
      fact('Session ID', el('span', {}, el('code', { text: s.id }), ' ', copyButton(s.id))),
      fact('Phone', [s.deviceModel, s.androidSdk && `SDK ${s.androidSdk}`, s.appBuild && `build ${s.appBuild}`].filter(Boolean).join(' · ') || '—'),
      fact('Started', when(s.startedAt, true)),
      fact('Ended', s.endedAt ? `${when(s.endedAt, true)} · ${reasonText(s.endReason)}` : 'still active')),
    data.related.length ? el('div', { class: 'related' }, el('span', { class: 'muted', text: 'Other phones in this game:' }),
      data.related.map((r) => el('button', { class: 'btn ghost small', text: `${r.userName} (${r.role}, ${r.status})`, onclick: () => openSession(r.id) }))) : null,
    el('h3', { text: `Step-by-step log (${data.events.length})` }),
    data.events.length ? el('ol', { class: 'events' }, data.events.map((e) => el('li', {},
      el('span', { class: 'when', text: clock(e.at) }),
      chip(e.type.replace(/_/g, ' '), EVENT_KIND[e.type] ?? ''),
      e.peerName ? el('span', { class: 'muted', text: `with ${e.peerName}` }) : null,
      e.detail ? el('code', { class: 'detail', text: Object.entries(e.detail).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ') }) : null)))
      : empty('No steps were logged.'),
  );
}

const fact = (label, value) => el('div', { class: 'fact' }, el('span', { class: 'muted', text: label }), typeof value === 'string' ? el('b', { text: value }) : value);

// ---------- Users ----------
async function loadUsers() {
  const q = $('userSearch').value.trim();
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if ($('userSuspendedOnly').checked) params.set('status', 'suspended');
  const { total, users } = await api('GET', `/admin/db/users?${params}`);
  $('usersBody').replaceChildren(
    el('p', { class: 'muted', text: `${total} user${total === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}` }),
    table([
      { label: '', cell: (u) => avatar(u.photoUrl, u.name) },
      { label: 'Name', cell: (u) => u.name ?? '—' },
      { label: 'Email', cell: (u) => u.email },
      { label: 'Status', cell: (u) => (u.suspendedAt ? chip('suspended', 'bad') : u.online ? chip('online', 'ok') : chip('offline')) },
      { label: 'Friends', cell: (u) => String(u.friends) },
      { label: 'App build', cell: (u) => (u.appBuild ? `build ${u.appBuild}` : '—') },
      { label: 'Last sign-in', cell: (u) => ago(u.lastLoginAt) },
    ], users, { onRow: (u) => openUser(u.id), emptyText: 'No users found.' }),
  );
}

async function openUser(id) {
  let d;
  try {
    d = await api('GET', `/admin/db/users/${id}`);
  } catch (e) {
    return toast(explain(e), 'err');
  }
  const u = d.user;
  const actions = el('div', { class: 'actions-bar' });
  if (can.edit()) {
    actions.append(
      u.suspendedAt
        ? el('button', { class: 'btn primary small', text: 'Unsuspend', onclick: async (e) => { await act(e.currentTarget, () => api('POST', `/admin/db/users/${id}/unsuspend`), 'User unsuspended'); openUser(id); } })
        : el('button', { class: 'btn danger small', text: 'Suspend…', onclick: async (e) => {
          const reason = await promptDialog(`Suspend ${u.name ?? u.email}?`, 'They are signed out everywhere and see this reason when they try to sign in.', { placeholder: 'Reason, e.g. Spam nudges', confirmLabel: 'Suspend' });
          if (reason == null) return;
          await act(e.currentTarget, () => api('POST', `/admin/db/users/${id}/suspend`, { reason }), 'User suspended');
          openUser(id);
        } }),
      el('button', { class: 'btn ghost small', text: 'Sign out everywhere', onclick: async (e) => {
        if (!(await confirmDialog('Sign out everywhere?', `${u.name ?? u.email} is signed out on every phone and must sign in with Google again.`))) return;
        await act(e.currentTarget, () => api('POST', `/admin/db/users/${id}/sign-out`), 'Signed out everywhere');
        openUser(id);
      } }),
      el('button', { class: 'btn ghost small', text: 'Export data', onclick: async (e) => {
        const r = await act(e.currentTarget, () => api('GET', `/admin/db/users/${id}/export`));
        if (!r) return;
        const text = JSON.stringify(r, null, 2);
        openInfo(el('div', { class: 'info-head' }, el('h3', { text: `Data export · ${u.email}` }), copyButton(text, 'Copy JSON')),
          el('p', { class: 'muted', text: 'Everything PJ stores about this user (GDPR access request). Copy it into your reply.' }),
          el('pre', { class: 'tall', text }));
      } }),
    );
  }
  if (can.own()) {
    actions.append(el('button', { class: 'btn danger small', text: 'Erase account…', onclick: async (e) => {
      const typed = await promptDialog('Erase this account for good?', `This permanently deletes ${u.email} with their friends, nudges, games and Bluetooth logs. Type their email to confirm.`, { placeholder: u.email, mustEqual: u.email, confirmLabel: 'Erase' });
      if (typed == null) return;
      const done = await act(e.currentTarget, () => api('DELETE', `/admin/db/users/${id}`, { confirmEmail: typed }), 'Account erased');
      if (done !== undefined) { $('infoDialog').close(); loadUsers().catch(() => {}); }
    } }));
  }

  openInfo(
    el('div', { class: 'info-head' },
      el('div', { class: 'who' }, avatar(u.photoUrl, u.name), el('div', {}, el('h3', { text: u.name ?? u.email }), el('small', { class: 'muted', text: u.email }))),
      u.suspendedAt ? chip('suspended', 'bad') : u.online ? chip('online', 'ok') : chip('offline')),
    u.suspendedAt ? el('p', { class: 'notice bad', text: `Suspended ${ago(u.suspendedAt)}: ${u.suspendedReason ?? 'no reason given'}` }) : null,
    actions.childElementCount ? actions : null,
    el('div', { class: 'facts' },
      fact('Joined', when(u.createdAt)),
      fact('Last sign-in', ago(u.lastLoginAt)),
      fact('App build', u.appBuild ? `build ${u.appBuild}` : 'unknown'),
      fact('Privacy notice', u.privacyVersion ? `${u.privacyVersion} (accepted ${ago(u.privacyAcceptedAt)})` : '—'),
      fact('Nudges', `${d.counts.nudgesSent} sent · ${d.counts.nudgesReceived} received`),
      fact('Push devices', String(d.counts.pushDevices))),
    el('h3', { text: `Friends (${d.friends.length})` }),
    table([
      { label: 'Name', cell: (f) => f.name ?? f.email },
      { label: 'Email', cell: (f) => f.email },
      { label: 'Status', cell: (f) => chip(f.status === 'accepted' ? 'friends' : f.requestedByUser ? 'request sent' : 'request received', f.status === 'accepted' ? 'ok' : '') },
      { label: 'Since', cell: (f) => when(f.since) },
    ], d.friends, { onRow: (f) => openUser(f.id), emptyText: 'No friends yet.' }),
    el('h3', { text: 'Recent games' }),
    table([
      { label: 'Lobby', cell: (g) => g.code },
      { label: 'Role', cell: (g) => (g.hosted ? 'host' : `guest (${g.invite})`) },
      { label: 'Status', cell: (g) => g.status },
      { label: 'When', cell: (g) => when(g.createdAt) },
    ], d.games, { emptyText: 'No games yet.' }),
    el('h3', { text: 'Recent Bluetooth sessions' }),
    table([
      { label: 'Started', cell: (s) => when(s.startedAt) },
      { label: 'Role', cell: (s) => s.role },
      { label: 'Status', cell: (s) => chip(s.status, s.status === 'failed' ? 'bad' : s.status === 'active' ? 'ok' : '') },
      { label: 'Ended because', cell: (s) => (s.endReason ? reasonText(s.endReason) : '—') },
    ], d.sessions, { onRow: (s) => openSession(s.id), emptyText: 'No Bluetooth sessions yet.' }),
  );
}

// ---------- App settings ----------
async function loadSettings() {
  const { settings } = await api('GET', '/admin/db/settings');
  $('settingsBody').replaceChildren(
    el('p', { class: 'muted', text: 'Phones pick up changes the next time they check in (every few seconds while PJ is open).' }),
    ...settings.map(settingRow),
  );
}

function settingRow(s) {
  const disabled = !can.edit();
  let input;
  if (s.type === 'boolean') {
    input = el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: s.value, disabled }), el('span', {}));
  } else if (s.type === 'integer') {
    input = el('input', { type: 'number', min: String(s.min), max: String(s.max), step: '1', value: String(s.value), disabled, class: 'num' });
  } else {
    input = el('input', { type: 'text', maxlength: String(s.maxLength), value: s.value, placeholder: 'No message', disabled, class: 'wide' });
  }
  const read = () => {
    const field = input.tagName === 'LABEL' ? input.querySelector('input') : input;
    if (s.type === 'boolean') return field.checked;
    if (s.type === 'integer') return Number(field.value);
    return field.value.trim();
  };
  const meta = el('small', { class: 'muted', text: s.updatedBy ? `Changed by ${s.updatedBy}, ${ago(s.updatedAt)}` : `Default: ${s.default === '' ? 'empty' : s.default}` });
  const save = el('button', { class: 'btn small primary', text: 'Save', disabled, onclick: async (e) => {
    const value = read();
    if (s.name === 'maintenance_mode' && value && !(await confirmDialog('Turn on maintenance mode?', 'Every phone shows the maintenance screen until you turn it off. The admin panel keeps working.'))) return;
    const r = await act(e.currentTarget, () => api('PUT', `/admin/db/settings/${s.name}`, { value }), `Saved: ${s.label}`);
    if (r) { row.classList.add('flash'); meta.textContent = `Changed by you, just now`; row.classList.toggle('alert', s.name === 'maintenance_mode' && value === true); }
  } });
  const row = el('div', { class: `setting${s.name === 'maintenance_mode' && s.value ? ' alert' : ''}` },
    el('div', { class: 'setting-text' }, el('b', { text: s.label }), el('span', { class: 'muted', text: s.help }), meta),
    el('div', { class: 'setting-control' }, input, save));
  return row;
}

// ---------- Announcements ----------
async function loadAnnouncements() {
  const [{ announcements }, health] = await Promise.all([api('GET', '/admin/db/announcements'), api('GET', '/admin/db/health').catch(() => null)]);
  const push = health?.push?.configured;
  const title = el('input', { type: 'text', maxlength: '80', placeholder: 'Title, e.g. New game this weekend', class: 'wide' });
  const body = el('textarea', { maxlength: '500', placeholder: 'Message (up to 500 characters)', rows: '3' });
  const level = el('select', {}, el('option', { value: 'info', text: 'Info' }), el('option', { value: 'important', text: 'Important' }));
  const ends = el('select', {}, [['', 'Until I end it'], ['24', 'For 24 hours'], ['72', 'For 3 days'], ['168', 'For 7 days']].map(([v, t]) => el('option', { value: v, text: t })));
  const publish = el('button', { class: 'btn primary', text: 'Publish', onclick: async (e) => {
    if (!title.value.trim() || !body.value.trim()) return toast(adminErrorText('title_and_body_required'), 'err');
    if (!(await confirmDialog('Publish to everyone?', `"${title.value.trim()}" appears in every user's app${push ? ' and is sent as a push notification' : ''}.`))) return;
    const r = await act(e.currentTarget, () => api('POST', '/admin/db/announcements', {
      title: title.value, body: body.value, level: level.value, hours: ends.value ? Number(ends.value) : null,
    }), 'Announcement published');
    if (r) loadAnnouncements().catch(() => {});
  } });

  $('announceBody').replaceChildren(
    can.edit() ? block('New announcement',
      el('div', { class: 'compose' }, title, body, el('div', { class: 'filters' }, level, ends, publish)),
      el('small', { class: 'muted', text: push ? 'Also sent as a push notification to every phone.' : "Push notifications aren't set up yet, so users see it the next time they open PJ." })) : null,
    block('Published', announcements.length ? el('div', { class: 'cards' }, announcements.map((a) => el('article', { class: `announcement ${a.level}` },
      el('div', { class: 'info-head' }, el('b', { text: a.title }), el('div', { class: 'chips' }, chip(a.level, a.level === 'important' ? 'warn' : ''), a.live ? chip('live', 'ok') : chip('ended'))),
      el('p', { text: a.body }),
      el('small', { class: 'muted', text: `By ${a.createdBy} · ${when(a.createdAt)}${a.endsAt ? ` · ${a.live ? 'ends' : 'ended'} ${when(a.endsAt)}` : ''}` }),
      a.live && can.edit() ? el('button', { class: 'btn ghost small', text: 'End now', onclick: async (e) => {
        await act(e.currentTarget, () => api('POST', `/admin/db/announcements/${a.id}/end`), 'Announcement ended');
        loadAnnouncements().catch(() => {});
      } }) : null))) : empty('No announcements yet.')),
  );
}

// ---------- Releases ----------
async function loadReleases() {
  const r = await api('GET', '/admin/db/releases');
  const s = r.serving;
  const pin = (build) => async (e) => {
    const msg = build === null ? 'Offer the newest build again?' : `Offer build ${build} instead of newer ones?`;
    if (!(await confirmDialog(msg, build === null ? 'Phones will be offered the newest build on the server.' : 'Phones on an older build will be offered this one. Phones that already installed a newer build keep it (Android does not allow downgrades).'))) return;
    await act(e.currentTarget, () => api('POST', '/admin/db/releases/pin', { buildNumber: build }), 'Release updated');
    loadReleases().catch(() => {});
  };
  $('releasesBody').replaceChildren(
    el('div', { class: 'stats' },
      stat('Offered to phones', s ? `build ${s.buildNumber}` : 'none', s?.pinned ? 'warn' : 'ok', s?.pinned ? 'pinned by an admin' : 'newest on the server'),
      stat('Newest downloaded', s?.newestBuild ? `build ${s.newestBuild}` : '—'),
      stat('Minimum build', r.minBuild ? `build ${r.minBuild}` : 'none', r.minBuild ? 'warn' : '', 'older builds must update')),
    el('div', { class: 'actions-bar' },
      s?.pinned && can.edit() ? el('button', { class: 'btn primary small', text: 'Offer the newest build again', onclick: pin(null) }) : null,
      el('button', { class: 'btn ghost small', text: 'Change minimum build…', onclick: () => document.querySelector('[data-load="settings"]').click() })),
    block('Builds kept on the laptop server', table([
      { label: 'Build', cell: (b) => `build ${b.buildNumber}` },
      { label: 'Size', cell: (b) => formatBytes(b.size) },
      { label: 'Downloaded', cell: (b) => when(b.downloadedAt) },
      { label: '', cell: (b) => (s && b.buildNumber === s.buildNumber ? chip('offered', 'ok') : can.edit() ? el('button', { class: 'btn ghost small', text: 'Offer this build', onclick: pin(b.buildNumber) }) : '') },
    ], r.kept, { emptyText: 'No APKs on the server yet. The start script downloads the newest GitHub release.' }),
    el('small', { class: 'muted', text: 'The server keeps the 3 newest builds. Every merge to main publishes a new one automatically.' })),
    block('Builds people are running', bars(r.distribution.map((d) => ({ label: d.build === null ? 'Unknown (older app)' : `build ${d.build}`, value: d.users, kind: d.build !== null && s && d.build < s.buildNumber ? 'warn' : '' })))),
  );
}

// ---------- Security & admins ----------
async function loadSecurity() {
  const [sec, { admins }] = await Promise.all([api('GET', '/admin/db/security'), api('GET', '/admin/db/admins')]);
  const blockedHour = sec.rateLimits.limiters.reduce((n, l) => n + l.blockedLastHour, 0);
  const email = el('input', { type: 'email', placeholder: 'name@gmail.com', class: 'wide' });
  const role = el('select', {}, ['viewer', 'editor', 'owner'].map((r) => el('option', { value: r, text: r })));
  $('securityBody').replaceChildren(
    el('div', { class: 'stats' },
      stat('Blocked requests (1 h)', blockedHour, blockedHour ? 'warn' : ''),
      stat('Failed admin sign-ins (24 h)', sec.counts.failedLogins24h, sec.counts.failedLogins24h ? 'bad' : ''),
      stat('Spoof attempts (24 h)', sec.counts.spoof24h, sec.counts.spoof24h ? 'bad' : ''),
      stat('Suspended users', sec.counts.suspendedUsers)),
    block('Who can use this panel',
      table([
        { label: 'Email', cell: (a) => a.email + (a.email === state.admin?.email ? ' (you)' : '') },
        { label: 'Role', cell: (a) => (can.own() && a.email !== state.admin?.email
          ? el('select', { onchange: async (e) => { await act(null, () => api('PUT', `/admin/db/admins/${encodeURIComponent(a.email)}`, { role: e.target.value }), 'Role updated'); } },
            ['owner', 'editor', 'viewer'].map((r) => el('option', { value: r, text: r, selected: a.role === r })))
          : chip(a.role, a.role === 'owner' ? 'ok' : '')) },
        { label: 'Added by', cell: (a) => a.addedBy },
        { label: '', cell: (a) => (can.own() && a.email !== state.admin?.email ? el('button', { class: 'btn ghost small', text: 'Remove', onclick: async (e) => {
          if (!(await confirmDialog(`Remove ${a.email}?`, 'They can no longer sign in to the admin panel.'))) return;
          await act(e.currentTarget, () => api('DELETE', `/admin/db/admins/${encodeURIComponent(a.email)}`), 'Admin removed');
          loadSecurity().catch(() => {});
        } }) : '') },
      ], admins),
      can.own() ? el('div', { class: 'filters' }, email, role, el('button', { class: 'btn primary small', text: 'Add admin', onclick: async (e) => {
        const value = email.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return toast(adminErrorText('invalid_admin'), 'err');
        const r = await act(e.currentTarget, () => api('PUT', `/admin/db/admins/${encodeURIComponent(value)}`, { role: role.value }), `${value} added as ${role.value}`);
        if (r) loadSecurity().catch(() => {});
      } })) : null,
      el('small', { class: 'muted', text: 'Owner: everything, including admins and erasing users. Editor: changes data and settings. Viewer: read-only. They sign in with that Google account.' })),
    block('Brute-force protection (since the server started)', table([
      { label: 'Limit', cell: (l) => LIMITERS[l.name] ?? l.name },
      { label: 'Allowed', cell: (l) => `${l.max} per ${duration(l.windowSeconds)}` },
      { label: 'Blocked (1 h)', cell: (l) => String(l.blockedLastHour) },
      { label: 'Blocked (24 h)', cell: (l) => String(l.blockedLast24h) },
      { label: 'Blocked (total)', cell: (l) => String(l.blockedTotal) },
    ], sec.rateLimits.limiters)),
    block('Recently blocked requests', table([
      { label: 'When', cell: (b) => when(b.at, true) },
      { label: 'Limit', cell: (b) => LIMITERS[b.limiter] ?? b.limiter },
      { label: 'Request', cell: (b) => `${b.method} ${b.path}` },
      { label: 'From', cell: (b) => b.ip },
    ], sec.rateLimits.recentBlocks, { emptyText: 'Nothing blocked recently.' })),
    el('div', { class: 'two-col' },
      block('Failed admin sign-ins (30 days)', table([
        { label: 'When', cell: (f) => when(f.at) },
        { label: 'Account', cell: (f) => f.email },
        { label: 'From', cell: (f) => f.ip ?? '—' },
      ], sec.failedLogins, { emptyText: 'None.' })),
      block('Recent admin activity', table([
        { label: 'When', cell: (a) => ago(a.at) },
        { label: 'Admin', cell: (a) => a.email },
        { label: 'Action', cell: (a) => `${a.action.replace(/_/g, ' ')}${a.tableName ? ` · ${a.tableName}` : ''}` },
        { label: '', cell: (a) => (a.success ? chip('ok', 'ok') : chip('failed', 'bad')) },
      ], sec.recentActions, { emptyText: 'No activity yet.' }))),
  );
}

// ---------- Server ----------
async function loadServer() {
  const h = await api('GET', '/admin/db/health');
  const retention = Object.entries(h.retention);
  $('serverBody').replaceChildren(
    el('div', { class: 'stats' },
      stat('Running for', duration(h.server.uptimeSeconds), 'ok', `since ${when(h.server.startedAt)}`),
      stat('Memory', `${h.server.memoryMb} MB`),
      stat('Database size', `${h.database.sizeMb} MB`, '', `MySQL ${h.database.version}`),
      stat('Push notifications', h.push.configured ? 'on' : 'off', h.push.configured ? 'ok' : 'warn', h.push.configured ? `${h.push.sent} sent · ${h.push.failed} failed` : 'Firebase not set up yet'),
      stat('Offered build', h.release ? `build ${h.release.buildNumber}` : 'none', h.release?.pinned ? 'warn' : ''),
      stat('App', h.app.maintenanceMode ? 'maintenance' : 'open', h.app.maintenanceMode ? 'bad' : 'ok', `${h.app.playEnabled ? 'games on' : 'games paused'}${h.app.minBuild ? ` · min build ${h.app.minBuild}` : ''}`)),
    block('Address',
      h.server.publicUrl ? el('div', { class: 'filters' }, el('code', { text: h.server.publicUrl }), copyButton(h.server.publicUrl)) : empty('Not running through the Cloudflare tunnel.'),
      el('small', { class: 'muted', text: `Node ${h.server.node} · port ${h.server.port} · database ${h.database.name}` })),
    block('Cleanup jobs (GDPR retention)', retention.length ? table([
      { label: 'Job', cell: ([name]) => name },
      { label: 'Last run', cell: ([, r]) => when(r.at) },
      { label: 'Removed', cell: ([, r]) => (r.ok ? String(r.removed) : '—') },
      { label: '', cell: ([, r]) => (r.ok ? chip('ok', 'ok') : chip(r.error ?? 'failed', 'bad')) },
    ], retention) : empty('Not run yet.')),
    block('Tables', table([
      { label: 'Table', cell: (t) => t.name },
      { label: 'Rows (approx.)', cell: (t) => String(t.approxRows) },
      { label: 'Size', cell: (t) => `${t.kb} KB` },
    ], h.database.tables)),
  );
}

// ---------- wiring ----------
const loaders = { play: loadPlay, users: loadUsers, settings: loadSettings, announcements: loadAnnouncements, releases: loadReleases, security: loadSecurity, server: loadServer };
const bodies = { play: 'playBody', users: 'usersBody', settings: 'settingsBody', announcements: 'announceBody', releases: 'releasesBody', security: 'securityBody', server: 'serverBody' };

async function runLoader(name, placeholder = true) {
  const body = $(bodies[name]);
  if (placeholder && !body.childElementCount) {
    body.replaceChildren(el('div', { class: 'stats' }, Array.from({ length: 4 }, () => el('div', { class: 'stat skeleton-card' }))));
  }
  try {
    await loaders[name]();
  } catch (e) {
    body.replaceChildren(el('p', { class: 'notice bad', text: `Couldn't load this screen: ${explain(e)}` }));
  }
}

document.querySelectorAll('.sidebar [data-load]').forEach((btn) => {
  btn.addEventListener('click', () => { switchPanel(btn.dataset.panel); runLoader(btn.dataset.load); });
});
document.querySelectorAll('[data-reload]').forEach((btn) => {
  btn.addEventListener('click', (e) => busy(e.currentTarget, () => runLoader(btn.dataset.reload, false)));
});
let userTimer;
$('userSearch').addEventListener('input', () => { clearTimeout(userTimer); userTimer = setTimeout(() => runLoader('users', false), 300); });
$('userSuspendedOnly').addEventListener('change', () => runLoader('users', false));
document.querySelectorAll('#infoDialog [data-close], #promptDialog [data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
