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

// —— WebSocket 多人（世界/组队频道、好友、组队）——
const wss = new WebSocket.Server({ server });
const players = new Map(); // id -> player 对象
const teams = new Map(); // 队名 -> { leader, members:Set, requests:Map<id,name> }

function randomColor() { return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); }
function send(ws, msg) { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch (e) {} }
function snapshot(id) { const p = players.get(id); return p ? { id, x: p.x, y: p.y, z: p.z, name: p.name, color: p.color, seed: p.seed, team: p.team } : null; }
function byName(name) { for (const [id, p] of players) if (p.name === name) return id; return null; }
function friendsSnapshots(id) {
  const p = players.get(id);
  if (!p || !p.friends || !p.friends.size) return [];
  const out = [];
  for (const fid of p.friends) { const s = snapshot(fid); if (s) out.push(s); }
  return out;
}
function teamMembers(teamName) {
  const out = [];
  for (const [id, p] of players) if (p.team === teamName) out.push(snapshot(id));
  return out;
}
function sendTeamUpdate(teamName) {
  const t = teams.get(teamName);
  if (!t) return;
  const members = teamMembers(teamName);
  const leader = players.get(t.leader);
  for (const [id, p] of players) {
    if (t.members.has(id)) {
      const reqs = [];
      if (id === t.leader) for (const [rid, rname] of t.requests) reqs.push({ name: rname });
      send(p.ws, { type: 'team', team: teamName, members, leaderName: leader ? leader.name : '', requests: reqs });
    }
  }
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  players.set(ws.id, { ws, x: 0, y: 0, z: 0, name: '旅人', seed: '', color: randomColor(), team: '', friends: new Set(), quat: [0, 0, 0, 1] });
  send(ws, { type: 'hello', id: ws.id, online: players.size });

  ws.on('message', (msg) => {
    let d;
    try { d = JSON.parse(msg); } catch (e) { return; }
    const p = players.get(ws.id);
    if (!p) return;

    if (d.type === 'join') {
      const name = String(d.name || '旅人').trim().slice(0, 16);
      const existing = byName(name);
      if (existing && existing !== ws.id) { send(ws, { type: 'nameTaken', name }); return; }
      p.name = name;
      p.seed = d.seed || '';
      p.color = d.color || p.color;
      p.x = d.x || 0; p.y = d.y || 0; p.z = d.z || 0;
      const others = [...players.entries()].filter(([id]) => id !== ws.id).map(([id]) => snapshot(id)).filter(Boolean);
      send(ws, { type: 'players', players: others });
      for (const [id, q] of players) if (id !== ws.id) send(q.ws, { type: 'join', ...snapshot(ws.id) });
      for (const [id, q] of players) send(q.ws, { type: 'chat', channel: 'world', name: '系统', text: p.name + ' 进入了宇宙' });
      send(ws, { type: 'friendList', friends: friendsSnapshots(ws.id) });
      for (const [id, q] of players) {
        if (id !== ws.id && q.friends && q.friends.has(ws.id)) {
          send(q.ws, { type: 'friendOnline', name: p.name });
          send(q.ws, { type: 'friendList', friends: friendsSnapshots(id) });
        }
      }
    }
    else if (d.type === 'pos') {
      if (d.x != null) { p.x = d.x; p.y = d.y; p.z = d.z; }
      if (d.quat) p.quat = d.quat;
      for (const [id, q] of players) if (id !== ws.id) send(q.ws, { type: 'pos', id: ws.id, x: p.x, y: p.y, z: p.z, quat: p.quat });
    }
    else if (d.type === 'chat') {
      const channel = d.channel === 'team' ? 'team' : (d.channel === 'private' ? 'private' : 'world');
      const text = String(d.text || '').slice(0, 120);
      if (!text) return;
      if (channel === 'private') {
        const tid = byName(String(d.to || ''));
        if (!tid || tid === ws.id) { send(ws, { type: 'chat', channel: 'private', name: '系统', text: '找不到该玩家' }); return; }
        const target = players.get(tid);
        send(target.ws, { type: 'chat', channel: 'private', name: p.name, text });
        send(ws, { type: 'chat', channel: 'private', name: '私聊 → ' + target.name, text });
      } else if (channel === 'team') {
        if (!p.team) { send(ws, { type: 'chat', channel: 'team', name: '系统', text: '你还没有加入组队' }); return; }
        for (const [id, q] of players) if (q.team === p.team) send(q.ws, { type: 'chat', channel: 'team', name: p.name, text });
      } else {
        for (const [id, q] of players) send(q.ws, { type: 'chat', channel: 'world', name: p.name, text });
      }
    }
    else if (d.type === 'team') {
      if (d.action === 'create') {
        const name = String(d.name || '').slice(0, 24);
        if (!name) return;
        if (teams.has(name)) { send(ws, { type: 'teamResult', ok: false, text: '队名「' + name + '」已存在' }); return; }
        if (p.team) { send(ws, { type: 'teamResult', ok: false, text: '你已经在队伍中' }); return; }
        teams.set(name, { leader: ws.id, members: new Set([ws.id]), requests: new Map() });
        p.team = name;
        sendTeamUpdate(name);
        send(ws, { type: 'teamResult', ok: true, text: '队伍「' + name + '」已创建，你是队长' });
      } else if (d.action === 'search') {
        const name = String(d.name || '').slice(0, 24);
        const t = teams.get(name);
        if (!t) { send(ws, { type: 'teamSearch', name, exists: false }); return; }
        const leader = players.get(t.leader);
        send(ws, { type: 'teamSearch', name, exists: true, memberCount: t.members.size, leaderName: leader ? leader.name : '未知' });
      } else if (d.action === 'apply') {
        const name = String(d.name || '').slice(0, 24);
        const t = teams.get(name);
        if (!t) { send(ws, { type: 'teamResult', ok: false, text: '队伍不存在' }); return; }
        if (p.team) { send(ws, { type: 'teamResult', ok: false, text: '你已经在队伍中' }); return; }
        t.requests.set(ws.id, p.name);
        const leader = players.get(t.leader);
        if (leader) send(leader.ws, { type: 'teamRequest', teamName: name, fromName: p.name });
        send(ws, { type: 'teamResult', ok: true, text: '申请已发送给队长' });
      } else if (d.action === 'approve') {
        const name = String(d.name || '');
        const t = teams.get(name);
        if (!t || t.leader !== ws.id) { send(ws, { type: 'teamResult', ok: false, text: '你不是该队队长' }); return; }
        const pid = byName(String(d.playerName || ''));
        if (!pid || !t.requests.has(pid)) { send(ws, { type: 'teamResult', ok: false, text: '申请不存在' }); return; }
        t.requests.delete(pid);
        t.members.add(pid);
        const np = players.get(pid);
        if (np) np.team = name;
        sendTeamUpdate(name);
        if (np) send(np.ws, { type: 'teamResult', ok: true, text: '你已加入队伍「' + name + '」' });
      } else if (d.action === 'reject') {
        const name = String(d.name || '');
        const t = teams.get(name);
        if (!t || t.leader !== ws.id) return;
        const pid = byName(String(d.playerName || ''));
        if (pid) t.requests.delete(pid);
        sendTeamUpdate(name);
      } else if (d.action === 'leave') {
        if (!p.team) return;
        const name = p.team;
        const t = teams.get(name);
        if (t) {
          t.members.delete(ws.id);
          if (t.leader === ws.id) {
            for (const mid of t.members) {
              const mp = players.get(mid);
              if (mp) { mp.team = ''; send(mp.ws, { type: 'team', team: '', members: [] }); }
            }
            teams.delete(name);
          }
        }
        p.team = '';
        send(ws, { type: 'team', team: '', members: [] });
        if (t && t.leader !== ws.id) sendTeamUpdate(name);
      }
    }
    else if (d.type === 'friend') {
      if (d.action === 'add') {
        const fid = byName(String(d.name || ''));
        if (!fid || fid === ws.id) { send(ws, { type: 'friendResult', ok: false, text: '找不到该玩家或不能添加自己' }); return; }
        const target = players.get(fid);
        send(ws, { type: 'friendResult', ok: true, text: '好友申请已发送给 ' + target.name });
        send(target.ws, { type: 'friendRequest', fromId: ws.id, fromName: p.name });
      } else if (d.action === 'accept') {
        const fid = byName(String(d.name || ''));
        if (fid) {
          p.friends.add(fid);
          const target = players.get(fid);
          if (target) target.friends.add(ws.id);
          send(ws, { type: 'friendList', friends: friendsSnapshots(ws.id) });
          if (target) { send(target.ws, { type: 'friendList', friends: friendsSnapshots(fid) }); send(target.ws, { type: 'friendResult', ok: true, text: p.name + ' 接受了你的好友申请' }); }
        }
      } else if (d.action === 'decline') {
        const fid = byName(String(d.name || ''));
        if (fid) { const target = players.get(fid); if (target) send(target.ws, { type: 'friendResult', ok: false, text: p.name + ' 拒绝了你的好友申请' }); }
      } else if (d.action === 'remove') {
        const fid = byName(String(d.name || ''));
        if (fid) { p.friends.delete(fid); const target = players.get(fid); if (target) target.friends.delete(ws.id); }
        send(ws, { type: 'friendList', friends: friendsSnapshots(ws.id) });
      }
    }
  });

  ws.on('close', () => {
    const p = players.get(ws.id);
    players.delete(ws.id);
    for (const [id, q] of players) send(q.ws, { type: 'leave', id: ws.id });
    if (p) {
      for (const [id, q] of players) {
        send(q.ws, { type: 'chat', channel: 'world', name: '系统', text: p.name + ' 离开了宇宙' });
        if (q.friends && q.friends.has(ws.id)) { send(q.ws, { type: 'friendList', friends: friendsSnapshots(id) }); send(q.ws, { type: 'friendOffline', name: p.name }); }
      }
    }
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
