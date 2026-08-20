/**
 * Kpnc Telas
 * Servidor de signaling e gerenciamento de salas (WebRTC mesh).
 * O servidor NUNCA toca em midia: apenas troca mensagens de sinalizacao
 * (SDP/ICE), gerencia salas, participantes, perfis e o chat em tempo real.
 * Midia (tela, camera e chamada de voz) trafega direto entre navegadores.
 *
 * Desenvolvido por Jp Dev's
 */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * rooms: Map<roomId, Room>
 * Room = {
 *   id, name, password (string|null), ownerId,
 *   participants: Map<clientId, Participant>,
 *   createdAt
 * }
 * Participant = {
 *   id, ws, name, avatarUrl, muted,
 *   broadcasts: {
 *     screen: {active, streamId},
 *     camera: {active, streamId},
 *     voice:  {active, streamId}   // chamada de voz
 *   }
 * }
 */
const rooms = new Map();
const BROADCAST_KINDS = new Set(['screen', 'camera', 'voice']);

// Aceita apenas links diretos de imagem .png/.jpg/.jpeg (http/https)
function isValidAvatarUrl(url) {
  if (typeof url !== 'string') return false;
  const value = url.trim();
  if (!value || value.length > 800 || /[\s<>"']/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function genId(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem caracteres ambiguos
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function newParticipant(id, ws, name, avatarUrl) {
  return {
    id,
    ws,
    name,
    avatarUrl: isValidAvatarUrl(avatarUrl) ? avatarUrl.trim() : null,
    muted: true,
    broadcasts: {
      screen: { active: false, streamId: null },
      camera: { active: false, streamId: null },
      voice: { active: false, streamId: null }
    }
  };
}

function publicParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    avatarUrl: p.avatarUrl,
    muted: p.muted,
    broadcasts: p.broadcasts
  };
}

function roomParticipantsList(room) {
  return Array.from(room.participants.values()).map(publicParticipant);
}

function broadcastToRoom(room, type, payload = {}, exceptId = null) {
  for (const p of room.participants.values()) {
    if (p.id !== exceptId) send(p.ws, type, payload);
  }
}

function broadcastParticipants(room) {
  broadcastToRoom(room, 'participants-update', {
    participants: roomParticipantsList(room),
    ownerId: room.ownerId
  });
}

function closeRoomIfEmpty(room) {
  if (room.participants.size === 0) {
    rooms.delete(room.id);
  }
}

function leaveCurrentRoom(ws, notify = true) {
  const { roomId, clientId } = ws.meta || {};
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants.delete(clientId);

  if (room.ownerId === clientId) {
    const next = room.participants.values().next().value;
    room.ownerId = next ? next.id : null;
    if (next) send(next.ws, 'ownership-transferred', { newOwnerId: next.id, reason: 'owner-left' });
  }

  if (notify) {
    broadcastToRoom(room, 'participant-left', { id: clientId });
    broadcastParticipants(room);
  }

  closeRoomIfEmpty(room);
  ws.meta = {};
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = {}; // { roomId, clientId }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { message: 'Mensagem invalida.' });
    }

    const { type, payload = {} } = msg;

    switch (type) {
      case 'create-room': {
        const userName = (payload.userName || 'Anfitriao').toString().slice(0, 40);
        const roomName = (payload.roomName || 'Sala Kpnc').toString().slice(0, 60);
        const password = payload.password ? String(payload.password).slice(0, 100) : null;

        const roomId = genRoomCode();
        const clientId = genId(8);

        const room = {
          id: roomId,
          name: roomName,
          password,
          ownerId: clientId,
          participants: new Map(),
          createdAt: Date.now()
        };
        room.participants.set(clientId, newParticipant(clientId, ws, userName, payload.avatarUrl));
        rooms.set(roomId, room);

        ws.meta = { roomId, clientId };

        send(ws, 'room-created', {
          roomId,
          roomName: room.name,
          selfId: clientId,
          isOwner: true,
          hasPassword: !!room.password,
          ownerId: room.ownerId,
          participants: roomParticipantsList(room)
        });
        break;
      }

      case 'join-room': {
        const roomId = (payload.roomId || '').toString().trim().toUpperCase();
        const userName = (payload.userName || 'Convidado').toString().slice(0, 40);
        const room = rooms.get(roomId);

        if (!room) return send(ws, 'error', { message: 'Sala nao encontrada.', code: 'ROOM_NOT_FOUND' });
        if (room.password && room.password !== String(payload.password || '')) {
          return send(ws, 'error', { message: 'Senha incorreta.', code: 'WRONG_PASSWORD' });
        }

        const clientId = genId(8);
        room.participants.set(clientId, newParticipant(clientId, ws, userName, payload.avatarUrl));
        ws.meta = { roomId, clientId };

        send(ws, 'room-joined', {
          roomId,
          roomName: room.name,
          selfId: clientId,
          isOwner: room.ownerId === clientId,
          hasPassword: !!room.password,
          ownerId: room.ownerId,
          participants: roomParticipantsList(room)
        });

        broadcastToRoom(room, 'participant-joined', {
          participant: publicParticipant(room.participants.get(clientId))
        }, clientId);
        broadcastParticipants(room);
        break;
      }

      case 'leave-room': {
        leaveCurrentRoom(ws, true);
        break;
      }

      // Retransmissao pura de SDP/ICE entre dois peers da mesma sala
      case 'signal': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const target = room.participants.get(payload.to);
        if (!target) return;
        send(target.ws, 'signal', { from: clientId, data: payload.data });
        break;
      }

      case 'chat-message': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const author = room.participants.get(clientId);
        const text = (payload.text || '').toString().slice(0, 1000).trim();
        if (!text) return;
        broadcastToRoom(room, 'chat-message', {
          id: genId(6),
          authorId: clientId,
          name: author ? author.name : 'Desconhecido',
          text,
          time: Date.now()
        });
        break;
      }

      // payload: { kind: 'screen' | 'camera' | 'voice', streamId }
      case 'start-broadcast': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const p = room.participants.get(clientId);
        if (!p) return;
        const kind = BROADCAST_KINDS.has(payload.kind) ? payload.kind : 'screen';
        const streamId = (payload.streamId || '').toString().slice(0, 200) || null;

        p.broadcasts[kind] = { active: true, streamId };
        broadcastToRoom(room, 'broadcast-started', { id: clientId, kind, streamId }, clientId);
        broadcastParticipants(room);
        break;
      }

      // payload: { kind: 'screen' | 'camera' | 'voice' }
      case 'stop-broadcast': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const p = room.participants.get(clientId);
        if (!p) return;
        const kind = BROADCAST_KINDS.has(payload.kind) ? payload.kind : 'screen';

        p.broadcasts[kind] = { active: false, streamId: null };
        broadcastToRoom(room, 'broadcast-stopped', { id: clientId, kind }, clientId);
        broadcastParticipants(room);
        break;
      }

      case 'toggle-mute': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const p = room.participants.get(clientId);
        if (!p) return;
        p.muted = !!payload.muted;
        broadcastToRoom(room, 'participant-muted', { id: clientId, muted: p.muted }, clientId);
        break;
      }

      // Edição de perfil em tempo real: nome e/ou foto (link HTTP/HTTPS de imagem)
      case 'update-profile': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || !clientId) return;
        const p = room.participants.get(clientId);
        if (!p) return;

        if (typeof payload.name === 'string' && payload.name.trim()) {
          p.name = payload.name.trim().slice(0, 40);
        }

        if (payload.avatarUrl === '' || payload.avatarUrl === null) {
          p.avatarUrl = null;
        } else if (typeof payload.avatarUrl === 'string') {
          if (!isValidAvatarUrl(payload.avatarUrl)) {
            return send(ws, 'error', { message: 'A foto de perfil precisa ser uma URL HTTP/HTTPS válida.' });
          }
          p.avatarUrl = payload.avatarUrl.trim();
        }

        broadcastParticipants(room);
        break;
      }

      case 'kick-participant': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode expulsar participantes.' });
        const target = room.participants.get(payload.targetId);
        if (!target || target.id === clientId) return;

        send(target.ws, 'kicked', {});
        room.participants.delete(target.id);
        target.ws.meta = {};

        broadcastToRoom(room, 'participant-left', { id: target.id });
        broadcastParticipants(room);
        break;
      }

      case 'transfer-ownership': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode transferir a posse.' });
        const target = room.participants.get(payload.targetId);
        if (!target) return;

        room.ownerId = target.id;
        broadcastToRoom(room, 'ownership-transferred', { newOwnerId: target.id, reason: 'transferred' });
        broadcastParticipants(room);
        break;
      }

      case 'change-password': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode alterar a senha.' });
        room.password = payload.password ? String(payload.password).slice(0, 100) : null;
        broadcastToRoom(room, 'password-changed', { hasPassword: !!room.password });
        break;
      }

      case 'remove-password': {
        const { roomId, clientId } = ws.meta || {};
        const room = rooms.get(roomId);
        if (!room || room.ownerId !== clientId) return send(ws, 'error', { message: 'Apenas o dono da sala pode remover a senha.' });
        room.password = null;
        broadcastToRoom(room, 'password-changed', { hasPassword: false });
        break;
      }

      default:
        send(ws, 'error', { message: `Tipo de mensagem desconhecido: ${type}` });
    }
  });

  ws.on('close', () => leaveCurrentRoom(ws, true));
  ws.on('error', () => leaveCurrentRoom(ws, true));
});

// Ping/pong para derrubar conexoes mortas
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Kpnc Telas rodando em http://localhost:${PORT}`);
  console.log(`Desenvolvido por Jp Dev's`);
});
