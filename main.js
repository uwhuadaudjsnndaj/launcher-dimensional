const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
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
  richPresence: !(cfg.richPresence && cfg.richPresence.enabled === false)
};

function sanitizeSettings(input) {
  const out = {};
  if ('ramMax' in input) {
    const n = Math.round(Number(input.ramMax));
    if (!Number.isFinite(n) || n < 1 || n > 64) throw new Error('La memoria RAM no es válida');
    out.ramMax = n;
  }
  if ('javaPath' in input) out.javaPath = String(input.javaPath || '').trim();
  ['autoJoin', 'fullscreen', 'minimizeOnPlay', 'richPresence'].forEach((k) => {
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
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { user: null, usernames: {} };
  }
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

async function download(url, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga fallida (${res.status}): ${url}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
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
    const scope = requiredGuildId ? 'identify guilds' : 'identify';
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

  const avatarUrl = me.avatar
    ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;

  return {
    id: me.id,
    username: me.username,
    displayName: me.global_name || me.username,
    avatarUrl
  };
}

// ---------------------------------------------------------------------------
// Sincronización de mods / archivos desde el manifiesto del servidor
// ---------------------------------------------------------------------------
async function syncMods(server) {
  if (!server.modsManifestUrl) return;
  const instance = instanceDir(server.id);

  progress('Buscando actualizaciones de mods…');
  const res = await fetch(server.modsManifestUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`No se pudo leer el manifiesto de mods (${res.status})`);
  const manifest = await res.json();

  const modsDir = path.join(instance, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });

  const mods = Array.isArray(manifest.mods) ? manifest.mods : [];
  const wanted = new Set();

  for (let i = 0; i < mods.length; i++) {
    const mod = mods[i];
    const fileName = path.basename(mod.name);
    wanted.add(fileName);
    const dest = path.join(modsDir, fileName);
    progress(`Mods: ${fileName} (${i + 1}/${mods.length})`, Math.round((i / mods.length) * 100));
    if (await needsDownload(dest, mod.sha1)) {
      await download(mod.url, dest);
    }
  }

  if (manifest.removeUnlisted !== false) {
    for (const f of await fsp.readdir(modsDir)) {
      if (f.endsWith('.jar') && !wanted.has(f)) {
        await fsp.unlink(path.join(modsDir, f));
      }
    }
  }

  // Archivos extra (configs, resourcepacks, etc.) relativos a la carpeta de la instancia
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const dest = path.resolve(instance, f.path);
    if (!dest.startsWith(path.resolve(instance) + path.sep)) continue; // evita rutas fuera de la instancia
    progress(`Archivos: ${f.path} (${i + 1}/${files.length})`, Math.round((i / files.length) * 100));
    if (await needsDownload(dest, f.sha1)) {
      await download(f.url, dest);
    }
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
function javaWorks(bin) {
  const r = spawnSync(bin || 'java', ['-version']);
  return !r.error;
}

function javaOk() {
  return javaWorks(settings.javaPath);
}

function joinArgs(server) {
  if (!settings.autoJoin || server.autoJoin === false) return [];
  const minor = parseInt(String(server.minecraftVersion).split('.')[1], 10) || 0;
  const port = server.port || 25565;
  if (minor >= 20) {
    return ['--quickPlayMultiplayer', `${server.ip}:${port}`];
  }
  return ['--server', server.ip, '--port', String(port)];
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
  if (!javaOk()) {
    throw new Error('No se encontró Java. Instala Java 17 (Temurin) y vuelve a intentarlo.');
  }

  playingServerId = server.id;
  send('play-state', { playing: true, serverId: server.id });
  const debugTail = [];
  const gameDir = instanceDir(server.id);

  try {
    await fsp.mkdir(gameDir, { recursive: true });
    await syncMods(server);
    const { version, extra } = await prepareLoader(server);

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
      customArgs: joinArgs(server),
      ...extra
    };
    if (settings.javaPath) opts.javaPath = settings.javaPath;
    if (settings.fullscreen) opts.window = { fullscreen: true };

    launcher.on('progress', (e) => {
      const pct = e.total ? Math.round((e.task / e.total) * 100) : null;
      progress(`Descargando ${e.type}…`, pct);
    });
    launcher.on('package-extract', () => progress('Extrayendo archivos…'));
    launcher.on('debug', (line) => {
      debugTail.push(String(line));
      if (debugTail.length > 30) debugTail.shift();
      send('log', String(line));
    });
    launcher.on('data', (line) => send('log', String(line)));
    launcher.on('close', (code) => {
      playingServerId = null;
      setPresence('menu');
      send('play-state', { playing: false, serverId: server.id });
      progress(code === 0 ? 'Juego cerrado' : `El juego se cerró (código ${code})`, null);
    });

    progress('Iniciando Minecraft…');
    const proc = await launcher.launch(opts);
    if (!proc) {
      throw new Error('No se pudo iniciar Minecraft.\n' + debugTail.slice(-5).join('\n'));
    }
    setPresence('playing', server);
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
  ip: s.ip || null,
  port: s.port || 25565,
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
    user: state.user,
    username,
    playingServerId
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
    return { user, username: state.usernames[user.id] || null };
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

ipcMain.handle('app:open-invite', async () => {
  const url = cfg.discord && cfg.discord.inviteUrl;
  if (url && /^https:\/\/(discord\.gg|discord\.com)\//.test(url)) {
    await shell.openExternal(url);
  }
});

const settingsPayload = () => ({
  settings,
  defaults: DEFAULT_SETTINGS,
  systemRamGb: Math.max(2, Math.floor(os.totalmem() / 1024 ** 3))
});

ipcMain.handle('settings:get', () => settingsPayload());

ipcMain.handle(
  'settings:save',
  wrap(async (_e, partial) => {
    const clean = sanitizeSettings(partial || {});
    if (clean.javaPath && !javaWorks(clean.javaPath)) {
      throw new Error('No se pudo ejecutar Java en esa ruta. Elige el archivo java.exe correcto.');
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

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return; // solo en la app instalada
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // si no pulsa el botón, se instala al cerrar
  autoUpdater.on('checking-for-update', () => send('update-state', { status: 'checking' }));
  autoUpdater.on('update-available', (i) => send('update-state', { status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => send('update-state', { status: 'none' }));
  autoUpdater.on('download-progress', (p) =>
    send('update-state', { status: 'downloading', percent: Math.round(p.percent || 0) })
  );
  autoUpdater.on('update-downloaded', (i) => {
    updateReady = true;
    send('update-state', { status: 'ready', version: i.version });
  });
  autoUpdater.on('error', () => send('update-state', { status: 'error' }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000); // y cada hora mientras esté abierto
}

ipcMain.handle('update:install', () => {
  if (playingServerId) return { ok: false, error: 'Cierra Minecraft antes de actualizar.' };
  if (autoUpdater && updateReady) autoUpdater.quitAndInstall(false, true);
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
