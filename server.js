/**
 * Kpnc Telas
 * Servidor de signaling e gerenciamento de salas (WebRTC mesh).
 * A mídia nunca passa pelo servidor: apenas signaling, salas, perfis e chat.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();

// Entrega o cliente corrigido sem depender de cache do navegador/CDN.
app.get('/js/app.js', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'js', 'app-fixed.js'));
});
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// TURN opcional para conexões que não conseguem estabelecer P2P direto.
// Configure no host: TURN_URL, TURN_USERNAME e TURN_CREDENTIAL.
app.get('/api/rtc-config', (_req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const turnUrl = String(process.env.TURN_URL || '').trim();
  const turnUser = String(process.env.TURN_USERNAME || '').trim();
  const turnCredential = String(process.env.TURN_CREDENTIAL || '').trim();
  if (turnUrl && turnUser && turnCredential) {
    iceServers.push({ urls: turnUrl, username: turnUser, credential: turnCredential });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
const BROADCAST_KINDS = new Set(['screen', 'camera', 'voice']);

function isValidAvatarUrl(url) {
  if (typeof url !== 'string') return false;
  const value = url.trim();
  if (!value || value.length > 800 || /[\s<>"']/.test(value)) return false;
  try { const parsed = new URL(value); return parsed.protocol === 'http:' || parsed.protocol === 'https:'; }
  catch { return false; }
}
function genId(size = 16) { return crypto.randomBytes(size).toString('hex'); }
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function send(ws, type, payload = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload }));
}
function newParticipant(id, ws, name, avatarUrl) {
  return { id, ws, name, avatarUrl: isValidAvatarUrl(avatarUrl) ? avatarUrl.trim() : null, muted: true,
    broadcasts: { screen: { active: false, streamId: null }, camera: { active: false, streamId: null }, voice: { active: false, streamId: null } } };
}
function publicParticipant(p) { return { id: p.id, name: p.name, avatarUrl: p.avatarUrl, muted: p.muted, broadcasts: p.broadcasts }; }
function roomParticipantsList(room) { return Array.from(room.participants.values()).map(publicParticipant); }
function broadcastToRoom(room, type, payload = {}, exceptId = null) { for (const p of room.participants.values()) if (p.id !== exceptId) send(p.ws, type, payload); }
function broadcastParticipants(room) { broadcastToRoom(room, 'participants-update', { participants: roomParticipantsList(room), ownerId: room.ownerId }); }
function closeRoomIfEmpty(room) { if (room.participants.size === 0) rooms.delete(room.id); }
function leaveCurrentRoom(ws, notify = true) {
  const { roomId, clientId } = ws.meta || {}; if (!roomId) return;
  const room = rooms.get(roomId); if (!room) return;
  room.participants.delete(clientId);
  if (room.ownerId === clientId) {
    const next = room.participants.values().next().value; room.ownerId = next ? next.id : null;
    if (next) send(next.ws, 'ownership-transferred', { newOwnerId: next.id, reason: 'owner-left' });
  }
  if (notify) { broadcastToRoom(room, 'participant-left', { id: clientId }); broadcastParticipants(room); }
  closeRoomIfEmpty(room); ws.meta = {};
}

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.meta = {};
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return send(ws, 'error', { message: 'Mensagem inválida.' }); }
    const { type, payload = {} } = msg;
    switch (type) {
      case 'create-room': {
        const userName = String(payload.userName || 'Anfitrião').slice(0, 40);
        const roomName = String(payload.roomName || 'Sala Kpnc').slice(0, 60);
        const password = payload.password ? String(payload.password).slice(0, 100) : null;
        const roomId = genRoomCode(); const clientId = genId(8);
        const room = { id: roomId, name: roomName, password, ownerId: clientId, participants: new Map(), createdAt: Date.now() };
        room.participants.set(clientId, newParticipant(clientId, ws, userName, payload.avatarUrl)); rooms.set(roomId, room); ws.meta = { roomId, clientId };
        send(ws, 'room-created', { roomId, roomName: room.name, selfId: clientId, isOwner: true, hasPassword: !!room.password, ownerId: room.ownerId, participants: roomParticipantsList(room) });
        break;
      }
      case 'join-room': {
        const roomId = String(payload.roomId || '').trim().toUpperCase(); const userName = String(payload.userName || 'Convidado').slice(0, 40); const room = rooms.get(roomId);
        if (!room) return send(ws, 'error', { message: 'Sala não encontrada.', code: 'ROOM_NOT_FOUND' });
        if (room.password && room.password !== String(payload.password || '')) return send(ws, 'error', { message: 'Senha incorreta.', code: 'WRONG_PASSWORD' });
        const clientId = genId(8); room.participants.set(clientId, newParticipant(clientId, ws, userName, payload.avatarUrl)); ws.meta = { roomId, clientId };
        send(ws, 'room-joined', { roomId, roomName: room.name, selfId: clientId, isOwner: room.ownerId === clientId, hasPassword: !!room.password, ownerId: room.ownerId, participants: roomParticipantsList(room) });
        broadcastToRoom(room, 'participant-joined', { participant: publicParticipant(room.participants.get(clientId)) }, clientId); broadcastParticipants(room); break;
      }
      case 'leave-room': leaveCurrentRoom(ws, true); break;
      case 'signal': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const target = room.participants.get(payload.to); if (!target) return;
        send(target.ws, 'signal', { from: clientId, data: payload.data }); break;
      }
      case 'chat-message': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const author = room.participants.get(clientId); const text = String(payload.text || '').slice(0, 1000).trim(); if (!text) return;
        broadcastToRoom(room, 'chat-message', { id: genId(6), authorId: clientId, name: author ? author.name : 'Desconhecido', text, time: Date.now() }); break;
      }
      case 'start-broadcast': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const p = room.participants.get(clientId); if (!p) return;
        const kind = BROADCAST_KINDS.has(payload.kind) ? payload.kind : 'screen'; const streamId = String(payload.streamId || '').slice(0, 200) || null;
        p.broadcasts[kind] = { active: true, streamId }; broadcastToRoom(room, 'broadcast-started', { id: clientId, kind, streamId }, clientId); broadcastParticipants(room); break;
      }
      case 'stop-broadcast': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const p = room.participants.get(clientId); if (!p) return;
        const kind = BROADCAST_KINDS.has(payload.kind) ? payload.kind : 'screen'; p.broadcasts[kind] = { active: false, streamId: null }; broadcastToRoom(room, 'broadcast-stopped', { id: clientId, kind }, clientId); broadcastParticipants(room); break;
      }
      case 'toggle-mute': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const p = room.participants.get(clientId); if (!p) return;
        p.muted = !!payload.muted; broadcastToRoom(room, 'participant-muted', { id: clientId, muted: p.muted }, clientId); broadcastParticipants(room); break;
      }
      case 'update-profile': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || !clientId) return; const p = room.participants.get(clientId); if (!p) return;
        if (typeof payload.name === 'string' && payload.name.trim()) p.name = payload.name.trim().slice(0, 40);
        if (payload.avatarUrl === '' || payload.avatarUrl === null) p.avatarUrl = null;
        else if (typeof payload.avatarUrl === 'string') { if (!isValidAvatarUrl(payload.avatarUrl)) return send(ws, 'error', { message: 'A foto de perfil precisa ser uma URL HTTP/HTTPS válida.' }); p.avatarUrl = payload.avatarUrl.trim(); }
        broadcastParticipants(room); break;
      }
      case 'kick-participant': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode expulsar participantes.' }); const target = room.participants.get(payload.targetId); if (!target || target.id === clientId) return;
        send(target.ws, 'kicked', {}); room.participants.delete(target.id); target.ws.meta = {}; broadcastToRoom(room, 'participant-left', { id: target.id }); broadcastParticipants(room); break;
      }
      case 'transfer-ownership': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode transferir a posse.' }); const target = room.participants.get(payload.targetId); if (!target) return;
        room.ownerId = target.id; broadcastToRoom(room, 'ownership-transferred', { newOwnerId: target.id, reason: 'transferred' }); broadcastParticipants(room); break;
      }
      case 'change-password': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode alterar a senha.' }); room.password = payload.password ? String(payload.password).slice(0, 100) : null; broadcastToRoom(room, 'password-changed', { hasPassword: !!room.password }); break;
      }
      case 'remove-password': {
        const { roomId, clientId } = ws.meta || {}; const room = rooms.get(roomId); if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode remover a senha.' }); room.password = null; broadcastToRoom(room, 'password-changed', { hasPassword: false }); break;
      }
      default: send(ws, 'error', { message: `Tipo de mensagem desconhecido: ${type}` });
    }
  });
  ws.on('close', () => leaveCurrentRoom(ws, true));
  ws.on('error', () => leaveCurrentRoom(ws, true));
});

const heartbeat = setInterval(() => { wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); }); }, 30000);
wss.on('close', () => clearInterval(heartbeat));
server.listen(PORT, () => console.log(`Kpnc Telas rodando na porta ${PORT}`));
