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
let current = { user: null, username: null, playingServerId: null, phase: null, playtime: {}, skin: '' };
let editingName = false;
let page = 'servers'; // 'servers' | 'settings'
let pingTimer = null;
let pingResults = {};
let installState = {}; // serverId -> 'not-installed' | 'installed' | 'update'
const cards = {}; // serverId -> { pill, btn, soon, ptEl, instPill }

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

function fmtPlaytime(ms) {
  const min = Math.floor((ms || 0) / 60000);
  if (min < 1) return 'Aún no has jugado';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

function refreshPlaytimes() {
  Object.entries(cards).forEach(([id, c]) => {
    if (c.ptEl) c.ptEl.textContent = fmtPlaytime((current.playtime || {})[id]);
  });
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

  // Insignia del rol de Discord (la más importante que tenga el jugador)
  const badge = current.user.badge;
  const node = $('side-role');
  if (badge) {
    node.textContent = badge.label;
    node.style.setProperty('--role', badge.color);
    node.hidden = false;
  } else {
    node.hidden = true;
  }
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
    let instPill = null;
    if (soon) {
      banner.append(lockIcon());
    } else {
      instPill = el('span', 'pill install st-none');
      instPill.hidden = true; // aparece cuando se conoce el estado
      banner.append(instPill);
    }

    const body = el('div', 'card-body');
    body.append(el('h3', null, server.name), el('p', 'desc', server.description));

    const meta = el('dl', 'meta');
    let ptEl = null;
    let cardPlayers = null;
    if (soon) {
      meta.append(metaItem('Versión', 'Por anunciar'), metaItem('Estado', 'En desarrollo'));
    } else {
      const loader = LOADER_NAMES[server.loader] || '';
      meta.append(
        metaItem('Versión', [server.minecraftVersion, loader].filter(Boolean).join(' · ')),
        metaItem('Jugadores', 'Comprobando…')
      );
      cardPlayers = meta.lastChild.querySelector('dd');
      const pt = metaItem('Tiempo jugado', fmtPlaytime((current.playtime || {})[server.id]));
      pt.classList.add('wide');
      ptEl = pt.querySelector('dd');
      meta.append(pt);
    }
    body.append(meta);

    const action = el('div', 'card-action');
    const btn = el('button', soon ? 'btn btn-soon' : 'btn btn-primary', soon ? 'Próximamente' : 'Jugar');
    btn.disabled = soon;
    if (!soon) btn.addEventListener('click', () => play(server));
    action.append(btn);

    card.append(banner, body, action);
    grid.append(card);
    cards[server.id] = { pill, btn, soon, ptEl, instPill, playersEl: cardPlayers };
  });

  applyPing();
  applyInstall();
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
      if (c.playersEl) c.playersEl.textContent = res.max ? `${res.players} de ${res.max} conectados` : 'En línea';
    } else {
      c.pill.className = 'pill offline';
      c.pill.textContent = 'Sin conexión';
      if (c.playersEl) c.playersEl.textContent = 'Servidor fuera de línea';
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

// --- Estado de instalación --------------------------------------------------

const INSTALL_VIEW = {
  'not-installed': { text: 'No instalado', cls: 'st-none', play: 'Instalar y jugar' },
  installed: { text: 'Instalado', cls: 'st-ok', play: 'Jugar' },
  update: { text: 'Actualización disponible', cls: 'st-update', play: 'Actualizar y jugar' }
};

function playLabel(serverId) {
  const view = INSTALL_VIEW[installState[serverId]];
  return view ? view.play : 'Jugar';
}

function applyInstall() {
  if (!cfg) return;
  cfg.servers.forEach((server) => {
    const c = cards[server.id];
    if (!c || c.soon || !c.instPill) return;
    const busy = current.playingServerId === server.id && current.phase === 'preparing';
    const view = busy ? { text: 'Preparando…', cls: 'st-busy' } : INSTALL_VIEW[installState[server.id]];
    if (!view) {
      c.instPill.hidden = true;
      return;
    }
    c.instPill.hidden = false;
    c.instPill.className = `pill install ${view.cls}`;
    c.instPill.textContent = view.text;
  });
}

async function refreshInstall() {
  try {
    installState = (await window.api.getInstallStatus()) || {};
  } catch {
    return; // se conserva el último estado conocido
  }
  applyInstall();
  syncPlayingUi();
}

// --- Jugar ------------------------------------------------------------------

function syncPlayingUi() {
  const id = current.playingServerId;
  Object.entries(cards).forEach(([serverId, c]) => {
    if (c.soon) return;
    c.btn.disabled = !!id;
    c.btn.textContent = serverId === id ? (current.phase === 'playing' ? 'En juego' : 'Iniciando…') : playLabel(serverId);
  });
  const server = id && cfg.servers.find((s) => s.id === id);
  if (server) {
    $('dock').hidden = false;
    $('dock-title').textContent = current.phase === 'playing' ? `Jugando ${server.name}` : `Iniciando ${server.name}`;
  } else if (!$('progress-text').textContent) {
    $('dock').hidden = true;
  }
}

async function play(server) {
  if (current.playingServerId) return;
  showError($('play-error'), '');
  $('crash-box').hidden = true;
  $('log').textContent = '';
  $('progress-text').textContent = 'Preparando…';
  $('bar-fill').className = 'bar-fill indeterminate';
  current.playingServerId = server.id;
  current.phase = 'preparing';
  syncPlayingUi();
  applyInstall();

  const res = await window.api.play(server.id);
  if (!res.ok) {
    current.playingServerId = null;
    current.phase = null;
    applyInstall();
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
  refreshInstall();
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
  current.playtime = res.playtime || {};
  current.skin = res.skin || '';
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
  current = { user: null, username: null, playingServerId: current.playingServerId, phase: current.phase, playtime: {}, skin: '' };
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
  'set-rpc': 'richPresence',
  'set-notify': 'notifications'
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
  updateRamNotes();
}

function updateRamNotes() {
  if (!settingsState) return;
  const { systemRamGb: sys, recommendedRamGb: rec } = settingsState;
  const v = Number($('set-ram').value);
  $('ram-hint').textContent = `Tu equipo tiene ${sys} GB. Recomendado para este pack: ${rec} GB.`;
  const risky = v > Math.floor(sys * 0.75);
  $('ram-warn').hidden = !risky;
  if (risky) {
    $('ram-warn').textContent = `Estás asignando ${v} GB de ${sys} GB. Deja memoria libre para Windows o el equipo puede ir lento.`;
  }
  $('btn-ram-rec').hidden = v === rec;
}

function paintSkin(name) {
  const img = $('skin-preview');
  showError($('skin-error'), '');
  if (name) {
    img.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
  $('btn-skin-copy').hidden = !name;
}

function applySettingsToUi(payload) {
  settingsState = payload;
  const { settings, systemRamGb } = payload;

  const r = $('set-ram');
  const max = Math.max(2, Math.min(32, systemRamGb));
  r.max = String(max);
  r.value = String(Math.max(2, Math.min(settings.ramMax, max)));
  paintRange();

  $('set-java').value = settings.javaPath;
  $('set-w').value = settings.winWidth || '';
  $('set-h').value = settings.winHeight || '';
  $('set-jvm').value = settings.jvmArgs || '';
  Object.entries(TOGGLES).forEach(([id, key]) => {
    $(id).checked = !!settings[key];
  });
}

async function loadSettingsView() {
  showError($('java-error'), '');
  showError($('adv-error'), '');
  applySettingsToUi(await window.api.getSettings());
  $('set-skin').value = current.skin || '';
  paintSkin(current.skin);
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

$('btn-ram-rec').addEventListener('click', () => {
  if (settingsState) saveSetting({ ramMax: settingsState.recommendedRamGb });
});

async function saveAdvanced(partial) {
  showError($('adv-error'), '');
  const res = await saveSetting(partial);
  if (!res.ok) {
    showError($('adv-error'), res.error);
    applySettingsToUi(await window.api.getSettings());
  }
}

['set-w', 'set-h'].forEach((id) => {
  $(id).addEventListener('change', () =>
    saveAdvanced({ winWidth: Number($('set-w').value) || 0, winHeight: Number($('set-h').value) || 0 })
  );
});
$('set-jvm').addEventListener('change', () => saveAdvanced({ jvmArgs: $('set-jvm').value }));
$('set-jvm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('set-jvm').blur();
});

// Skin
$('skin-preview').addEventListener('error', () => {
  $('skin-preview').hidden = true;
  showError($('skin-error'), 'No se pudo cargar la vista previa de esa skin.');
});

async function saveSkin() {
  showError($('skin-error'), '');
  const res = await window.api.setSkin($('set-skin').value);
  if (!res.ok) return showError($('skin-error'), res.error);
  current.skin = res.skin;
  $('set-skin').value = res.skin;
  paintSkin(res.skin);
  toast(res.skin ? 'Skin guardada' : 'Skin quitada');
}
$('btn-skin-save').addEventListener('click', saveSkin);
$('set-skin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveSkin();
});
$('btn-skin-copy').addEventListener('click', async () => {
  if (!current.skin) return;
  await window.api.copyText(`/skin set ${current.skin}`);
  toast('Comando copiado');
});

$('btn-open-folder').addEventListener('click', () => window.api.openGameFolder());
$('btn-repair').addEventListener('click', async () => {
  const btn = $('btn-repair');
  if (!btn.dataset.confirm) {
    btn.dataset.confirm = '1';
    btn.textContent = 'Pulsa otra vez para confirmar';
    setTimeout(() => { delete btn.dataset.confirm; btn.textContent = 'Reparar instalación'; }, 4000);
    return;
  }
  delete btn.dataset.confirm;
  btn.textContent = 'Reparar instalación';
  const res = await window.api.repairInstall();
  if (res.ok) {
    toast('Listo: se reinstalará al pulsar Jugar');
    refreshInstall();
  } else {
    showError($('repair-error'), res.error);
  }
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

window.api.onPlayState(({ playing, serverId, phase }) => {
  current.playingServerId = playing ? serverId : null;
  current.phase = playing ? phase || 'preparing' : null;
  if (!playing) $('dock-title').textContent = 'Sesión finalizada';
  if (cfg) {
    syncPlayingUi();
    applyInstall();
    if (!(playing && current.phase === 'preparing')) refreshInstall(); // ya se escribió el marcador de instalación
  }
});

window.api.onPlaytime((map) => {
  current.playtime = map || {};
  refreshPlaytimes();
});

window.api.onCrash(({ serverName, code, hasReport, hint }) => {
  $('crash-title').textContent = `${serverName} se cerró con un error (código ${code})`;
  $('crash-hint').textContent = hint || 'Copia el registro y envíaselo al staff para que lo revisen.';
  $('btn-crash-report').hidden = !hasReport;
  $('crash-box').hidden = false;
});

$('btn-crash-copy').addEventListener('click', async () => {
  const res = await window.api.copyCrashLog();
  toast(res.ok ? 'Registro copiado' : 'No hay registro para copiar');
});
$('btn-crash-report').addEventListener('click', () => window.api.openCrashReport());
$('btn-crash-close').addEventListener('click', () => {
  $('crash-box').hidden = true;
});

// --- Tutorial de primer inicio ---------------------------------------------

const TOUR = [
  { title: 'Bienvenido a Dimensional Studio', text: 'Este es el launcher oficial de nuestros eventos de Minecraft. Te explicamos cómo empezar en unos pasos.' },
  { title: 'Inicia sesión con Discord', text: 'Tu cuenta de Discord es tu identidad en el launcher. Solo la usamos para saber quién eres; no guardamos contraseñas.' },
  { title: 'Elige tu nombre de jugador', text: 'Será tu nombre dentro del juego (3 a 16 caracteres: letras, números y guion bajo). Puedes cambiarlo cuando quieras con el botón Cambiar, arriba a la izquierda.' },
  { title: 'Elige un servidor y pulsa Jugar', text: 'El launcher instala Java, los mods y todo lo necesario por ti y entra directo al servidor. La primera vez puede tardar unos minutos.' },
  { title: 'Ajusta tu experiencia', text: 'En Configuración puedes cambiar la memoria RAM, la resolución y tu skin. Desde ahí también puedes volver a ver este tutorial.' }
];
let tourIdx = 0;

function renderTour() {
  const step = TOUR[tourIdx];
  const last = tourIdx === TOUR.length - 1;
  $('tour-step').textContent = `Paso ${tourIdx + 1} de ${TOUR.length}`;
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  $('tour-back').hidden = tourIdx === 0;
  $('tour-skip').hidden = last;
  $('tour-next').textContent = last ? 'Empezar' : 'Siguiente';
  const dots = $('tour-dots');
  dots.textContent = '';
  TOUR.forEach((_, i) => dots.append(el('i', i === tourIdx ? 'on' : '')));
}

function openTour() {
  tourIdx = 0;
  renderTour();
  $('tour').hidden = false;
}

function closeTour() {
  $('tour').hidden = true;
  window.api.tourDone();
}

$('tour-next').addEventListener('click', () => {
  if (tourIdx >= TOUR.length - 1) return closeTour();
  tourIdx += 1;
  renderTour();
});
$('tour-back').addEventListener('click', () => {
  if (tourIdx > 0) tourIdx -= 1;
  renderTour();
});
$('tour-skip').addEventListener('click', closeTour);
$('btn-tour').addEventListener('click', openTour);

let updateBtnMode = 'install'; // 'install' (Reiniciar y actualizar) | 'retry' (Reintentar)

window.api.onUpdate((u) => {
  const box = $('update-box');
  const bar = $('update-bar');
  const btn = $('btn-update');
  box.classList.toggle('err', u.status === 'error');
  if (u.status === 'downloading') {
    box.hidden = false;
    bar.hidden = false;
    btn.hidden = true;
    $('update-text').textContent = `Descargando actualización${u.version ? ' ' + u.version : ''}… ${u.percent || 0}%`;
    $('update-fill').style.width = `${u.percent || 0}%`;
  } else if (u.status === 'ready') {
    updateBtnMode = 'install';
    box.hidden = false;
    bar.hidden = true;
    btn.hidden = false;
    btn.textContent = 'Reiniciar y actualizar';
    $('update-text').textContent = `Nueva versión ${u.version} lista para instalar.`;
  } else if (u.status === 'error') {
    // Antes el aviso desaparecía sin explicar nada: ahora dice qué pasó y deja reintentar
    updateBtnMode = 'retry';
    box.hidden = false;
    bar.hidden = true;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Reintentar';
    $('update-text').textContent = u.message || 'No se pudo completar la actualización.';
  } else if (u.status === 'checking') {
    if (u.manual) {
      box.hidden = false;
      bar.hidden = true;
      btn.hidden = true;
      $('update-text').textContent = 'Buscando actualizaciones…';
    }
  } else {
    box.hidden = true;
    if (u.manual) toast('Ya tienes la última versión');
  }
});

$('btn-update').addEventListener('click', async () => {
  const res = updateBtnMode === 'retry' ? await window.api.retryUpdate() : await window.api.installUpdate();
  if (res && !res.ok) {
    $('update-text').textContent = res.error;
    $('btn-update').hidden = updateBtnMode !== 'retry';
  }
});

// --- Novedades tras actualizar ----------------------------------------------

async function checkWhatsNew() {
  let info = null;
  try {
    info = await window.api.getWhatsNew();
  } catch {
    return;
  }
  if (!info || !info.show) return;
  const items = Array.isArray(info.items) ? info.items : [];
  $('wn-title').textContent = `Actualizado a la ${info.version}`;
  const list = $('wn-list');
  list.textContent = '';
  items.forEach((text) => list.append(el('li', null, text)));
  list.hidden = !items.length;
  $('wn-empty').hidden = items.length > 0;
  $('whatsnew').hidden = false;
}

$('wn-ok').addEventListener('click', () => {
  $('whatsnew').hidden = true;
  window.api.whatsNewSeen();
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
  current = {
    user: s.user,
    username: s.username,
    playingServerId: s.playingServerId,
    phase: null,
    playtime: s.playtime || {},
    skin: s.skin || ''
  };
  route();
  if (!s.tourDone) openTour();
  checkWhatsNew();
})();
