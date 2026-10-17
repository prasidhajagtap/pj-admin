// Asteriq Admin control centre: users (with their astrology profile and activity), app settings,
// announcements, releases, security and server health. Only the owner's email (ADMIN_EMAILS on the
// server) can sign in, so every screen shows every action. Builds on the helpers in app.js (el, api, busy, toast, ...).
'use strict';

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

// Error texts and AQ codes come from ADMIN_ERRORS in app.js (via ApiError).
const explain = (e) => e.message;

const LIMITERS = {
  global: 'All requests', login: 'App sign-in', 'admin-login': 'Admin sign-in', 'admin-sql': 'SQL editor', erase: 'Account deletion',
  astro: 'Astrology (quiz, readings, forecast)', apk: 'APK downloads', 'push-token': 'Push registrations', 'logo-upload': 'Logo uploads',
};

const COHORTS = { genz: 'Gen Z', nineties: '90s-born', general: 'Other' };
const GENDERS = { female: 'Woman', male: 'Man', unspecified: 'Not said' };

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

const fact = (label, value) => el('div', { class: 'fact' }, el('span', { class: 'muted', text: label }), typeof value === 'string' ? el('b', { text: value }) : value);

// ---------- Users ----------
const rating = (r) => (r == null ? '—' : chip(`${r}/10`, r >= 7 ? 'ok' : 'warn'));

// The app language each user picked after sign-in (kept with the account).
const LANGS = { hinglish: 'Hinglish', en: 'English', hi: 'हिंदी' };

// How accurate users find their profile (their 1-10 rating). The goal is 9 or more for 9 in 10.
function accuracyLine(a) {
  if (!a || !a.rated) return el('p', { class: 'muted small', text: 'Profile accuracy: no ratings yet.' });
  const good = a.nineUpShare >= 90;
  return el('p', { class: `notice ${good ? 'ok' : 'warn'}`, text:
    `Profile accuracy: ${a.average}/10 on average from ${a.rated} rating${a.rated === 1 ? '' : 's'} · ${a.nineUpShare}% rate it 9 or 10 (goal: 90%).` });
}

async function loadUsers() {
  const q = $('userSearch').value.trim();
  const params = new URLSearchParams({ limit: '100' });
  if (q) params.set('q', q);
  if ($('userSuspendedOnly').checked) params.set('status', 'suspended');
  const { total, users, accuracy } = await api('GET', `/admin/db/users?${params}`);
  $('usersBody').replaceChildren(
    el('p', { class: 'muted', text: `${total} user${total === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}` }),
    accuracyLine(accuracy),
    table([
      { label: '', cell: (u) => avatar(u.photoUrl, u.name) },
      { label: 'Name', cell: (u) => u.name ?? '—' },
      { label: 'Email', cell: (u) => u.email },
      { label: 'Status', cell: (u) => (u.suspendedAt ? chip('suspended', 'bad') : chip('active', 'ok')) },
      { label: 'Profile', cell: (u) => u.headline ?? chip('no profile yet') },
      { label: 'Accuracy', cell: (u) => rating(u.rating) },
      { label: 'Generation', cell: (u) => (u.cohort ? COHORTS[u.cohort] ?? u.cohort : '—') },
      { label: 'Days (7)', cell: (u) => String(u.days7) },
      { label: 'Language', cell: (u) => LANGS[u.lang] ?? '—' },
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
  const a = d.astro;
  const act7 = d.activity;
  const actions = el('div', { class: 'actions-bar' },
    u.suspendedAt
      ? el('button', { class: 'btn primary small', text: 'Unsuspend', onclick: async (e) => { await act(e.currentTarget, () => api('POST', `/admin/db/users/${id}/unsuspend`), 'User unsuspended'); openUser(id); } })
      : el('button', { class: 'btn danger small', text: 'Suspend…', onclick: async (e) => {
        const reason = await promptDialog(`Suspend ${u.name ?? u.email}?`, 'They are signed out everywhere and see this reason when they try to sign in.', { placeholder: 'Reason, e.g. Abusive behaviour', confirmLabel: 'Suspend' });
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
        el('p', { class: 'muted', text: 'Everything Asteriq stores about this user (GDPR / DPDP access request). Copy it into your reply.' }),
        el('pre', { class: 'tall', text }));
    } }),
    el('button', { class: 'btn danger small', text: 'Erase account…', onclick: async (e) => {
      const typed = await promptDialog('Erase this account for good?', `This permanently deletes ${u.email} with their astrology profile, ratings, feedback and check-ins. Type their email to confirm.`, { placeholder: u.email, mustEqual: u.email, confirmLabel: 'Erase' });
      if (typed == null) return;
      const done = await act(e.currentTarget, () => api('DELETE', `/admin/db/users/${id}`, { confirmEmail: typed }), 'Account erased');
      if (done !== undefined) { $('infoDialog').close(); loadUsers().catch(() => {}); }
    } }));

  openInfo(
    el('div', { class: 'info-head' },
      el('div', { class: 'who' }, avatar(u.photoUrl, u.name), el('div', {}, el('h3', { text: u.name ?? u.email }), el('small', { class: 'muted', text: u.email }))),
      u.suspendedAt ? chip('suspended', 'bad') : chip('active', 'ok')),
    u.suspendedAt ? el('p', { class: 'notice bad', text: `Suspended ${ago(u.suspendedAt)}: ${u.suspendedReason ?? 'no reason given'}` }) : null,
    actions,
    el('div', { class: 'facts' },
      fact('Joined', when(u.createdAt)),
      fact('Last sign-in', ago(u.lastLoginAt)),
      fact('App build', u.appBuild ? `build ${u.appBuild}` : 'unknown'),
      fact('Language', u.lang ? `${LANGS[u.lang] ?? u.lang} (chosen ${ago(u.langAt)})` : 'not chosen yet'),
      fact('Privacy notice', u.privacyVersion ? `${u.privacyVersion} (accepted ${ago(u.privacyAcceptedAt)})` : '—'),
      fact('Push devices', String(act7.pushDevices))),
    el('h3', { text: 'Astrology profile' }),
    a ? el('div', { class: 'facts' },
      fact('Headline', a.headline ?? '—'),
      fact('Sun sign', a.sign ?? 'no birth details'),
      fact('Generation', COHORTS[a.cohort] ?? a.cohort),
      fact('Gender', GENDERS[a.gender] ?? a.gender),
      fact('Accuracy', a.rating == null ? 'not rated' : `${a.rating}/10${a.firstRating != null && a.firstRating !== a.rating ? ` (first ${a.firstRating}/10)` : ''}`),
      fact('Top areas', (a.topAreas ?? []).join(', ') || '—'),
      fact('Last area read', a.lastArea ?? '—'),
      fact('Daily questions answered', String(a.dailyAnswers)),
      fact('Profile updated', ago(a.updatedAt))) : empty('No profile yet (the user has not finished the quiz).'),
    el('h3', { text: 'Last 30 days' }),
    el('div', { class: 'stats' },
      stat('Days opened', act7.opened30, act7.opened30 ? 'ok' : ''),
      stat('Good days', act7.good30, act7.good30 ? 'ok' : ''),
      stat('Hard days', act7.bad30, act7.bad30 > act7.good30 ? 'warn' : ''),
      stat('Felt true / off', `${act7.feltTrue} / ${act7.feltOff}`, act7.feltOff > act7.feltTrue ? 'warn' : '')),
  );
}

// ---------- App settings ----------
async function loadSettings() {
  const { settings } = await api('GET', '/admin/db/settings');
  $('settingsBody').replaceChildren(
    el('p', { class: 'muted', text: 'Phones pick up changes when Asteriq opens or comes back to the screen.' }),
    ...settings.map(settingRow),
  );
}

function settingRow(s) {
  const disabled = false;
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

// ---------- Home-screen icon ----------
// Festive icons are built into the app; the server says which one phones show and on which days.
// Phones switch when Asteriq goes to the background after being opened.
const iconImg = (key) => `icons/${key}.png`;
const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : n < 0 ? 'on now' : `in ${n} days`);

async function saveIcon(button, body, success) {
  const r = await act(button, () => api('PUT', '/admin/db/icons', body), success);
  if (r) renderIcons(r);
}

async function loadIcons() {
  renderIcons(await api('GET', '/admin/db/icons'));
}

function renderIcons(s) {
  const label = (key) => s.icons.find((i) => i.key === key)?.label ?? key;
  let status;
  if (s.icon === 'default') status = 'Phones show the everyday icon.';
  else if (s.showing === s.icon) status = s.until ? `Showing until ${dayLabel(s.until)}, then back to everyday by itself.` : 'Showing until you change it.';
  else if (s.from && s.today < s.from) status = `Starts ${dayLabel(s.from)}${s.until ? `, ends ${dayLabel(s.until)}` : ''}. Phones show the everyday icon until then.`;
  else status = `Ended ${dayLabel(s.until)}. Phones are back on the everyday icon.`;
  const now = el('div', { class: 'block' },
    el('h3', { text: 'Now on phones' }),
    el('div', { class: 'icon-now' },
      el('img', { src: iconImg(s.showing), alt: `${label(s.showing)} icon` }),
      el('div', { class: 'status' },
        el('b', { text: s.icon === 'default' ? label('default') : label(s.icon) }),
        el('span', { class: 'muted', text: status }),
        s.icon !== 'default' ? el('div', {}, el('button', { class: 'btn ghost small', text: 'Back to the everyday icon', onclick: (e) => saveIcon(e.currentTarget, { icon: 'default' }, 'Everyday icon from now') })) : '')));

  const smart = el('div', { class: 'block' },
    el('h3', { text: '✨ Coming up: suggested icons' }),
    el('p', { class: 'muted', text: 'Worked out from the Indian calendar (Sun and Moon), so the dates stay right every year. Each suggestion starts a few days early and ends by itself.' }),
    s.suggestions.length
      ? el('div', { class: 'suggestions' }, ...s.suggestions.map((f) => el('div', { class: `suggestion${f.daysAway <= 7 && !f.scheduled ? ' soon' : ''}` },
        el('img', { src: iconImg(f.icon), alt: `${f.iconLabel} icon` }),
        el('div', { class: 'text' },
          el('b', { text: `${f.festival} · ${dayLabel(f.date)}` }),
          el('span', { class: 'muted', text: `${f.approx ? 'Around this date (local calendars can differ by a day), ' : ''}${inDays(f.daysAway)}` }),
          el('span', { text: `Show the ${f.iconLabel} icon ${f.from === s.today ? 'from today' : `from ${dayLabel(f.from)}`} to ${dayLabel(f.until)}` })),
        el('div', { class: 'actions' },
          f.scheduled
            ? chip('Scheduled ✓', 'ok')
            : el('button', { class: 'btn small primary', text: f.from === s.today ? 'Use now' : 'Schedule', onclick: (e) => saveIcon(e.currentTarget, { icon: f.icon, from: f.from === s.today ? '' : f.from, until: f.until }, `${f.iconLabel} icon scheduled`) })))))
      : empty('No festivals in the next few weeks.'));

  const from = el('input', { type: 'date', min: s.today });
  const until = el('input', { type: 'date', min: s.today });
  let picked = s.icon === 'default' ? 'diwali' : s.icon;
  const tiles = s.icons.filter((i) => i.key !== 'default').map((i) => {
    const t = el('button', { type: 'button', class: `icon-tile${i.key === picked ? ' on' : ''}`, onclick: () => { picked = i.key; tiles.forEach((x) => x.classList.toggle('on', x === t)); } },
      el('img', { src: iconImg(i.key), alt: '' }), el('span', { text: i.label }));
    return t;
  });
  const choose = el('div', { class: 'block' },
    el('h3', { text: 'Choose an icon yourself' }),
    el('div', { class: 'icon-grid' }, ...tiles),
    el('div', { class: 'icon-form' },
      el('label', {}, 'First day (empty = now)', from),
      el('label', {}, 'Last day (empty = until changed)', until),
      el('button', { class: 'btn primary', text: 'Save', onclick: (e) => {
        if (from.value && until.value && from.value > until.value) return toast('The last day is before the first day.', 'bad');
        saveIcon(e.currentTarget, { icon: picked, from: from.value, until: until.value }, `${label(picked)} icon saved`);
      } })),
    el('small', { class: 'muted', text: 'Phones switch the next time someone opens Asteriq and then leaves it. Users who prefer the everyday icon can keep it (Me → Settings → Festive app icon).' }));

  $('iconBody').replaceChildren(now, smart, choose);
}

// ---------- Announcements ----------
async function loadAnnouncements() {
  const [{ announcements }, health] = await Promise.all([api('GET', '/admin/db/announcements'), api('GET', '/admin/db/health').catch(() => null)]);
  const push = health?.push?.configured;
  const title = el('input', { type: 'text', maxlength: '80', placeholder: 'Title, e.g. Diwali special forecast', class: 'wide' });
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
    block('New announcement',
      el('div', { class: 'compose' }, title, body, el('div', { class: 'filters' }, level, ends, publish)),
      el('small', { class: 'muted', text: push ? 'Also sent as a push notification to every phone.' : "Push notifications aren't set up yet, so users see it the next time they open Asteriq." })),
    block('Published', announcements.length ? el('div', { class: 'cards' }, announcements.map((a) => el('article', { class: `announcement ${a.level}` },
      el('div', { class: 'info-head' }, el('b', { text: a.title }), el('div', { class: 'chips' }, chip(a.level, a.level === 'important' ? 'warn' : ''), a.live ? chip('live', 'ok') : chip('ended'))),
      el('p', { text: a.body }),
      el('small', { class: 'muted', text: `By ${a.createdBy} · ${when(a.createdAt)}${a.endsAt ? ` · ${a.live ? 'ends' : 'ended'} ${when(a.endsAt)}` : ''}` }),
      a.live ? el('button', { class: 'btn ghost small', text: 'End now', onclick: async (e) => {
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
      s?.pinned ? el('button', { class: 'btn primary small', text: 'Offer the newest build again', onclick: pin(null) }) : null,
      el('button', { class: 'btn ghost small', text: 'Change minimum build…', onclick: () => document.querySelector('[data-load="settings"]').click() })),
    block('Builds kept on the laptop server', table([
      { label: 'Build', cell: (b) => `build ${b.buildNumber}` },
      { label: 'Size', cell: (b) => formatBytes(b.size) },
      { label: 'Downloaded', cell: (b) => when(b.downloadedAt) },
      { label: '', cell: (b) => (s && b.buildNumber === s.buildNumber ? chip('offered', 'ok') : el('button', { class: 'btn ghost small', text: 'Offer this build', onclick: pin(b.buildNumber) })) },
    ], r.kept, { emptyText: 'No APKs on the server yet. The start script downloads the newest GitHub release.' }),
    el('small', { class: 'muted', text: 'The server keeps the 3 newest builds. Every merge to main publishes a new one automatically.' })),
    block('Builds people are running', bars(r.distribution.map((d) => ({ label: d.build === null ? 'Unknown (older app)' : `build ${d.build}`, value: d.users, kind: d.build !== null && s && d.build < s.buildNumber ? 'warn' : '' })))),
  );
}

// ---------- Security ----------
async function loadSecurity() {
  const sec = await api('GET', '/admin/db/security');
  const blockedHour = sec.rateLimits.limiters.reduce((n, l) => n + l.blockedLastHour, 0);
  $('securityBody').replaceChildren(
    el('div', { class: 'stats' },
      stat('Blocked requests (1 h)', blockedHour, blockedHour ? 'warn' : ''),
      stat('Failed admin sign-ins (24 h)', sec.counts.failedLogins24h, sec.counts.failedLogins24h ? 'bad' : ''),
      stat('Suspended users', sec.counts.suspendedUsers)),
    block('Who can use this panel',
      el('p', { text: `Only the owner: ${state.admin?.email ?? 'the email in ADMIN_EMAILS'}.` }),
      el('small', { class: 'muted', text: 'Access is set by ADMIN_EMAILS in the server .env file. Any other Google account is refused, even if it was an admin before.' })),
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
      stat('App', h.app.maintenanceMode ? 'maintenance' : 'open', h.app.maintenanceMode ? 'bad' : 'ok', h.app.minBuild ? `min build ${h.app.minBuild}` : 'no minimum build')),
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
const loaders = { users: loadUsers, settings: loadSettings, icons: loadIcons, announcements: loadAnnouncements, releases: loadReleases, security: loadSecurity, server: loadServer };
const bodies = { users: 'usersBody', settings: 'settingsBody', icons: 'iconBody', announcements: 'announceBody', releases: 'releasesBody', security: 'securityBody', server: 'serverBody' };

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
