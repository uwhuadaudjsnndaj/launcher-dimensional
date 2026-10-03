// Registro central de jugadores de Dimensional Studio.
// Regla: UNA IP = UN jugador (cuenta de Discord). El nombre se puede cambiar, pero
// otra cuenta de Discord no puede registrarse desde una IP que ya tiene jugador.
// Sin dependencias: node registry-server/server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const API_KEY = process.env.API_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // actívalo solo detrás de nginx/Cloudflare
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'players.json');
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const DISCORD_ID_RE = /^\d{5,25}$/;

let players = {}; // { [ip]: { discordId, username, updatedAt } }
try {
  players = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  players = {};
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(players, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) ip = fwd;
  }
  return ip.replace(/^::ffff:/, '');
}

// Límite simple de peticiones por IP (60 por minuto)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function claim(ip, discordId, username) {
  const existing = players[ip];
  if (existing && existing.discordId !== discordId) {
    return {
      status: 409,
      body: { ok: false, code: 'ip_taken', error: 'Ya existe un jugador registrado con esta IP. Solo se permite un jugador por IP.' }
    };
  }
  const lower = username.toLowerCase();
  for (const [otherIp, p] of Object.entries(players)) {
    if (p.discordId !== discordId && p.username.toLowerCase() === lower) {
      return { status: 409, body: { ok: false, code: 'name_taken', error: 'Ese nombre ya está en uso por otro jugador.' } };
    }
  }
  // La misma cuenta de Discord solo ocupa una IP: si cambió de IP, se mueve su registro.
  for (const [otherIp, p] of Object.entries(players)) {
    if (p.discordId === discordId && otherIp !== ip) delete players[otherIp];
  }
  players[ip] = { discordId, username, updatedAt: new Date().toISOString() };
  save();
  return { status: 200, body: { ok: true, username } };
}

http
  .createServer((req, res) => {
    const ip = clientIp(req);
    if (limited(ip)) return reply(res, 429, { ok: false, error: 'Demasiadas peticiones. Espera un momento.' });

    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });

    if (req.method === 'POST' && req.url === '/claim') {
      if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
        return reply(res, 401, { ok: false, error: 'Clave del registro no válida.' });
      }
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 2048) req.destroy();
      });
      req.on('end', () => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return reply(res, 400, { ok: false, error: 'Petición no válida.' });
        }
        const discordId = String(data.discordId || '');
        const username = String(data.username || '').trim();
        if (!DISCORD_ID_RE.test(discordId) || !USERNAME_RE.test(username)) {
          return reply(res, 400, { ok: false, error: 'Datos no válidos.' });
        }
        const out = claim(ip, discordId, username);
        reply(res, out.status, out.body);
      });
      return;
    }

    reply(res, 404, { ok: false });
  })
  .listen(PORT, () => console.log(`Registro de jugadores escuchando en el puerto ${PORT}`));
