// Consulta el estado de un servidor de Minecraft (Server List Ping) sin dependencias.
const net = require('net');

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset = 0) {
  let num = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null; // faltan datos
    const b = buf[pos++];
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt demasiado largo');
  }
  return { value: num, size: pos - offset };
}

function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

function pingServer(host, port = 25565, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const start = Date.now();
    const socket = net.createConnection({ host, port });
    let timer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    timer = setTimeout(() => finish({ online: false }), timeoutMs);

    socket.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = packet(
        0x00,
        Buffer.concat([writeVarInt(-1), mcString(host), portBuf, writeVarInt(1)])
      );
      socket.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        const id = readVarInt(body, 0);
        if (!id || id.value !== 0x00) return finish({ online: false });
        const strLen = readVarInt(body, id.size);
        if (!strLen) return;
        const start0 = id.size + strLen.size;
        const json = JSON.parse(body.subarray(start0, start0 + strLen.value).toString('utf8'));
        finish({
          online: true,
          players: (json.players && json.players.online) || 0,
          max: (json.players && json.players.max) || 0,
          latency: Date.now() - start
        });
      } catch {
        finish({ online: false });
      }
    });

    socket.on('error', () => finish({ online: false }));
    socket.on('close', () => finish({ online: false }));
  });
}

module.exports = { pingServer };
