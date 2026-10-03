const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const views = {
  login: $('view-login'),
  name: $('view-name'),
  servers: $('view-servers'),
  settings: $('view-settings')
};

let cfg = null;
let current = { user: null, username: null, playingServerId: null };
let editingName = false;
let page = 'servers'; // 'servers' | 'settings'
let pingTimer = null;
let pingResults = {};
const cards = {}; // serverId -> { pill, btn }

const LOADER_NAMES = { forge: 'Forge', fabric: 'Fabric', vanilla: 'Vanilla' };

// --- Utilidades -------------------------------------------------------------

function show(view) {
  Object.entries(views).forEach(([key, node]) => {
    node.hidden = key !== view;
  });
}

function showError(node, message) {
  node.textContent = message || '';
  node.hidden = !message;
}

function lockIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'banner-icon');
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('x', '5');
  body.setAttribute('y', '11');
  body.setAttribute('width', '14');
  body.setAttribute('height', '9');
  body.setAttribute('rx', '2');
  const shackle = document.createElementNS(SVG_NS, 'path');
  shackle.setAttribute('d', 'M8 11V8a4 4 0 0 1 8 0v3');
  svg.append(body, shackle);
  return svg;
}

function metaItem(label, value) {
  const wrap = el('div');
  wrap.append(el('dt', null, label), el('dd', null, value));
  return wrap;
}

// --- Perfil -----------------------------------------------------------------

function fillProfile() {
  $('side-avatar').src = current.user.avatarUrl;
  $('side-display').textContent = current.user.displayName;
  $('side-handle').textContent = `@${current.user.username}`;
  $('side-ingame').textContent = current.username || '—';
}

// --- Servidores -------------------------------------------------------------

function renderServers() {
  const grid = $('server-grid');
  grid.textContent = '';
  Object.keys(cards).forEach((k) => delete cards[k]);

  cfg.servers.forEach((server) => {
    const soon = server.status !== 'available';
    const card = el('article', soon ? 'server-card soon' : 'server-card');
    if (server.accent && server.accent.length >= 2) {
      card.style.setProperty('--a1', server.accent[0]);
      card.style.setProperty('--a2', server.accent[1]);
    }

    const banner = el('div', 'banner');
    const pill = el('span', soon ? 'pill soon' : 'pill checking', soon ? 'Próximamente' : 'Comprobando…');
    banner.append(pill);
    if (soon) banner.append(lockIcon());

    const body = el('div', 'card-body');
    body.append(el('h3', null, server.name), el('p', 'desc', server.description));

    const meta = el('dl', 'meta');
    if (soon) {
      meta.append(metaItem('Versión', 'Por anunciar'), metaItem('Estado', 'En desarrollo'));
    } else {
      const loader = LOADER_NAMES[server.loader] || '';
      meta.append(
        metaItem('Versión', [server.minecraftVersion, loader].filter(Boolean).join(' · ')),
        metaItem('Dirección', server.port === 25565 ? server.ip : `${server.ip}:${server.port}`)
      );
    }
    body.append(meta);

    const action = el('div', 'card-action');
    const btn = el('button', soon ? 'btn btn-soon' : 'btn btn-primary', soon ? 'Próximamente' : 'Jugar');
    btn.disabled = soon;
    if (!soon) btn.addEventListener('click', () => play(server));
    action.append(btn);

    card.append(banner, body, action);
    grid.append(card);
    cards[server.id] = { pill, btn, soon };
  });

  applyPing();
  syncPlayingUi();
}

function applyPing() {
  cfg.servers.forEach((server) => {
    const c = cards[server.id];
    if (!c || c.soon) return;
    const res = pingResults[server.id];
    if (!res) return; // se mantiene "Comprobando…"
    if (res.online) {
      c.pill.className = 'pill online';
      c.pill.textContent = res.max ? `En línea · ${res.players}/${res.max}` : 'En línea';
    } else {
      c.pill.className = 'pill offline';
      c.pill.textContent = 'Sin conexión';
    }
  });
}

async function refreshPing() {
  try {
    pingResults = await window.api.pingServers();
    applyPing();
  } catch {
    /* sin red: se conserva el último estado */
  }
}

function startPing() {
  stopPing();
  refreshPing();
  pingTimer = setInterval(refreshPing, 30000);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

// --- Jugar ------------------------------------------------------------------

function syncPlayingUi() {
  const id = current.playingServerId;
  Object.entries(cards).forEach(([serverId, c]) => {
    if (c.soon) return;
    c.btn.disabled = !!id;
    c.btn.textContent = serverId === id ? 'Iniciando…' : 'Jugar';
  });
  const server = id && cfg.servers.find((s) => s.id === id);
  if (server) {
    $('dock').hidden = false;
    $('dock-title').textContent = `Iniciando ${server.name}`;
  } else if (!$('progress-text').textContent) {
    $('dock').hidden = true;
  }
}

async function play(server) {
  if (current.playingServerId) return;
  showError($('play-error'), '');
  $('log').textContent = '';
  $('progress-text').textContent = 'Preparando…';
  $('bar-fill').className = 'bar-fill indeterminate';
  current.playingServerId = server.id;
  syncPlayingUi();

  const res = await window.api.play(server.id);
  if (!res.ok) {
    current.playingServerId = null;
    $('progress-text').textContent = '';
    $('dock').hidden = true;
    syncPlayingUi();
    showError($('play-error'), res.error);
  }
}

// --- Rutas ------------------------------------------------------------------

function setNav(active) {
  $('nav-servers').classList.toggle('active', active === 'servers');
  $('nav-settings').classList.toggle('active', active === 'settings');
}

function route() {
  const sidebar = $('sidebar');

  if (!current.user) {
    sidebar.hidden = true;
    stopPing();
    return show('login');
  }
  setNav('servers');

  sidebar.hidden = false;
  fillProfile();

  if (!current.username || editingName) {
    stopPing();
    showError($('name-error'), '');
    $('input-name').value = editingName ? current.username || '' : '';
    $('btn-cancel-name').hidden = !current.username;
    show('name');
    $('input-name').focus();
    return;
  }

  if (page === 'settings') {
    stopPing();
    setNav('settings');
    show('settings');
    loadSettingsView();
    return;
  }

  setNav('servers');
  showError($('play-error'), '');
  renderServers();
  show('servers');
  startPing();
}

// --- Acciones ---------------------------------------------------------------

$('btn-discord').addEventListener('click', async () => {
  const btn = $('btn-discord');
  btn.disabled = true;
  btn.textContent = 'Esperando autorización…';
  $('login-hint').hidden = false;
  showError($('login-error'), '');
  const res = await window.api.loginDiscord();
  btn.disabled = false;
  btn.textContent = 'Continuar con Discord';
  $('login-hint').hidden = true;
  if (!res.ok) return showError($('login-error'), res.error);
  current.user = res.user;
  current.username = res.username;
  editingName = false;
  route();
});

$('btn-cancel-login').addEventListener('click', () => window.api.cancelLogin());

async function saveName() {
  showError($('name-error'), '');
  const res = await window.api.setUsername($('input-name').value);
  if (!res.ok) return showError($('name-error'), res.error);
  current.username = res.username;
  editingName = false;
  route();
}

$('btn-save-name').addEventListener('click', saveName);
$('input-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveName();
});

$('btn-change-name').addEventListener('click', () => {
  editingName = true;
  route();
});

$('btn-cancel-name').addEventListener('click', () => {
  editingName = false;
  route();
});

$('btn-logout').addEventListener('click', async () => {
  await window.api.logout();
  current = { user: null, username: null, playingServerId: current.playingServerId };
  editingName = false;
  page = 'servers';
  route();
});

$('nav-servers').addEventListener('click', () => {
  if (current.user && current.username) {
    editingName = false;
    page = 'servers';
    route();
  }
});

$('nav-settings').addEventListener('click', () => {
  if (current.user && current.username) {
    editingName = false;
    page = 'settings';
    route();
  }
});

$('btn-invite').addEventListener('click', () => window.api.openInvite());
$('btn-log').addEventListener('click', () => {
  $('log-drawer').hidden = !$('log-drawer').hidden;
});
$('btn-log-close').addEventListener('click', () => {
  $('log-drawer').hidden = true;
});

$('win-min').addEventListener('click', () => window.api.minimize());
$('win-close').addEventListener('click', () => window.api.close());

// --- Configuración ----------------------------------------------------------

let settingsState = null;
let toastTimer = null;

const TOGGLES = {
  'set-autojoin': 'autoJoin',
  'set-fullscreen': 'fullscreen',
  'set-minimize': 'minimizeOnPlay',
  'set-rpc': 'richPresence'
};

function toast(message = 'Cambios guardados') {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 1800);
}

function paintRange() {
  const r = $('set-ram');
  const pct = ((r.value - r.min) / (r.max - r.min)) * 100;
  r.style.setProperty('--fill', `${pct}%`);
  $('set-ram-out').textContent = `${r.value} GB`;
}

function applySettingsToUi(payload) {
  settingsState = payload;
  const { settings, systemRamGb } = payload;

  const r = $('set-ram');
  const max = Math.max(2, Math.min(32, systemRamGb));
  r.max = String(max);
  r.value = String(Math.max(2, Math.min(settings.ramMax, max)));
  paintRange();
  $('ram-hint').textContent = `Tu equipo tiene ${systemRamGb} GB. Para Forge se recomiendan entre 4 y 6 GB.`;

  $('set-java').value = settings.javaPath;
  Object.entries(TOGGLES).forEach(([id, key]) => {
    $(id).checked = !!settings[key];
  });
}

async function loadSettingsView() {
  showError($('java-error'), '');
  applySettingsToUi(await window.api.getSettings());
}

async function saveSetting(partial) {
  const res = await window.api.saveSettings(partial);
  if (res.ok) {
    applySettingsToUi(res);
    toast();
  }
  return res;
}

$('set-ram').addEventListener('input', paintRange);
$('set-ram').addEventListener('change', () => saveSetting({ ramMax: Number($('set-ram').value) }));

Object.entries(TOGGLES).forEach(([id, key]) => {
  $(id).addEventListener('change', async () => {
    const res = await saveSetting({ [key]: $(id).checked });
    if (!res.ok) $(id).checked = !!settingsState.settings[key];
  });
});

async function saveJava(value) {
  showError($('java-error'), '');
  const res = await saveSetting({ javaPath: value });
  if (!res.ok) {
    showError($('java-error'), res.error);
    $('set-java').value = settingsState.settings.javaPath;
  }
}

$('set-java').addEventListener('change', () => {
  if ($('set-java').value.trim() !== settingsState.settings.javaPath) saveJava($('set-java').value);
});
$('set-java').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('set-java').blur();
});
$('btn-java-pick').addEventListener('click', async () => {
  const { path } = await window.api.pickJava();
  if (path) {
    $('set-java').value = path;
    saveJava(path);
  }
});
$('btn-java-auto').addEventListener('click', () => {
  $('set-java').value = '';
  if (settingsState.settings.javaPath) saveJava('');
});

$('btn-reset-settings').addEventListener('click', async () => {
  const res = await window.api.resetSettings();
  if (res.ok) {
    applySettingsToUi(res);
    showError($('java-error'), '');
    toast('Valores restablecidos');
  }
});

// --- Eventos del proceso principal -----------------------------------------

window.api.onProgress(({ text, percent }) => {
  $('dock').hidden = false;
  $('progress-text').textContent = text || '';
  const fill = $('bar-fill');
  if (typeof percent === 'number') {
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  } else {
    fill.className = 'bar-fill indeterminate';
    fill.style.width = '';
  }
});

window.api.onLog((line) => {
  const log = $('log');
  log.textContent += line + '\n';
  if (log.textContent.length > 20000) log.textContent = log.textContent.slice(-15000);
  log.scrollTop = log.scrollHeight;
});

window.api.onPlayState(({ playing, serverId }) => {
  current.playingServerId = playing ? serverId : null;
  if (!playing) $('dock-title').textContent = 'Sesión finalizada';
  if (cfg) syncPlayingUi();
});

window.api.onUpdate((u) => {
  const box = $('update-box');
  const bar = $('update-bar');
  const btn = $('btn-update');
  if (u.status === 'downloading') {
    box.hidden = false;
    bar.hidden = false;
    btn.hidden = true;
    $('update-text').textContent = `Descargando actualización${u.version ? ' ' + u.version : ''}… ${u.percent || 0}%`;
    $('update-fill').style.width = `${u.percent || 0}%`;
  } else if (u.status === 'ready') {
    box.hidden = false;
    bar.hidden = true;
    btn.hidden = false;
    $('update-text').textContent = `Nueva versión ${u.version} lista para instalar.`;
  } else if (u.status !== 'checking') {
    box.hidden = true;
  }
});

$('btn-update').addEventListener('click', async () => {
  const res = await window.api.installUpdate();
  if (res && !res.ok) $('update-text').textContent = res.error;
});

// --- Inicio -----------------------------------------------------------------

(async function init() {
  const s = await window.api.getState();
  cfg = s.config;
  document.title = `${cfg.studioName} Launcher`;
  $('brand-sub').textContent = cfg.tagline;
  $('app-version').textContent = `${cfg.studioName} · v${cfg.version}`;
  $('settings-version').textContent = `${cfg.studioName} · versión ${cfg.version}`;
  $('btn-invite').hidden = !cfg.hasInvite;
  current = { user: s.user, username: s.username, playingServerId: s.playingServerId };
  route();
})();
