// 《播种者传说》联机服务器（A 路线 · WebSocket 多人）
// 运行：npm install 然后 node server.js，浏览器打开 http://localhost:3000
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;

// —— 静态文件服务器（托管 index.html + three.min.js）——
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

// —— WebSocket 多人 ——
const wss = new WebSocket.Server({ server });
const players = new Map(); // id -> { x, y, z, name, seed, color, quat }

function randomColor() { return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); }
function broadcast(msg, except) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c !== except && c.readyState === WebSocket.OPEN) c.send(s); });
}
function snapshot(id) { const p = players.get(id); return p ? { id, x: p.x, y: p.y, z: p.z, name: p.name, color: p.color, seed: p.seed } : null; }

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  players.set(ws.id, { x: 0, y: 0, z: 0, name: '旅人', seed: '', color: randomColor(), quat: [0, 0, 0, 1] });
  ws.send(JSON.stringify({ type: 'hello', id: ws.id, online: players.size }));

  ws.on('message', (msg) => {
    let d;
    try { d = JSON.parse(msg); } catch (e) { return; }
    if (d.type === 'join') {
      const p = players.get(ws.id);
      p.name = (d.name || '旅人').slice(0, 16);
      p.seed = d.seed || '';
      p.color = d.color || p.color;
      p.x = d.x || 0; p.y = d.y || 0; p.z = d.z || 0;
      // 把现有玩家发给新玩家
      const others = [...players.entries()].filter(([id]) => id !== ws.id).map(([id]) => snapshot(id)).filter(Boolean);
      ws.send(JSON.stringify({ type: 'players', players: others }));
      // 广播新玩家加入
      broadcast({ type: 'join', ...snapshot(ws.id) }, ws);
      broadcast({ type: 'chat', id: 'sys', name: '系统', text: p.name + ' 进入了宇宙' }, ws);
    } else if (d.type === 'pos') {
      const p = players.get(ws.id);
      if (d.x != null) { p.x = d.x; p.y = d.y; p.z = d.z; }
      if (d.quat) p.quat = d.quat;
      broadcast({ type: 'pos', id: ws.id, x: p.x, y: p.y, z: p.z, quat: p.quat }, ws);
    } else if (d.type === 'chat') {
      const p = players.get(ws.id);
      broadcast({ type: 'chat', id: ws.id, name: p.name, text: String(d.text || '').slice(0, 120) }, ws);
    }
  });

  ws.on('close', () => {
    const p = players.get(ws.id);
    players.delete(ws.id);
    broadcast({ type: 'leave', id: ws.id });
    if (p) broadcast({ type: 'chat', id: 'sys', name: '系统', text: p.name + ' 离开了宇宙' }, ws);
  });
  ws.on('error', () => {});
});

function lanIP() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name]) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('《播种者传说》联机服务器已启动');
  console.log('  本机访问：http://localhost:' + PORT);
  console.log('  局域网访问：http://' + lanIP() + ':' + PORT);
  console.log('  玩家数：' + players.size);
  console.log('==========================================');
});
