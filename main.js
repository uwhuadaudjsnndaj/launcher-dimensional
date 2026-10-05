const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null; // sin actualizaciones si la dependencia no está instalada
}
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { Client } = require('minecraft-launcher-core');
const { pingServer } = require('./ping');
const cfg = require('./config.json');
const pkg = require('./package.json');

// Datos que NO van al repositorio público (webhook del registro). Se crea con private.json
// en local o desde el secreto DISCORD_WEBHOOK_URL al construir en GitHub Actions.
let privateCfg = {};
try {
  privateCfg = require('./private.json');
} catch {
  privateCfg = {};
}

// Una sola ventana del launcher: evita puertos de login ocupados y juegos duplicados
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

// Necesario en Windows para que las notificaciones nativas muestren el nombre y el icono del launcher
if (process.platform === 'win32') {
  app.setAppUserModelId((pkg.build && pkg.build.appId) || 'com.dimensionalstudio.launcher');
}

let RPC = null;
try {
  RPC = require('discord-rpc');
} catch {
  RPC = null; // sin Rich Presence si la dependencia no está instalada
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
const ROOT = path.join(app.getPath('appData'), '.dimensionalstudio');
const STATE_FILE = path.join(app.getPath('userData'), 'state.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// Cada servidor tiene su propia instancia (mods, configs, mundos, etc.)
const instanceDir = (serverId) => path.join(ROOT, 'instances', serverId);

const SERVERS = Array.isArray(cfg.servers) ? cfg.servers : [];
const findServer = (id) => SERVERS.find((s) => s.id === id);

let mainWindow = null;
let playingServerId = null;

// ---------------------------------------------------------------------------
// Configuración del usuario (la edita desde la pantalla "Configuración")
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  ramMax: parseInt(cfg.ram && cfg.ram.max, 10) || 4, // GB
  javaPath: cfg.javaPath || '',
  autoJoin: true,
  fullscreen: false,
  minimizeOnPlay: true,
  richPresence: !(cfg.richPresence && cfg.richPresence.enabled === false),
  notifications: true, // avisos de Windows cuando el launcher está minimizado
  jvmArgs: '',
  winWidth: 0, // 0 = automático
  winHeight: 0
};

function sanitizeSettings(input) {
  const out = {};
  if ('ramMax' in input) {
    const n = Math.round(Number(input.ramMax));
    if (!Number.isFinite(n) || n < 1 || n > 64) throw new Error('La memoria RAM no es válida');
    out.ramMax = n;
  }
  if ('javaPath' in input) out.javaPath = String(input.javaPath || '').trim();
  if ('jvmArgs' in input) {
    const raw = String(input.jvmArgs || '').trim();
    const tokens = raw ? raw.split(/\s+/) : [];
    for (const t of tokens) {
      if (!t.startsWith('-')) throw new Error(`Argumento no válido: "${t}". Cada argumento debe empezar con "-".`);
      if (/^-Xm[sx]/i.test(t)) throw new Error('La memoria se cambia con el control de Memoria RAM, no aquí.');
      if (/^-javaagent/i.test(t)) throw new Error('No se permiten agentes Java.');
    }
    out.jvmArgs = tokens.join(' ');
  }
  ['winWidth', 'winHeight'].forEach((k) => {
    if (k in input) {
      const n = Math.round(Number(input[k]) || 0);
      if (n !== 0 && (n < 640 || n > 7680)) {
        throw new Error('La resolución debe estar entre 640 y 7680 (o vacío para automática).');
      }
      out[k] = n;
    }
  });
  ['autoJoin', 'fullscreen', 'minimizeOnPlay', 'richPresence', 'notifications'].forEach((k) => {
    if (k in input) out[k] = !!input[k];
  });
  return out;
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...sanitizeSettings(saved) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

// ---------------------------------------------------------------------------
// Discord Rich Presence
// ---------------------------------------------------------------------------
const presenceCfg = cfg.richPresence || { enabled: true, largeImageKey: 'logo' };
const launcherStart = new Date();
let gameStart = null;
let presenceMode = 'menu'; // 'menu' | 'playing'
let presenceServer = null;
let rpc = null;
let rpcReady = false;
let rpcRetry = null;

function presenceActivity() {
  const inviteUrl = cfg.discord && cfg.discord.inviteUrl;
  const validInvite =
    inviteUrl && /^https:\/\/(discord\.gg|discord\.com)\//.test(inviteUrl) && !inviteUrl.includes('TU_INVITACION');

  const activity =
    presenceMode === 'playing' && presenceServer
      ? {
          details: `Jugando ${presenceServer.name}`,
          state: `${cfg.studioName} · ${presenceServer.minecraftVersion}`,
          startTimestamp: gameStart || new Date()
        }
      : {
          details: 'En el launcher',
          state: cfg.studioName,
          startTimestamp: launcherStart
        };

  if (presenceCfg.largeImageKey) {
    activity.largeImageKey = presenceCfg.largeImageKey;
    activity.largeImageText = cfg.studioName;
  }
  if (validInvite) {
    activity.buttons = [{ label: 'Unirse al Discord', url: inviteUrl }];
  }
  activity.instance = false;
  return activity;
}

function updatePresence() {
  if (!rpc || !rpcReady) return;
  rpc.setActivity(presenceActivity()).catch(() => {});
}

function setPresence(mode, server = null) {
  presenceMode = mode;
  presenceServer = server;
  if (mode === 'playing') gameStart = new Date();
  updatePresence();
}

function connectPresence() {
  if (!RPC || !settings.richPresence) return;
  const clientId = cfg.discord && cfg.discord.clientId;
  if (!clientId) return;

  const scheduleRetry = () => {
    rpcReady = false;
    if (rpcRetry) return;
    rpcRetry = setTimeout(() => {
      rpcRetry = null;
      connectPresence();
    }, 15000);
  };

  try {
    if (rpc) {
      try { rpc.destroy().catch(() => {}); } catch {}
    }
    rpc = new RPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
      rpcReady = true;
      updatePresence();
    });
    rpc.on('disconnected', scheduleRetry);
    rpc.login({ clientId }).catch(scheduleRetry); // Discord cerrado: reintenta en silencio
  } catch {
    scheduleRetry();
  }
}

function disconnectPresence() {
  if (rpcRetry) clearTimeout(rpcRetry);
  rpcRetry = null;
  if (rpc) {
    try {
      rpc.clearActivity().catch(() => {});
      rpc.destroy().catch(() => {});
    } catch {}
  }
  rpc = null;
  rpcReady = false;
}

// ---------------------------------------------------------------------------
// Estado persistente (usuario de Discord + nombre elegido por cuenta)
// ---------------------------------------------------------------------------
function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    saved = {};
  }
  // playtime: { [discordId]: { [serverId]: milisegundos } } · skins: { [discordId]: nombre }
  return { user: null, usernames: {}, playtime: {}, skins: {}, tourDone: false, lastSeenVersion: null, ...saved };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function progress(text, percent = null) {
  send('progress', { text, percent });
}

// ---------------------------------------------------------------------------
// Notificaciones nativas de Windows (solo si el launcher está minimizado u oculto)
// ---------------------------------------------------------------------------
const liveNotifications = new Set(); // evita que se recojan antes de poder pulsarlas

function launcherHidden() {
  return !mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible();
}

function notify(title, body) {
  if (!settings.notifications || !launcherHidden()) return;
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title,
      body,
      icon: path.join(__dirname, 'renderer', 'assets', 'icon.png')
    });
    liveNotifications.add(n);
    n.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    n.on('close', () => liveNotifications.delete(n));
    n.show();
  } catch {
    /* las notificaciones nunca deben romper el launcher */
  }
}

// ---------------------------------------------------------------------------
// Roles de Discord → insignia del perfil
// ---------------------------------------------------------------------------
// cfg.roles va ordenado de mayor a menor importancia: se muestra el primero que el jugador tenga.
function roleBadgeFor(roleIds) {
  const owned = new Set(Array.isArray(roleIds) ? roleIds.map(String) : []);
  const list = Array.isArray(cfg.roles) ? cfg.roles : [];
  const hit = list.find((r) => owned.has(String(r.id)));
  return hit ? { label: hit.label, color: hit.color || '#a39da3' } : null;
}

function withBadge(user) {
  if (!user) return null;
  const { roles, ...rest } = user;
  return { ...rest, badge: roleBadgeFor(roles) };
}

// ---------------------------------------------------------------------------
// Registro en Discord (webhook): "X se unió a <servidor>"
// ---------------------------------------------------------------------------
const WEBHOOK_RE = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function logJoin(user, username, server) {
  const url = privateCfg.logWebhookUrl;
  if (!url || !WEBHOOK_RE.test(url)) return; // sin webhook configurado: no se registra nada
  const badge = roleBadgeFor(user.roles);
  const fields = [{ name: 'Discord', value: `<@${user.id}>`, inline: true }];
  if (badge) fields.push({ name: 'Rol', value: badge.label, inline: true });
  const body = {
    username: cfg.studioName,
    allowed_mentions: { parse: [] }, // la mención se ve pero no avisa a nadie
    embeds: [
      {
        color: 0xd4141f,
        author: { name: String(user.displayName || user.username).slice(0, 100), icon_url: user.avatarUrl },
        description: `**${username.replace(/_/g, '\\_')}** se unió a **${server.name}**`,
        fields,
        footer: { text: `@${user.username} · Launcher v${app.getVersion()}` },
        timestamp: new Date().toISOString()
      }
    ]
  };
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000)
  }).catch(() => {}); // un fallo del registro nunca debe afectar al juego
}

// ---------------------------------------------------------------------------
// Estado de instalación por servidor
// ---------------------------------------------------------------------------
const INSTALL_MARKER = '.dimensional-install.json';

function loaderKey(server) {
  const l = server.loader || {};
  return [server.minecraftVersion, l.type || 'vanilla', l.version || ''].join('|');
}

function manifestSignature(manifest) {
  const items = [
    ...(Array.isArray(manifest.mods) ? manifest.mods : []).map((m) => `m:${m.name}:${m.sha1 || m.url}`),
    ...(Array.isArray(manifest.files) ? manifest.files : []).map((f) => `f:${f.path}:${f.sha1 || f.url}`)
  ].sort();
  return crypto.createHash('sha1').update(items.join('\n')).digest('hex');
}

async function readMarker(server) {
  try {
    return JSON.parse(await fsp.readFile(path.join(instanceDir(server.id), INSTALL_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

async function writeMarker(server, manifestSig) {
  const marker = { loaderKey: loaderKey(server), manifestSig: manifestSig || null, installedAt: Date.now() };
  await fsp.mkdir(instanceDir(server.id), { recursive: true });
  await fsp.writeFile(path.join(instanceDir(server.id), INSTALL_MARKER), JSON.stringify(marker));
}

// 'not-installed' | 'installed' | 'update'
async function installStatus(server) {
  const marker = await readMarker(server);
  if (!marker) {
    // Instancias creadas por versiones anteriores del launcher: Minecraft ya generó options.txt
    return (await exists(path.join(instanceDir(server.id), 'options.txt'))) ? 'installed' : 'not-installed';
  }
  if (marker.loaderKey !== loaderKey(server)) return 'update';
  if (server.modsManifestUrl) {
    try {
      const res = await fetch(server.modsManifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (res.ok && manifestSignature(await res.json()) !== marker.manifestSig) return 'update';
    } catch {
      /* sin red: se asume instalado */
    }
  }
  return 'installed';
}

// ---------------------------------------------------------------------------
// Novedades de la versión (texto de la Release de GitHub)
// ---------------------------------------------------------------------------
function parseNotes(md) {
  const items = [];
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    const clean = (bullet ? bullet[1] : line)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (clean) items.push(clean.slice(0, 220));
    if (items.length >= 10) break;
  }
  return items;
}

async function fetchReleaseNotes(version) {
  const pub = (pkg.build && Array.isArray(pkg.build.publish) && pkg.build.publish[0]) || {};
  if (!pub.owner || !pub.repo) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${pub.owner}/${pub.repo}/releases/tags/v${version}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dimensional-studio-launcher' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return parseNotes(data.body);
  } catch {
    return [];
  }
}

// UUID offline igual al que genera Minecraft/Spigot: md5("OfflinePlayer:<nombre>")
function offlineUUID(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

async function download(url, dest, attempts = 3) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!res.ok) throw new Error(`Descarga fallida (${res.status}): ${url}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      lastErr = err;
      try { await fsp.unlink(tmp); } catch {}
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`No se pudo descargar un archivo necesario. Revisa tu conexión a internet. (${lastErr && lastErr.message})`);
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function needsDownload(dest, sha1) {
  if (!(await exists(dest))) return true;
  if (!sha1) return false;
  return (await sha1File(dest)).toLowerCase() !== String(sha1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Registro central: un solo jugador por IP
// ---------------------------------------------------------------------------
// El servidor del registro (registry-server/) ve la IP pública real de cada launcher.
// Una IP solo puede pertenecer a UNA cuenta de Discord; esa cuenta sí puede cambiar de nombre.
async function registryClaim(userId, username) {
  const reg = cfg.registry || {};
  if (reg.enabled === false) return;
  if (!reg.url || reg.url.includes('TU_REGISTRO')) {
    throw new Error('Falta configurar la dirección del registro de jugadores (registry.url en config.json).');
  }
  let res;
  try {
    res = await fetch(reg.url.replace(/\/+$/, '') + '/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(reg.apiKey ? { 'x-api-key': reg.apiKey } : {}) },
      body: JSON.stringify({ discordId: userId, username }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new Error('No se pudo contactar con el registro de jugadores. Revisa tu conexión e inténtalo de nuevo.');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || !data || !data.ok) {
    throw new Error((data && data.error) || `El registro de jugadores respondió con error (${res.status})`);
  }
}

// ---------------------------------------------------------------------------
// Login con Discord (OAuth2 implicit grant, no necesita client secret)
// ---------------------------------------------------------------------------
let cancelPendingLogin = null;

function callbackPage() {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${cfg.studioName}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html,body{margin:0;height:100%;background:#0a0c12;color:#f1f3f9;font-family:'Segoe UI',system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;
       background:radial-gradient(60% 50% at 50% 0%,rgba(109,94,252,.25),transparent 70%),#0a0c12}
  .box{max-width:460px;padding:44px 40px;border:1px solid rgba(255,255,255,.08);border-radius:18px;background:#10131c}
  h1{font-size:15px;font-weight:600;letter-spacing:5px;text-transform:uppercase;margin:0 0 18px;color:#c4c9dd}
  p{color:#9aa0b8;font-size:16px;line-height:1.5;margin:0}
  .ok{color:#f1f3f9}
</style></head>
<body><div class="box"><h1>${cfg.studioName}</h1><p id="m">Autorizando…</p></div>
<script>
(function () {
  var m = document.getElementById('m');
  var h = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  if (!h) {
    m.textContent = 'No se recibió la autorización. Vuelve al launcher e inténtalo de nuevo.';
    return;
  }
  fetch('/token', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: h })
    .then(function (r) {
      if (r.ok) {
        m.className = 'ok';
        m.textContent = 'Sesión autorizada. Ya puedes volver al launcher y cerrar esta pestaña.';
      } else {
        m.textContent = 'Autorización no válida. Vuelve al launcher e inténtalo de nuevo.';
      }
    })
    .catch(function () {
      m.textContent = 'No se pudo contactar con el launcher. ¿Sigue abierto?';
    });
})();
</script></body></html>`;
}

// Abre la autorización de Discord en el navegador del sistema (donde ya estás conectado)
// y recibe el token en un servidor local temporal (OAuth2 implicit grant, sin client secret).
function discordToken() {
  return new Promise((resolve, reject) => {
    const { clientId, redirectUri, requiredGuildId } = cfg.discord;
    if (!clientId || clientId.startsWith('PON_AQUI')) {
      return reject(new Error('Falta configurar el Client ID de Discord en config.json'));
    }

    let redirect;
    try {
      redirect = new URL(redirectUri);
    } catch {
      return reject(new Error('El redirectUri de config.json no es válido'));
    }
    const port = Number(redirect.port) || 80;

    const state = crypto.randomBytes(16).toString('hex');
    const scopes = ['identify'];
    if (requiredGuildId) scopes.push('guilds');
    if (cfg.discord.guildId) scopes.push('guilds.members.read'); // para leer los roles y mostrar la insignia
    const scope = scopes.join(' ');
    const authUrl =
      'https://discord.com/oauth2/authorize' +
      `?client_id=${encodeURIComponent(clientId)}` +
      '&response_type=token' +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&state=${state}`;

    let finished = false;
    let timer = null;
    let server = null;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      cancelPendingLogin = null;
      clearTimeout(timer);
      if (server) {
        server.close();
        setTimeout(() => {
          try { server.closeAllConnections(); } catch {}
        }, 1000).unref();
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      }
      fn(value);
    };

    cancelPendingLogin = () => finish(reject, new Error('Inicio de sesión cancelado'));

    server = http.createServer((req, res) => {
      let url;
      try {
        url = new URL(req.url, `http://localhost:${port}`);
      } catch {
        res.writeHead(400);
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === redirect.pathname) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(callbackPage());
        if (url.searchParams.get('error')) {
          finish(reject, new Error('Inicio de sesión cancelado o denegado'));
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4096) req.destroy();
        });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const token = params.get('access_token');
          if (!token || params.get('state') !== state) {
            res.writeHead(400);
            return res.end(); // petición ajena: se ignora y se sigue esperando
          }
          res.writeHead(204);
          res.end();
          finish(resolve, token);
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on('error', (err) => {
      finish(
        reject,
        new Error(
          err.code === 'EADDRINUSE'
            ? `El puerto ${port} está ocupado. Cierra otras ventanas del launcher e inténtalo de nuevo.`
            : err.message
        )
      );
    });

    server.listen(port, 'localhost', () => {
      shell.openExternal(authUrl);
    });

    timer = setTimeout(
      () => finish(reject, new Error('Se agotó el tiempo de espera. Vuelve a intentarlo.')),
      3 * 60 * 1000
    );
  });
}

async function discordLogin() {
  const token = await discordToken();
  const headers = { Authorization: `Bearer ${token}` };

  const meRes = await fetch('https://discord.com/api/v10/users/@me', { headers });
  if (!meRes.ok) throw new Error('No se pudo leer tu perfil de Discord');
  const me = await meRes.json();

  const { requiredGuildId, inviteUrl } = cfg.discord;
  if (requiredGuildId) {
    const gRes = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers });
    if (!gRes.ok) throw new Error('No se pudo comprobar tus servidores de Discord');
    const guilds = await gRes.json();
    if (!guilds.some((g) => g.id === requiredGuildId)) {
      throw new Error(
        `Debes ser miembro del Discord de ${cfg.studioName} para jugar.` +
          (inviteUrl ? ` Únete en: ${inviteUrl}` : '')
      );
    }
  }

  // Roles del jugador en el servidor de Discord (si no es miembro o falla, simplemente no hay insignia)
  let roles = [];
  if (cfg.discord.guildId) {
    try {
      const mRes = await fetch(`https://discord.com/api/v10/users/@me/guilds/${cfg.discord.guildId}/member`, { headers });
      if (mRes.ok) {
        const member = await mRes.json();
        roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
      }
    } catch {
      roles = [];
    }
  }

  const avatarUrl = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;

  return {
    id: me.id,
    username: me.username,
    displayName: me.global_name || me.username,
    avatarUrl,
    roles
  };
}

// ---------------------------------------------------------------------------
// Sincronización de mods / archivos desde el manifiesto del servidor
// ---------------------------------------------------------------------------
// Ejecuta tareas con un máximo de `limit` a la vez
async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function syncMods(server) {
  if (!server.modsManifestUrl) return null;
  const instance = instanceDir(server.id);

  progress('Buscando actualizaciones de mods…');
  const res = await fetch(server.modsManifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`No se pudo leer el manifiesto de mods (${res.status})`);
  const manifest = await res.json();

  const modsDir = path.join(instance, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });

  const mods = Array.isArray(manifest.mods) ? manifest.mods : [];
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter((f) => {
    const dest = path.resolve(instance, f.path);
    return dest.startsWith(path.resolve(instance) + path.sep); // evita rutas fuera de la instancia
  });
  const wanted = new Set(mods.map((m) => path.basename(m.name)));
  const jobs = [
    ...mods.map((m) => ({ label: path.basename(m.name), url: m.url, sha1: m.sha1, dest: path.join(modsDir, path.basename(m.name)) })),
    ...files.map((f) => ({ label: f.path, url: f.url, sha1: f.sha1, dest: path.resolve(instance, f.path) }))
  ];

  let done = 0;
  await runPool(jobs, 4, async (job) => {
    if (await needsDownload(job.dest, job.sha1)) await download(job.url, job.dest);
    done += 1;
    progress(`Mods y archivos (${done}/${jobs.length}): ${job.label}`, Math.round((done / jobs.length) * 100));
  });

  if (manifest.removeUnlisted !== false) {
    for (const f of await fsp.readdir(modsDir)) {
      if (f.endsWith('.jar') && !wanted.has(f)) {
        await fsp.unlink(path.join(modsDir, f));
      }
    }
  }
  return manifestSignature(manifest);
}

// Si no hay internet pero el servidor ya estaba instalado, se juega con lo que hay en vez de bloquear al jugador
async function syncModsSafe(server) {
  try {
    return await syncMods(server);
  } catch (err) {
    const marker = await readMarker(server);
    if (marker && marker.loaderKey === loaderKey(server)) {
      progress('Sin conexión con el servidor de mods: se usará la versión ya instalada.');
      send('log', `Sincronización omitida: ${err.message}`);
      return marker.manifestSig;
    }
    throw err;
  }
}

// Primera vez: trae tus ajustes (controles, gráficos) y la lista de servidores desde el .minecraft de siempre
async function importFromMinecraft(gameDir) {
  try {
    const base = process.platform === 'win32' ? path.join(app.getPath('appData'), '.minecraft') : path.join(os.homedir(), '.minecraft');
    for (const f of ['options.txt', 'servers.dat']) {
      const dest = path.join(gameDir, f);
      if (!(await exists(dest)) && (await exists(path.join(base, f)))) {
        await fsp.copyFile(path.join(base, f), dest);
      }
    }
  } catch {
    /* es solo una comodidad: nunca debe impedir jugar */
  }
}

// ---------------------------------------------------------------------------
// Loader (Forge / Fabric / Vanilla)
// ---------------------------------------------------------------------------
async function prepareLoader(server) {
  const mc = server.minecraftVersion;
  const type = (server.loader && server.loader.type) || 'vanilla';
  const version = { number: mc, type: 'release' };
  const extra = {};

  if (type === 'forge') {
    const v = server.loader.version;
    const name = `forge-${mc}-${v}-installer.jar`;
    const installer = path.join(ROOT, 'forge', name);
    if (!(await exists(installer))) {
      progress(`Descargando Forge ${v}…`);
      await download(
        `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${v}/${name}`,
        installer
      );
    }
    extra.forge = installer;
  } else if (type === 'fabric') {
    let loaderVersion = server.loader.version;
    if (!loaderVersion || loaderVersion === 'latest') {
      const r = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mc}`);
      if (!r.ok) throw new Error('No se pudo consultar las versiones de Fabric');
      const list = await r.json();
      const stable = list.find((e) => e.loader && e.loader.stable) || list[0];
      if (!stable) throw new Error(`Fabric no soporta Minecraft ${mc}`);
      loaderVersion = stable.loader.version;
    }
    const id = `fabric-loader-${loaderVersion}-${mc}`;
    const jsonPath = path.join(ROOT, 'versions', id, `${id}.json`);
    if (!(await exists(jsonPath))) {
      progress(`Descargando Fabric ${loaderVersion}…`);
      await download(
        `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loaderVersion}/profile/json`,
        jsonPath
      );
    }
    version.custom = id;
  }

  return { version, extra };
}

// ---------------------------------------------------------------------------
// Lanzar el juego (modo offline / no premium)
// ---------------------------------------------------------------------------
let lastCrash = null; // { report, log } del último cierre con error

function addPlaytime(userId, serverId, ms) {
  if (!userId || !(ms > 0)) return;
  const state = loadState();
  state.playtime[userId] = state.playtime[userId] || {};
  state.playtime[userId][serverId] = (state.playtime[userId][serverId] || 0) + ms;
  saveState(state);
  if (state.user && state.user.id === userId) send('playtime', state.playtime[userId]);
}

function diagnose(text) {
  if (/OutOfMemoryError|Could not reserve enough space|Too small maximum heap/i.test(text)) {
    return 'Minecraft se quedó sin memoria o no pudo reservarla. Ajusta la Memoria RAM en Configuración.';
  }
  if (/UnsupportedClassVersionError|class file version/i.test(text)) {
    return 'La versión de Java no es la correcta. Este servidor necesita Java 17.';
  }
  if (/Mod Loading has failed|Missing or unsupported mandatory dependencies|Failed to load mod/i.test(text)) {
    return 'Hay un problema con los mods. Vuelve a intentarlo; si sigue igual, copia el registro y envíaselo al staff.';
  }
  return null;
}

async function reportCrash(server, code, gameDir, startedAt, tail, version) {
  let report = null;
  let reportText = '';
  try {
    const dir = path.join(gameDir, 'crash-reports');
    let best = 0;
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.txt')) continue;
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs >= startedAt - 5000 && st.mtimeMs > best) {
        best = st.mtimeMs;
        report = path.join(dir, f);
      }
    }
    if (report) reportText = (await fsp.readFile(report, 'utf8')).slice(0, 30000);
  } catch {}
  const header = `${cfg.studioName} v${version} · ${server.name} · MC ${server.minecraftVersion} · código de salida ${code}`;
  lastCrash = { report, log: [header, ...tail].join('\n') };
  const hint = diagnose(reportText + '\n' + tail.join('\n'));
  send('game-crash', {
    serverName: server.name,
    code,
    hasReport: !!report,
    hint
  });
  notify(`${server.name} se cerró con un error`, hint || 'Abre el launcher para copiar el registro y enviarlo al staff.');
}

function jvmArgsList() {
  return settings.jvmArgs ? settings.jvmArgs.split(/\s+/).filter(Boolean) : [];
}

// Devuelve la versión mayor de Java (8, 17, 21…) o 0 si no se pudo ejecutar
function javaMajor(bin) {
  const r = spawnSync(bin || 'java', ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (r.error) return 0;
  const m = String(r.stderr || r.stdout || '').match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const major = Number(m[1]);
  return major === 1 ? Number(m[2]) || 0 : major;
}

function javaWorks(bin) {
  return javaMajor(bin) > 0;
}

const MIN_JAVA = 17;
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'java17');

function managedJavaPath() {
  try {
    for (const d of fs.readdirSync(RUNTIME_DIR)) {
      const bin = path.join(RUNTIME_DIR, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}
  return null;
}

// Descarga Java 17 (Temurin) una sola vez para que el jugador no tenga que instalar nada
async function installManagedJava() {
  if (process.platform !== 'win32') {
    throw new Error('No se encontró Java 17. Instálalo desde adoptium.net y vuelve a intentarlo.');
  }
  const zip = path.join(ROOT, 'runtime', 'java17.zip');
  progress('Descargando Java 17 (solo la primera vez)…');
  await download('https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse', zip);
  progress('Instalando Java 17…');
  await fsp.rm(RUNTIME_DIR, { recursive: true, force: true });
  await fsp.mkdir(RUNTIME_DIR, { recursive: true });
  const r = spawnSync('tar', ['-xf', zip, '-C', RUNTIME_DIR], { windowsHide: true, timeout: 5 * 60 * 1000 });
  await fsp.unlink(zip).catch(() => {});
  const bin = managedJavaPath();
  if (r.error || !bin || javaMajor(bin) < MIN_JAVA) {
    await fsp.rm(RUNTIME_DIR, { recursive: true, force: true }).catch(() => {});
    throw new Error('No se pudo instalar Java automáticamente. Instala Java 17 (Temurin) desde adoptium.net.');
  }
  return bin;
}

// Orden: ruta elegida por el jugador → Java del sistema (17+) → Java propio del launcher → descargarlo
async function resolveJava() {
  if (settings.javaPath) {
    const v = javaMajor(settings.javaPath);
    if (v >= MIN_JAVA) return settings.javaPath;
    throw new Error(
      v
        ? `El Java que elegiste es la versión ${v}. Este servidor necesita Java ${MIN_JAVA} o superior (o deja la ruta vacía para que el launcher lo gestione).`
        : 'No se pudo ejecutar el Java que elegiste en Configuración. Déjalo vacío para usar la detección automática.'
    );
  }
  if (javaMajor('java') >= MIN_JAVA) return 'java';
  const managed = managedJavaPath();
  if (managed && javaMajor(managed) >= MIN_JAVA) return managed;
  return installManagedJava();
}

function quickPlayOpts(server) {
  if (!settings.autoJoin || server.autoJoin === false || !server.ip) return null;
  const minor = parseInt(String(server.minecraftVersion).split('.')[1], 10) || 0;
  const port = server.port || 25565;
  // 1.20+ usa quickPlay; versiones anteriores usan --server/--port (lo resuelve minecraft-launcher-core)
  return { type: minor >= 20 ? 'multiplayer' : 'legacy', identifier: `${server.ip}:${port}` };
}

async function play(serverId) {
  if (playingServerId) throw new Error('El juego ya se está iniciando');
  const server = findServer(serverId);
  if (!server) throw new Error('Servidor no encontrado');
  if (server.status !== 'available') throw new Error(`${server.name} aún no está disponible`);

  const state = loadState();
  if (!state.user) throw new Error('Primero inicia sesión con Discord');
  const username = state.usernames && state.usernames[state.user.id];
  if (!username || !USERNAME_RE.test(username)) throw new Error('Primero elige tu nombre de jugador');
  await registryClaim(state.user.id, username); // un jugador por IP, también al jugar

  playingServerId = server.id;
  send('play-state', { playing: true, serverId: server.id, phase: 'preparing' });
  const debugTail = [];
  const gameDir = instanceDir(server.id);
  const userId = state.user.id;
  const logBuf = [];
  let startedAt = 0;
  lastCrash = null;

  try {
    await fsp.mkdir(gameDir, { recursive: true });
    const javaBin = await resolveJava();
    await importFromMinecraft(gameDir);
    const manifestSig = await syncModsSafe(server);
    const { version, extra } = await prepareLoader(server);
    await writeMarker(server, manifestSig); // a partir de aquí el servidor cuenta como instalado
    send('play-state', { playing: true, serverId: server.id, phase: 'launching' });
    notify(`${server.name} está listo`, 'Minecraft se está abriendo.');

    const uuid = offlineUUID(username);
    const launcher = new Client();

    const opts = {
      authorization: {
        access_token: uuid,
        client_token: uuid,
        uuid,
        name: username,
        user_properties: '{}',
        meta: { type: 'mojang', demo: false }
      },
      root: ROOT,
      version,
      memory: { min: `${Math.min(2, settings.ramMax)}G`, max: `${settings.ramMax}G` },
      overrides: { gameDirectory: gameDir },
      customArgs: jvmArgsList(),
      ...extra
    };
    if (javaBin && javaBin !== 'java') opts.javaPath = javaBin;
    if (settings.fullscreen) opts.window = { fullscreen: true };
    else if (settings.winWidth > 0 && settings.winHeight > 0) {
      opts.window = { width: String(settings.winWidth), height: String(settings.winHeight) };
    }
    const qp = quickPlayOpts(server);
    if (qp) opts.quickPlay = qp;

    launcher.on('progress', (e) => {
      const pct = e.total ? Math.round((e.task / e.total) * 100) : null;
      const names = { assets: 'recursos', 'assets-copy': 'recursos', classes: 'librerías', natives: 'librerías nativas', forge: 'Forge' };
      progress(`Descargando ${names[e.type] || e.type}…`, pct);
    });
    launcher.on('package-extract', () => progress('Extrayendo archivos…'));
    const pushLog = (line) => {
      const text = String(line);
      logBuf.push(text);
      if (logBuf.length > 300) logBuf.shift();
      send('log', text);
    };
    launcher.on('debug', (line) => {
      debugTail.push(String(line));
      if (debugTail.length > 30) debugTail.shift();
      pushLog(line);
    });
    launcher.on('data', pushLog);
    launcher.on('close', (code) => {
      playingServerId = null;
      setPresence('menu');
      if (startedAt) addPlaytime(userId, server.id, Date.now() - startedAt);
      send('play-state', { playing: false, serverId: server.id });
      progress(code === 0 ? 'Juego cerrado' : `El juego se cerró (código ${code})`, null);
      if (code !== 0 && startedAt) {
        reportCrash(server, code, gameDir, startedAt, logBuf.slice(-200), app.getVersion()).catch(() => {});
      }
    });

    progress('Iniciando Minecraft…');
    const proc = await launcher.launch(opts);
    if (!proc) {
      throw new Error('No se pudo iniciar Minecraft.\n' + debugTail.slice(-5).join('\n'));
    }
    startedAt = Date.now();
    setPresence('playing', server);
    logJoin(state.user, username, server);
    send('play-state', { playing: true, serverId: server.id, phase: 'playing' });
    progress(`Minecraft iniciado. Entrando a ${server.name}…`, null);
    if (settings.minimizeOnPlay && mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  } catch (err) {
    playingServerId = null;
    setPresence('menu');
    send('play-state', { playing: false, serverId: server.id });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    resizable: false,
    maximizable: false,
    frame: false,
    backgroundColor: '#07070a',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.png'),
    title: `${cfg.studioName} Launcher`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const wrap = (fn) => async (...args) => {
  try {
    return { ok: true, ...(await fn(...args)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
};

// Solo se envía a la interfaz lo necesario de cada servidor
const publicServer = (s) => ({
  id: s.id,
  name: s.name,
  status: s.status,
  description: s.description || '',
  minecraftVersion: s.minecraftVersion || null,
  loader: (s.loader && s.loader.type) || null,
  accent: Array.isArray(s.accent) ? s.accent : null
});

ipcMain.handle('app:get-state', () => {
  const state = loadState();
  const username = state.user ? (state.usernames || {})[state.user.id] || null : null;
  return {
    config: {
      studioName: cfg.studioName,
      tagline: cfg.tagline,
      version: app.getVersion(),
      hasInvite: !!(cfg.discord && cfg.discord.inviteUrl),
      servers: SERVERS.map(publicServer)
    },
    user: withBadge(state.user),
    username,
    playingServerId,
    playtime: state.user ? state.playtime[state.user.id] || {} : {},
    skin: state.user ? state.skins[state.user.id] || '' : '',
    tourDone: !!state.tourDone
  };
});

ipcMain.handle('servers:ping', async () => {
  const result = {};
  await Promise.all(
    SERVERS.filter((s) => s.status === 'available' && s.ip).map(async (s) => {
      result[s.id] = await pingServer(s.ip, s.port || 25565);
    })
  );
  return result;
});

ipcMain.handle('servers:install-status', async () => {
  const result = {};
  await Promise.all(
    SERVERS.filter((s) => s.status === 'available').map(async (s) => {
      result[s.id] = await installStatus(s);
    })
  );
  return result;
});

// "Actualizado a la X": se muestra una sola vez tras actualizar
ipcMain.handle('whatsnew:get', async () => {
  const state = loadState();
  const version = app.getVersion();
  if (state.lastSeenVersion === version) return { show: false };
  if (!state.lastSeenVersion && !state.tourDone && !state.user) {
    // primera instalación: no hay nada que contar
    state.lastSeenVersion = version;
    saveState(state);
    return { show: false };
  }
  return { show: true, version, items: await fetchReleaseNotes(version) };
});

ipcMain.handle('whatsnew:seen', () => {
  const state = loadState();
  state.lastSeenVersion = app.getVersion();
  saveState(state);
  return { ok: true };
});

ipcMain.handle(
  'auth:discord',
  wrap(async () => {
    const user = await discordLogin();
    const state = loadState();
    state.usernames = state.usernames || {};
    // Si esta cuenta ya tenía nombre, se confirma que su IP no esté ocupada por otro jugador
    if (state.usernames[user.id]) await registryClaim(user.id, state.usernames[user.id]);
    state.user = user;
    saveState(state);
    return {
      user: withBadge(user),
      username: state.usernames[user.id] || null,
      playtime: state.playtime[user.id] || {},
      skin: state.skins[user.id] || ''
    };
  })
);

ipcMain.handle('auth:cancel', () => {
  if (cancelPendingLogin) cancelPendingLogin();
  return { ok: true };
});

ipcMain.handle(
  'auth:logout',
  wrap(async () => {
    const state = loadState();
    state.user = null;
    saveState(state);
    return {};
  })
);

ipcMain.handle(
  'profile:set-username',
  wrap(async (_e, name) => {
    const clean = String(name || '').trim();
    if (!USERNAME_RE.test(clean)) {
      throw new Error('El nombre debe tener de 3 a 16 caracteres: letras, números o guion bajo (_)');
    }
    const state = loadState();
    if (!state.user) throw new Error('Primero inicia sesión con Discord');
    await registryClaim(state.user.id, clean); // rechaza si la IP ya tiene otro jugador
    state.usernames = state.usernames || {};
    state.usernames[state.user.id] = clean;
    saveState(state);
    return { username: clean };
  })
);

ipcMain.handle('game:play', wrap(async (_e, serverId) => { await play(serverId); return {}; }));

ipcMain.handle('game:open-folder', async () => {
  await fsp.mkdir(ROOT, { recursive: true });
  await shell.openPath(ROOT);
  return { ok: true };
});

// Borra mods y marcador de instalación: el próximo "Jugar" los descarga limpios (no toca mundos ni ajustes)
ipcMain.handle(
  'game:repair',
  wrap(async () => {
    if (playingServerId) throw new Error('Cierra Minecraft antes de reparar la instalación.');
    for (const s of SERVERS.filter((x) => x.status === 'available')) {
      await fsp.rm(path.join(instanceDir(s.id), 'mods'), { recursive: true, force: true });
      await fsp.rm(path.join(instanceDir(s.id), INSTALL_MARKER), { force: true });
    }
    return {};
  })
);

ipcMain.handle('app:open-invite', async () => {
  const url = cfg.discord && cfg.discord.inviteUrl;
  if (url && /^https:\/\/(discord\.gg|discord\.com)\//.test(url)) {
    await shell.openExternal(url);
  }
});

const settingsPayload = () => {
  const systemRamGb = Math.max(2, Math.floor(os.totalmem() / 1024 ** 3));
  return {
    settings,
    defaults: DEFAULT_SETTINGS,
    systemRamGb,
    recommendedRamGb: Math.max(2, Math.min(6, Math.floor(systemRamGb / 2)))
  };
};

ipcMain.handle('settings:get', () => settingsPayload());

ipcMain.handle(
  'settings:save',
  wrap(async (_e, partial) => {
    const clean = sanitizeSettings(partial || {});
    if (clean.javaPath) {
      const v = javaMajor(clean.javaPath);
      if (!v) throw new Error('No se pudo ejecutar Java en esa ruta. Elige el archivo java.exe correcto.');
      if (v < MIN_JAVA) throw new Error(`Ese Java es la versión ${v}. Se necesita Java ${MIN_JAVA} o superior.`);
    }
    const wasRpc = settings.richPresence;
    settings = { ...settings, ...clean };
    persistSettings();
    if (settings.richPresence !== wasRpc) {
      if (settings.richPresence) connectPresence();
      else disconnectPresence();
    }
    return settingsPayload();
  })
);

ipcMain.handle(
  'settings:reset',
  wrap(async () => {
    const wasRpc = settings.richPresence;
    settings = { ...DEFAULT_SETTINGS };
    persistSettings();
    if (settings.richPresence !== wasRpc) {
      if (settings.richPresence) connectPresence();
      else disconnectPresence();
    }
    return settingsPayload();
  })
);

ipcMain.handle('settings:pick-java', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona java.exe',
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : []
  });
  return { path: res.canceled || !res.filePaths.length ? null : res.filePaths[0] };
});

ipcMain.handle('crash:copy-log', () => {
  if (!lastCrash) return { ok: false };
  clipboard.writeText(lastCrash.log);
  return { ok: true };
});

ipcMain.handle('crash:open-report', async () => {
  if (!lastCrash || !lastCrash.report) return { ok: false };
  const err = await shell.openPath(lastCrash.report);
  return { ok: !err };
});

ipcMain.handle('app:copy-text', (_e, text) => {
  clipboard.writeText(String(text || '').slice(0, 200));
  return { ok: true };
});

ipcMain.handle(
  'skin:set',
  wrap(async (_e, name) => {
    const clean = String(name || '').trim();
    if (clean && !USERNAME_RE.test(clean)) {
      throw new Error('El nombre de la skin debe tener de 3 a 16 caracteres: letras, números o guion bajo (_)');
    }
    const state = loadState();
    if (!state.user) throw new Error('Primero inicia sesión con Discord');
    if (clean) state.skins[state.user.id] = clean;
    else delete state.skins[state.user.id];
    saveState(state);
    return { skin: clean };
  })
);

ipcMain.handle('tour:done', () => {
  const state = loadState();
  state.tourDone = true;
  saveState(state);
  return { ok: true };
});

ipcMain.on('win:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on('win:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ---------------------------------------------------------------------------
// Actualizaciones automáticas (GitHub Releases)
// ---------------------------------------------------------------------------
let updateReady = false;
let updateBusy = false; // hay una actualización descargándose
let manualCheck = false; // la comprobación la pidió el jugador con "Reintentar"
let updateVersion = '';

function friendlyUpdateError(err) {
  const raw = String((err && (err.code || err.message)) || '');
  const version = updateVersion ? ` ${updateVersion}` : '';
  const what = updateBusy ? `descargar la actualización${version}` : 'buscar actualizaciones';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION|getaddrinfo/i.test(raw)) {
    return `No se pudo ${what}: sin conexión con GitHub. Revisa tu internet.`;
  }
  return `No se pudo ${what}. Inténtalo de nuevo.`;
}

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return; // solo en la app instalada
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // si no pulsa el botón, se instala al cerrar
  autoUpdater.on('checking-for-update', () => send('update-state', { status: 'checking' }));
  autoUpdater.on('update-available', (i) => {
    updateBusy = true;
    updateVersion = i.version;
    send('update-state', { status: 'downloading', version: i.version, percent: 0 });
  });
  autoUpdater.on('update-not-available', () => {
    const manual = manualCheck;
    manualCheck = false;
    updateBusy = false;
    send('update-state', { status: 'none', manual });
  });
  autoUpdater.on('download-progress', (p) =>
    send('update-state', { status: 'downloading', percent: Math.round(p.percent || 0) })
  );
  autoUpdater.on('update-downloaded', (i) => {
    updateReady = true;
    updateBusy = false;
    manualCheck = false;
    send('update-state', { status: 'ready', version: i.version });
    notify('Actualización lista', `La versión ${i.version} está lista. Ábrela para instalarla.`);
  });
  autoUpdater.on('error', (err) => {
    const message = friendlyUpdateError(err);
    send('log', `Actualizador: ${String((err && err.message) || err).split('\n')[0]}`);
    const visible = updateBusy || manualCheck; // una comprobación silenciosa sin red no molesta
    updateBusy = false;
    manualCheck = false;
    if (visible) send('update-state', { status: 'error', message });
    else send('update-state', { status: 'none' });
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000); // y cada hora mientras esté abierto
}

ipcMain.handle('update:install', () => {
  if (playingServerId) return { ok: false, error: 'Cierra Minecraft antes de actualizar.' };
  if (autoUpdater && updateReady) autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('update:retry', () => {
  if (!autoUpdater || !app.isPackaged) {
    return { ok: false, error: 'Las actualizaciones solo funcionan en la app instalada.' };
  }
  manualCheck = true;
  send('update-state', { status: 'checking', manual: true });
  autoUpdater.checkForUpdates().catch(() => {}); // el error llega por el evento 'error'
  return { ok: true };
});

app.on('before-quit', disconnectPresence);

app.whenReady().then(() => {
  createWindow();
  connectPresence();
  setupUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
