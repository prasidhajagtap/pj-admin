// PJ Database admin UI. Talks to the PJ server's /admin API.
// The server's current address (it changes with each free Cloudflare Tunnel) is published to server.json in this repo.
'use strict';

const CONFIG = {
  googleClientId: '111079787838-kiopkugema4sacnt5n5unkg0b472sc3o.apps.googleusercontent.com',
  // GitHub API (not the Pages CDN) so a freshly published address is seen immediately.
  // server.json lives on its own branch so publishing it never touches the reviewed code on main.
  discoveryUrl: 'https://api.github.com/repos/prasidhajagtap/pj-admin/contents/server.json?ref=server-info',
};

const $ = (id) => document.getElementById(id);
const store = {
  get(k, s = sessionStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = sessionStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = {
  api: null,
  token: store.get('pj_admin_token'),
  admin: JSON.parse(store.get('pj_admin') || 'null'),
  tables: [],
  table: null, // { name, columns, primaryKey, readOnly }
  page: { offset: 0, limit: 50, sort: null, dir: 'asc', search: '' },
  rows: [],
};

// ---------- helpers ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v); // CSSOM, allowed by the page's CSP
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function toast(message, kind = 'ok') {
  const t = el('div', { class: `toast glass ${kind}`, text: message });
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

// ---------- click feedback ----------
// A ripple spreads from the click point on every button-like element.
document.addEventListener('pointerdown', (e) => {
  const target = e.target.closest('.btn, .nav-item, .row-btn, .icon-btn, .pill');
  if (!target || target.disabled) return;
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const dot = el('span', { class: 'ripple', style: {
    width: `${size}px`, height: `${size}px`,
    left: `${e.clientX - rect.left - size / 2}px`, top: `${e.clientY - rect.top - size / 2}px`,
  } });
  target.append(dot);
  dot.addEventListener('animationend', () => dot.remove());
});

/** Shows a spinner on `button` while `task` runs and ignores repeat clicks meanwhile. */
async function busy(button, task) {
  if (button?.classList.contains('loading')) return undefined;
  button?.classList.add('loading');
  button?.setAttribute('aria-busy', 'true');
  try {
    return await task();
  } finally {
    button?.classList.remove('loading');
    button?.removeAttribute('aria-busy');
  }
}

/** Shimmering placeholder rows while a table loads. */
function showSkeleton(table, cols = 5, rows = 6) {
  table.replaceChildren(el('tbody', {}, Array.from({ length: rows }, (_, r) => el('tr', { class: 'skeleton' },
    Array.from({ length: Math.min(cols, 8) }, (_, c) => el('td', {}, el('span', { style: { width: `${45 + ((r * 7 + c * 13) % 45)}%` } })))))));
}

const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function show(view) {
  for (const v of ['loginView', 'offlineView', 'appView']) $(v).classList.toggle('hidden', v !== view);
  $('adminBox').classList.toggle('hidden', view !== 'appView');
}

function setServerPill(status, text) {
  const pill = $('serverPill');
  pill.classList.remove('online', 'offline');
  if (status) pill.classList.add(status);
  $('serverText').textContent = text;
}

function formatCell(v) {
  if (v === null || v === undefined) return { text: 'NULL', cls: 'null' };
  if (typeof v === 'object') return { text: JSON.stringify(v) };
  return { text: String(v) };
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
  }
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(state.api + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    setServerPill('offline', 'Server unreachable');
    throw new ApiError(0, { message: "Can't reach the server. Is it running?" });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path.startsWith('/admin/db')) {
    signOut('Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// ---------- server discovery ----------
async function discoverServer() {
  setServerPill(null, 'Finding server…');
  const override = new URLSearchParams(location.search).get('api') || store.get('pj_api_override', localStorage);
  let base = override;
  if (!base) {
    try {
      const r = await fetch(`${CONFIG.discoveryUrl}&t=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      const info = r.ok ? await r.json() : {};
      base = info.online ? info.apiBaseUrl : null;
    } catch {
      base = null;
    }
  }
  if (base) {
    try {
      const ping = await fetch(`${base.replace(/\/$/, '')}/admin/ping`, { signal: AbortSignal.timeout(8000) });
      if (!ping.ok) throw new Error();
      state.api = base.replace(/\/$/, '');
      setServerPill('online', state.api.replace(/^https?:\/\//, ''));
      useLogoFromDatabase();
      return true;
    } catch { /* fall through */ }
  }
  state.api = null;
  setServerPill('offline', 'Server offline');
  return false;
}

// The app logo is stored in the database (brand_assets.app_logo); the bundled icon.png is only a fallback.
function useLogoFromDatabase() {
  const url = `${state.api}/brand/app_logo?v=${Date.now()}`;
  const probe = new Image();
  probe.onload = () => {
    document.querySelectorAll('.brand-img').forEach((img) => { img.src = url; });
    $('favicon').href = url;
  };
  probe.src = url;
}

// ---------- auth ----------
function renderGoogleButton() {
  if (!window.google?.accounts?.id) return setTimeout(renderGoogleButton, 200);
  google.accounts.id.initialize({ client_id: CONFIG.googleClientId, callback: onGoogleCredential, cancel_on_tap_outside: true });
  $('googleBtn').replaceChildren();
  google.accounts.id.renderButton($('googleBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
}

async function onGoogleCredential({ credential }) {
  $('loginError').textContent = '';
  try {
    const data = await api('POST', '/admin/auth/google', { credential });
    state.token = data.token;
    state.admin = data.admin;
    store.set('pj_admin_token', data.token);
    store.set('pj_admin', JSON.stringify(data.admin));
    enterApp();
  } catch (e) {
    $('loginError').textContent = e.code === 'not_an_admin'
      ? 'This Google account is not an admin.'
      : `Sign-in failed: ${e.message}`;
  }
}

function signOut(message) {
  state.token = null;
  state.admin = null;
  store.set('pj_admin_token', null);
  store.set('pj_admin', null);
  window.google?.accounts?.id?.disableAutoSelect();
  show('loginView');
  renderGoogleButton();
  if (message) $('loginError').textContent = message;
}

async function enterApp() {
  try {
    const { admin } = await api('GET', '/admin/db/me');
    state.admin = { ...state.admin, ...admin };
    store.set('pj_admin', JSON.stringify(state.admin));
  } catch { /* older server without roles */ }
  // Viewers see no change buttons (the server refuses changes anyway).
  document.body.dataset.role = state.admin?.role ?? 'owner';
  $('adminEmail').textContent = `${state.admin?.email ?? ''}${state.admin?.role ? ` · ${state.admin.role}` : ''}`;
  $('adminPic').src = state.admin?.picture || 'icon.png';
  show('appView');
  await loadTables();
}

// ---------- tables ----------
async function loadTables() {
  try {
    const data = await api('GET', '/admin/db/tables');
    state.tables = data.tables;
    $('dbName').textContent = data.database;
    renderTableList();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderTableList() {
  $('tableList').replaceChildren(...state.tables.map((t) => el('button', {
    class: `nav-item${state.table?.name === t.name && !$('tableView').classList.contains('hidden') ? ' active' : ''}`,
    title: t.readOnly ? 'Read-only' : '',
    onclick: () => openTable(t.name),
  }, el('span', { text: `${t.readOnly ? '🔒 ' : ''}${t.name}` }), el('small', { text: `~${t.approxRows}` }))));
}

function switchPanel(panel) {
  document.querySelectorAll('#appView > section.panel').forEach((p) => p.classList.toggle('hidden', p.id !== panel));
  document.querySelectorAll('.sidebar [data-panel]').forEach((t) => t.classList.toggle('active', t.dataset.panel === panel));
  renderTableList();
}

// ---------- app logo ----------
const LOGO_TYPES = { 'image/png': 'PNG', 'image/svg+xml': 'SVG' };
let pendingLogo = null; // { mimeType, base64 }
let objectUrls = [];

function logoError(message) {
  $('logoError').textContent = message;
  $('publishLogo').disabled = true;
}

async function authedImageUrl(path) {
  const res = await fetch(state.api + path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  objectUrls.push(url);
  return url;
}

async function loadLogo() {
  try {
    const { current, history } = await api('GET', '/admin/db/brand');
    const url = `${state.api}/brand/app_logo?v=${current?.sha256 ?? Date.now()}`;
    $('currentLogoLight').src = url;
    $('currentLogoDark').src = url;
    $('currentLogoMeta').textContent = current
      ? `${LOGO_TYPES[current.mimeType] ?? current.mimeType}${current.width ? ` · ${current.width}×${current.height} px` : ''} · ${formatBytes(current.size)} · updated ${new Date(current.updatedAt).toLocaleString()}`
      : 'No logo set yet';
    renderLogoHistory(history);
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderLogoHistory(history) {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
  if (!history.length) {
    $('logoHistory').replaceChildren(el('p', { class: 'muted', text: 'No previous logos yet. Replaced logos appear here and can be restored.' }));
    return;
  }
  $('logoHistory').replaceChildren(...history.map((h) => {
    const img = el('img', { alt: 'Previous logo' });
    authedImageUrl(`/admin/db/brand/history/${h.id}`).then((u) => { img.src = u; }).catch(() => { img.alt = 'Preview unavailable'; });
    const restore = el('button', { class: 'btn ghost small', text: 'Restore', onclick: (e) => restoreLogo(h, e.currentTarget) });
    return el('div', { class: 'history-card' },
      el('div', { class: 'logo-tile light' }, img),
      el('span', { class: 'muted', text: `${LOGO_TYPES[h.mimeType] ?? h.mimeType} · ${formatBytes(h.size)}` }),
      el('span', { class: 'muted', text: `Replaced ${new Date(h.replacedAt).toLocaleString()}` }),
      restore);
  }));
}

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

// True if any pixel is (partly) transparent.
function hasTransparency(img) {
  const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = el('canvas', { width: Math.max(1, Math.round(img.naturalWidth * scale)), height: Math.max(1, Math.round(img.naturalHeight * scale)) });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

async function pickLogo(file) {
  pendingLogo = null;
  $('logoError').textContent = '';
  $('publishLogo').disabled = true;
  $('newLogoPreview').classList.add('hidden');
  if (!file) return;

  const type = LOGO_TYPES[file.type] ? file.type
    : /\.svg$/i.test(file.name) ? 'image/svg+xml' : /\.png$/i.test(file.name) ? 'image/png' : '';
  if (!type) return logoError('Choose a PNG or SVG file.');
  if (file.size > (type === 'image/png' ? 1024 * 1024 : 512 * 1024)) {
    return logoError(`This file is too large (max ${type === 'image/png' ? '1 MB' : '512 KB'}).`);
  }
  const url = URL.createObjectURL(file);
  objectUrls.push(url);
  let img;
  try {
    img = await loadImage(url);
  } catch {
    return logoError('This image could not be read.');
  }
  if (type === 'image/png') {
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w < 64 || h < 64 || w > 4096 || h > 4096) return logoError('PNG must be between 64 and 4096 pixels on each side.');
    if (!hasTransparency(img)) return logoError('This PNG has no transparent background. Export it with transparency (alpha channel) and try again.');
  }
  pendingLogo = { mimeType: type, base64: await toBase64(file) };
  $('newLogoLight').src = url;
  $('newLogoDark').src = url;
  $('newLogoMeta').textContent = `${file.name} · ${LOGO_TYPES[type]}${type === 'image/png' ? ` · ${img.naturalWidth}×${img.naturalHeight} px` : ''} · ${formatBytes(file.size)}`;
  $('newLogoPreview').classList.remove('hidden');
  $('publishLogo').disabled = false;
}

async function publishLogo() {
  if (!pendingLogo) return;
  const ok = await confirmDialog('Publish this logo?',
    'It replaces the logo in the app and the admin panel. The current logo is kept under "Previous logos" so you can restore it.');
  if (!ok) return;
  await busy($('publishLogo'), async () => {
    try {
      await api('POST', '/admin/db/brand/logo', { mimeType: pendingLogo.mimeType, data: pendingLogo.base64 });
      toast('Logo published. The app shows it the next time it opens.');
      $('logoFile').value = '';
      await pickLogo(null);
      await loadLogo();
      useLogoFromDatabase();
    } catch (e) {
      logoError(e.message);
    }
  });
}

async function restoreLogo(h, button) {
  const ok = await confirmDialog('Restore this logo?', `Replaced on ${new Date(h.replacedAt).toLocaleString()}. The current logo moves to "Previous logos".`);
  if (!ok) return;
  await busy(button, async () => {
    try {
      await api('POST', '/admin/db/brand/restore', { historyId: h.id });
      toast('Logo restored.');
      await loadLogo();
      useLogoFromDatabase();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

// ---------- change log ----------
let changes = [];

async function loadChanges() {
  try {
    const data = await api('GET', '/admin/db/changes');
    changes = data.entries;
    const r = data.running;
    $('runningVersion').textContent = r
      ? `Server running ${r.commit} · ${new Date(r.date).toLocaleString()} · ${r.subject}`
      : `${changes.length} changes`;
    const types = [...new Set(changes.map((c) => c.type))].sort();
    const current = $('changesType').value;
    $('changesType').replaceChildren(el('option', { value: '', text: 'All types' }), ...types.map((t) => el('option', { value: t, text: t })));
    $('changesType').value = types.includes(current) ? current : '';
    renderChanges();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderChanges() {
  const q = $('changesSearch').value.trim().toLowerCase();
  const type = $('changesType').value;
  const shown = changes.filter((c) => (!type || c.type === type) &&
    (!q || `${c.title} ${c.summary} ${c.area}`.toLowerCase().includes(q)));
  $('changesList').replaceChildren(...shown.map((c, i) => el('li', { style: { animationDelay: `${Math.min(i, 12) * 30}ms` } },
    el('div', { class: 'when' },
      new Date(c.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      el('span', { class: `tag ${c.type}`, text: c.type }),
      el('span', { class: 'tag area', text: c.area }),
      c.pr ? el('a', { href: `https://github.com/prasidhajagtap/pj_app/pull/${c.pr}`, target: '_blank', rel: 'noopener', text: ` PR #${c.pr}` }) : null),
    el('div', { class: 'title', text: c.title }),
    el('div', { class: 'summary', text: c.summary }))));
  if (!shown.length) $('changesList').append(el('li', { class: 'muted', text: 'No matching changes.' }));
}

async function openTable(name) {
  try {
    state.table = await api('GET', `/admin/db/tables/${encodeURIComponent(name)}`);
    state.page = { offset: 0, limit: Number($('pageSize').value), sort: null, dir: 'asc', search: '' };
    $('searchInput').value = '';
    $('tableTitle').textContent = name;
    $('addRowBtn').disabled = state.table.readOnly;
    switchPanel('tableView');
    showSkeleton($('grid'), state.table.columns.length);
    await loadRows();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function loadRows() {
  const t = state.table;
  const p = state.page;
  const q = new URLSearchParams({ limit: p.limit, offset: p.offset, dir: p.dir, search: p.search });
  if (p.sort) q.set('sort', p.sort);
  try {
    const data = await api('GET', `/admin/db/tables/${encodeURIComponent(t.name)}/rows?${q}`);
    state.rows = data.rows;
    p.sort = data.sort;
    p.dir = data.dir;
    const from = data.total ? data.offset + 1 : 0;
    const to = data.offset + data.rows.length;
    $('pageInfo').textContent = `${from}–${to} of ${data.total} rows`;
    $('tableMeta').textContent = `${t.columns.length} columns · key: ${t.primaryKey.join(', ') || 'none'}${t.readOnly ? ' · read-only' : ''}`;
    $('prevPage').disabled = data.offset === 0;
    $('nextPage').disabled = to >= data.total;
    renderTableGrid();
  } catch (e) {
    toast(e.message, 'err');
  }
}

function renderTableGrid() {
  const t = state.table;
  const canEdit = !t.readOnly && t.primaryKey.length > 0;
  const head = el('tr', {}, t.columns.map((c) => el('th', {
    class: state.page.sort === c.name ? `sorted ${state.page.dir}` : '',
    onclick: () => {
      state.page.dir = state.page.sort === c.name && state.page.dir === 'asc' ? 'desc' : 'asc';
      state.page.sort = c.name;
      state.page.offset = 0;
      loadRows();
    },
  }, c.name, el('span', { class: 'type', text: c.type + (c.key === 'PRI' ? ' · PK' : '') }))),
  canEdit ? el('th', { class: 'actions', text: '' }) : null);

  const flashKey = state.flashPk;
  state.flashPk = null;
  const keyOf = (row) => JSON.stringify(t.primaryKey.map((k) => String(row[k])));
  const body = state.rows.map((row) => el('tr', { class: flashKey && keyOf(row) === flashKey ? 'flash' : '' },
    t.columns.map((c) => {
      const f = formatCell(row[c.name]);
      return el('td', { class: [f.cls, c.key === 'PRI' ? 'pk' : ''].filter(Boolean).join(' '), title: f.text, text: f.text });
    }),
    canEdit ? el('td', { class: 'actions' },
      el('button', { class: 'row-btn', title: 'Edit', text: '✎', onclick: () => openRowDialog('edit', row) }),
      el('button', { class: 'row-btn del', title: 'Delete', text: '🗑', onclick: (e) => deleteRow(row, e.currentTarget) })) : null));

  $('grid').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
}

// ---------- row editor ----------
const LONG_TYPES = /text|json|blob/;

function openRowDialog(mode, row = null) {
  const t = state.table;
  $('rowDialogTitle').textContent = mode === 'edit' ? `Edit row in ${t.name}` : `Add row to ${t.name}`;
  $('rowError').textContent = '';
  const fields = t.columns
    .filter((c) => !(mode === 'add' && c.extra.includes('auto_increment')))
    .map((c) => {
      const original = row ? row[c.name] : undefined;
      const isNull = row ? original === null : false;
      const text = original == null ? '' : (typeof original === 'object' ? JSON.stringify(original) : String(original));
      const readonly = mode === 'edit' && c.key === 'PRI';
      const long = LONG_TYPES.test(c.dataType) || text.length > 60;
      const placeholder = c.default != null ? `default: ${c.default}` : (c.nullable ? 'NULL if empty' : c.type);
      const input = long
        ? el('textarea', { 'data-col': c.name, placeholder, readonly, disabled: isNull })
        : el('input', { type: 'text', 'data-col': c.name, placeholder, readonly, disabled: isNull });
      input.value = text;
      const nullBox = c.nullable && !readonly
        ? el('label', { class: 'null-toggle' }, el('input', {
          type: 'checkbox', 'data-null': c.name, checked: isNull,
          onchange: (e) => { input.disabled = e.target.checked; },
        }), 'NULL')
        : null;
      return el('div', { class: `field${readonly ? ' readonly' : ''}`, 'data-original': row ? JSON.stringify({ isNull, text }) : '' },
        el('label', {}, el('span', {}, el('b', { text: c.name }), ' ', nullBox), el('small', { text: c.type + (c.extra ? ` · ${c.extra}` : '') })),
        input);
    });
  $('rowFields').replaceChildren(...fields);
  const form = $('rowForm');
  form.onsubmit = async (e) => {
    e.preventDefault();
    await saveRow(mode, row);
  };
  $('rowDialog').showModal();
}

function collectValues(mode) {
  const values = {};
  for (const field of $('rowFields').children) {
    const input = field.querySelector('[data-col]');
    if (input.readOnly) continue;
    const col = input.dataset.col;
    const isNull = field.querySelector('[data-null]')?.checked ?? false;
    if (mode === 'edit') {
      const orig = JSON.parse(field.dataset.original);
      if (orig.isNull === isNull && (isNull || orig.text === input.value)) continue; // unchanged
    } else if (!isNull && input.value === '') {
      continue; // let the column default / NULL apply
    }
    values[col] = isNull ? null : input.value;
  }
  return values;
}

async function saveRow(mode, row) {
  const t = state.table;
  const values = collectValues(mode);
  if (!Object.keys(values).length) {
    if (mode === 'edit') { $('rowDialog').close(); return; }
    $('rowError').textContent = 'Fill in at least one field.';
    return;
  }
  await busy($('rowSave'), async () => {
    try {
      if (mode === 'edit') {
        const pk = Object.fromEntries(t.primaryKey.map((k) => [k, row[k]]));
        await api('PATCH', `/admin/db/tables/${encodeURIComponent(t.name)}/rows`, { pk, values });
        state.flashPk = JSON.stringify(t.primaryKey.map((k) => String(row[k])));
        toast('Row updated');
      } else {
        const r = await api('POST', `/admin/db/tables/${encodeURIComponent(t.name)}/rows`, { values });
        if (t.primaryKey.length === 1 && r.insertId && r.insertId !== '0') state.flashPk = JSON.stringify([r.insertId]);
        toast(`Row added${r.insertId && r.insertId !== '0' ? ` (id ${r.insertId})` : ''}`);
      }
      $('rowDialog').close();
      await loadRows();
    } catch (e) {
      $('rowError').textContent = e.message;
    }
  });
}

async function deleteRow(row, button) {
  const t = state.table;
  const pk = Object.fromEntries(t.primaryKey.map((k) => [k, row[k]]));
  const ok = await confirmDialog('Delete this row?', `From ${t.name}. This cannot be undone.`, JSON.stringify(pk, null, 2));
  if (!ok) return;
  await busy(button, async () => {
    try {
      await api('DELETE', `/admin/db/tables/${encodeURIComponent(t.name)}/rows`, { pk });
      toast('Row deleted');
      await loadRows();
    } catch (e) {
      toast(e.message, 'err');
    }
  });
}

function confirmDialog(title, text, code) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmCode').textContent = code ?? '';
  $('confirmCode').classList.toggle('hidden', !code);
  const dlg = $('confirmDialog');
  dlg.showModal();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); $('confirmOk').onclick = null; dlg.onclose = null; resolve(v); };
    $('confirmOk').onclick = () => done(true);
    dlg.onclose = () => resolve(false);
  });
}

// ---------- SQL editor ----------
const READ_SQL = /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(select|show|describe|desc|explain|with)\b/i;

function sqlHistory() {
  try { return JSON.parse(store.get('pj_sql_history', localStorage) || '[]'); } catch { return []; }
}

function renderHistory() {
  $('historySelect').replaceChildren(el('option', { value: '', text: 'History…' }),
    ...sqlHistory().map((q, i) => el('option', { value: String(i), text: q.replace(/\s+/g, ' ').slice(0, 70) })));
}

async function runSql() {
  const sql = $('sqlInput').value.trim();
  if (!sql) return;
  const isWrite = !READ_SQL.test(sql);
  if (isWrite && !(await confirmDialog('Run a query that changes data?', 'This statement can modify or delete data.', sql))) return;

  const status = $('sqlStatus');
  status.className = 'muted sql-status';
  status.textContent = 'Running…';
  $('runSql').disabled = true;
  try {
    const r = await api('POST', '/admin/db/sql', { sql, confirmWrite: isWrite });
    store.set('pj_sql_history', JSON.stringify([sql, ...sqlHistory().filter((q) => q !== sql)].slice(0, 25)), localStorage);
    renderHistory();
    status.className = 'sql-status ok';
    if (r.kind === 'rows') {
      status.textContent = `${r.rowCount} row(s) in ${r.ms} ms${r.truncated ? ' · showing first 1000' : ''}`;
      const head = el('tr', {}, r.columns.map((c) => el('th', { text: c })));
      const body = r.rows.map((row) => el('tr', {}, r.columns.map((c) => {
        const f = formatCell(row[c]);
        return el('td', { class: f.cls ?? '', title: f.text, text: f.text });
      })));
      $('sqlGrid').replaceChildren(el('thead', {}, head), el('tbody', {}, body));
    } else {
      status.textContent = `${r.affectedRows} row(s) affected in ${r.ms} ms${r.insertId && r.insertId !== '0' ? ` · insert id ${r.insertId}` : ''}${r.info ? ` · ${r.info}` : ''}`;
      $('sqlGrid').replaceChildren();
      loadTables();
    }
  } catch (e) {
    status.className = 'sql-status err';
    status.textContent = e.message;
  } finally {
    $('runSql').disabled = false;
  }
}

// ---------- wiring ----------
let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.page.search = e.target.value; state.page.offset = 0; loadRows(); }, 300);
});
$('reloadRows').onclick = (e) => busy(e.currentTarget, loadRows);
$('addRowBtn').onclick = () => openRowDialog('add');
$('pageSize').onchange = (e) => { state.page.limit = Number(e.target.value); state.page.offset = 0; loadRows(); };
$('prevPage').onclick = (e) => { state.page.offset = Math.max(0, state.page.offset - state.page.limit); busy(e.currentTarget, loadRows); };
$('nextPage').onclick = (e) => { state.page.offset += state.page.limit; busy(e.currentTarget, loadRows); };
$('refreshTables').onclick = (e) => busy(e.currentTarget, loadTables);
$('sqlTab').onclick = () => { switchPanel('sqlView'); $('sqlInput').focus(); };
$('changesTab').onclick = () => { switchPanel('changesView'); busy($('reloadChanges'), loadChanges); };
$('reloadChanges').onclick = (e) => busy(e.currentTarget, loadChanges);
$('logoTab').onclick = () => { switchPanel('logoView'); busy($('reloadLogo'), loadLogo); };
$('reloadLogo').onclick = (e) => busy(e.currentTarget, loadLogo);
$('logoFile').onchange = (e) => pickLogo(e.target.files[0]);
$('logoDrop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('logoFile').click(); } });
$('logoDrop').addEventListener('dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); });
$('logoDrop').addEventListener('dragleave', (e) => e.currentTarget.classList.remove('over'));
$('logoDrop').addEventListener('drop', (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); pickLogo(e.dataTransfer.files[0]); });
$('publishLogo').onclick = publishLogo;
$('changesSearch').addEventListener('input', renderChanges);
$('changesType').onchange = renderChanges;
$('runSql').onclick = () => busy($('runSql'), runSql);
$('historySelect').onchange = (e) => { if (e.target.value !== '') $('sqlInput').value = sqlHistory()[Number(e.target.value)]; e.target.value = ''; };
$('sqlInput').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); busy($('runSql'), runSql); }
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
});
document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
$('signOutBtn').onclick = () => signOut();
$('retryBtn').onclick = (e) => busy(e.currentTarget, start);
$('serverPill').onclick = (e) => busy(e.currentTarget, start);

async function start() {
  const online = await discoverServer();
  if (!online) return show('offlineView');
  if (state.token) {
    try {
      await api('GET', '/admin/db/tables');
      return enterApp();
    } catch { /* session expired: fall through to login */ }
  }
  show('loginView');
  renderGoogleButton();
}

renderHistory();
start();
