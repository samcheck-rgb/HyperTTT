#!/usr/bin/env node
/*
 * Hyper Tic-Tac-Toe — local game server (zero dependencies, Node 16+)
 *
 *   node hyper-server.js            # serves on port 3000
 *   PORT=8080 node hyper-server.js  # custom port
 *
 * What it does
 *   1. Serves hyper-tictactoe.html (keep both files in the same folder).
 *   2. Runs a tiny WebSocket relay at /ws. A host opens a room, a friend joins
 *      with the 4-letter code (or picks it from the open-games list), and the
 *      server forwards their messages to each other. The server never looks at
 *      game state; the two browsers play the game themselves.
 *
 * Everyone must be on the same network (Wi-Fi/LAN) as this device, and this
 * device's firewall must allow incoming connections on the chosen port.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const GAME_FILE = path.join(__dirname, 'hyper-tictactoe.html');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 64 * 1024;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** @type {Map<string, {code:string, host:Client, guest:Client|null, name:string, label:string}>} */
const rooms = new Map();
/** @type {Set<Client>} */
const clients = new Set();

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/* ---------------- HTTP ---------------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html' || url === '/hyper-tictactoe.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Could not read hyper-tictactoe.html. Keep it in the same folder as hyper-server.js.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } else if (url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ app: 'hyper-tictactoe', addresses: lanAddresses(), port: server.address() ? server.address().port : PORT }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

/* ---------------- WebSocket (RFC 6455, text frames only) ---------------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if ((req.url || '').split('?')[0] !== '/ws' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const c = new Client(socket);
  clients.add(c);
});

class Client {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragLen = 0;
    this.room = null;
    this.role = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.onClose());
    socket.on('error', () => {});
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_MSG * 2 + 32) { this.kill(); return; }
    while (this.parse()) { /* keep parsing complete frames */ }
  }
  parse() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(MAX_MSG)) { this.kill(); return false; }
      len = Number(big); off = 10;
    }
    if (len > MAX_MSG) { this.kill(); return false; }
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) return false;
    let payload = Buffer.from(b.subarray(off + (masked ? 4 : 0), total));
    if (masked) {
      const mask = b.subarray(off, off + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.subarray(total);
    if (op === 0x8) { this.kill(); return false; }          // close
    if (op === 0x9) { this.sendRaw(0x8a, payload); return true; } // ping -> pong
    if (op === 0xa) return true;                              // pong
    this.frags.push(payload);
    this.fragLen += payload.length;
    if (this.fragLen > MAX_MSG) { this.kill(); return false; }
    if (fin) {
      const text = Buffer.concat(this.frags).toString('utf8');
      this.frags = []; this.fragLen = 0;
      handleMessage(this, text);
    }
    return true;
  }
  sendRaw(firstByte, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([firstByte, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = firstByte; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = firstByte; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }
  send(obj) { this.sendRaw(0x81, Buffer.from(JSON.stringify(obj))); }
  kill() { this.socket.destroy(); }
  onClose() { clients.delete(this); leaveRoom(this); }
}

function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max); }

function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  if (c.role === 'host') {
    if (room.guest) { room.guest.send({ t: 'peer-left' }); room.guest.room = null; room.guest.role = null; }
    rooms.delete(room.code);
  } else if (room.guest === c) {
    room.guest = null;
    room.host.send({ t: 'peer-left' });
  }
  c.role = null;
}

function handleMessage(c, raw) {
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  switch (m.t) {
    case 'host': {
      if (c.room) return;
      const code = newCode();
      if (!code) { c.send({ t: 'error', msg: 'Server is full. Try again later.' }); return; }
      const room = { code, host: c, guest: null, name: clean(m.name, 16) || 'Host', label: clean(m.label, 60) };
      rooms.set(code, room);
      c.room = room; c.role = 'host';
      c.send({ t: 'hosted', code });
      break;
    }
    case 'info': {
      if (c.room && c.role === 'host') {
        c.room.name = clean(m.name, 16) || c.room.name;
        c.room.label = clean(m.label, 60);
      }
      break;
    }
    case 'list': {
      const open = [];
      rooms.forEach((r) => { if (!r.guest) open.push({ code: r.code, host: r.name, label: r.label }); });
      c.send({ t: 'rooms', rooms: open });
      break;
    }
    case 'join': {
      if (c.room) return;
      const code = clean(m.code, 8).toUpperCase();
      const room = rooms.get(code);
      if (!room) { c.send({ t: 'error', msg: 'No open game with that code.' }); return; }
      if (room.guest) { c.send({ t: 'error', msg: 'That game already has two players.' }); return; }
      room.guest = c; c.room = room; c.role = 'guest';
      c.send({ t: 'joined', code, host: room.name });
      room.host.send({ t: 'peer-joined' });
      break;
    }
    case 'relay': {
      const room = c.room;
      if (!room) return;
      const target = c.role === 'host' ? room.guest : room.host;
      if (target) target.send({ t: 'relay', d: m.d });
      break;
    }
    default: break;
  }
}

// Keep idle connections alive through routers/proxies.
setInterval(() => { clients.forEach((c) => c.sendRaw(0x89, Buffer.alloc(0))); }, 25000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error('Port ' + PORT + ' is already in use. Try: PORT=' + (PORT + 1) + ' node hyper-server.js');
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\nHyper Tic-Tac-Toe server is running.\n');
  console.log('  This device:        http://localhost:' + PORT);
  const addrs = lanAddresses();
  if (addrs.length) addrs.forEach((a) => console.log('  Friends on Wi-Fi:   http://' + a + ':' + PORT));
  else console.log('  (No LAN address found. Connect to a network so friends can join.)');
  console.log('\nOpen a link above, choose Multiplayer, then Host a game. Press Ctrl+C to stop.\n');
});
