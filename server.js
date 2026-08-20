const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();
const IMAGE_URL_REGEX = /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?(#\S*)?$/i;

function isValidAvatarUrl(url) { return typeof url === 'string' && url.length <= 1000 && IMAGE_URL_REGEX.test(url.trim()); }
function genId(size=16) { return crypto.randomBytes(size).toString('hex'); }
function genRoomCode() { const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do code=Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); while(rooms.has(code)); return code; }
function send(ws,type,payload={}) { if(ws&&ws.readyState===ws.OPEN) ws.send(JSON.stringify({type,payload})); }
function newParticipant(id,ws,name) { return {id,ws,name,avatarUrl:null,muted:false,broadcasts:{screen:{active:false,streamId:null},camera:{active:false,streamId:null}}}; }
function publicParticipant(p) { return {id:p.id,name:p.name,avatarUrl:p.avatarUrl,muted:p.muted,broadcasts:{screen:{...p.broadcasts.screen},camera:{...p.broadcasts.camera}}}; }
function roomParticipantsList(room) { return Array.from(room.participants.values()).map(publicParticipant); }
function broadcastToRoom(room,type,payload={},exceptId=null) { for(const p of room.participants.values()) if(p.id!==exceptId) send(p.ws,type,payload); }
function broadcastParticipants(room) { broadcastToRoom(room,'participants-update',{participants:roomParticipantsList(room),ownerId:room.ownerId}); }
function closeRoomIfEmpty(room) { if(room.participants.size===0) rooms.delete(room.id); }
function leaveCurrentRoom(ws,notify=true) { const {roomId,clientId}=ws.meta||{}; if(!roomId)return; const room=rooms.get(roomId); if(!room)return; room.participants.delete(clientId); if(room.ownerId===clientId){const next=room.participants.values().next().value;room.ownerId=next?next.id:null;if(next)send(next.ws,'ownership-transferred',{newOwnerId:next.id,reason:'owner-left'});} if(notify){broadcastToRoom(room,'participant-left',{id:clientId});broadcastParticipants(room)} closeRoomIfEmpty(room);ws.meta={}; }

wss.on('connection',ws=>{
  ws.isAlive=true;ws.meta={};ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw)}catch{return send(ws,'error',{message:'Mensagem invalida.'})}
    const {type,payload={}}=msg;
    switch(type){
      case'create-room':{
        const userName=String(payload.userName||'Anfitriao').trim().slice(0,40),roomName=String(payload.roomName||'Sala Kpnc').trim().slice(0,60),password=payload.password?String(payload.password).slice(0,100):null,roomId=genRoomCode(),clientId=genId(8);
        const room={id:roomId,name:roomName,password,ownerId:clientId,participants:new Map(),createdAt:Date.now()};room.participants.set(clientId,newParticipant(clientId,ws,userName));rooms.set(roomId,room);ws.meta={roomId,clientId};
        send(ws,'room-created',{roomId,roomName:room.name,selfId:clientId,isOwner:true,hasPassword:!!room.password,ownerId:room.ownerId,participants:roomParticipantsList(room)});break;
      }
      case'join-room':{
        const roomId=String(payload.roomId||'').trim().toUpperCase(),userName=String(payload.userName||'Convidado').trim().slice(0,40),room=rooms.get(roomId);
        if(!room)return send(ws,'error',{message:'Sala nao encontrada.',code:'ROOM_NOT_FOUND'});if(room.password&&room.password!==String(payload.password||''))return send(ws,'error',{message:'Senha incorreta.',code:'WRONG_PASSWORD'});
        const clientId=genId(8);room.participants.set(clientId,newParticipant(clientId,ws,userName));ws.meta={roomId,clientId};
        send(ws,'room-joined',{roomId,roomName:room.name,selfId:clientId,isOwner:room.ownerId===clientId,hasPassword:!!room.password,ownerId:room.ownerId,participants:roomParticipantsList(room)});
        broadcastToRoom(room,'participant-joined',{participant:publicParticipant(room.participants.get(clientId))},clientId);broadcastParticipants(room);break;
      }
      case'leave-room':leaveCurrentRoom(ws,true);break;
      case'signal':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId);if(!room||!clientId)return;const target=room.participants.get(payload.to);if(target)send(target.ws,'signal',{from:clientId,data:payload.data});break;}
      case'chat-message':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId),author=room?.participants.get(clientId),text=String(payload.text||'').slice(0,1000).trim();if(!room||!clientId||!text)return;broadcastToRoom(room,'chat-message',{id:genId(6),authorId:clientId,name:author?.name||'Desconhecido',text,time:Date.now()});break;}
      case'start-broadcast':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId),p=room?.participants.get(clientId);if(!room||!p)return;const kind=payload.kind==='camera'?'camera':'screen',streamId=String(payload.streamId||'').slice(0,200)||null;p.broadcasts[kind]={active:true,streamId};broadcastToRoom(room,'broadcast-started',{id:clientId,kind,streamId},clientId);broadcastParticipants(room);break;}
      case'stop-broadcast':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId),p=room?.participants.get(clientId);if(!room||!p)return;const kind=payload.kind==='camera'?'camera':'screen';p.broadcasts[kind]={active:false,streamId:null};broadcastToRoom(room,'broadcast-stopped',{id:clientId,kind},clientId);broadcastParticipants(room);break;}
      case'toggle-mute':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId),p=room?.participants.get(clientId);if(!room||!p)return;p.muted=!!payload.muted;broadcastToRoom(room,'participant-muted',{id:clientId,muted:p.muted},clientId);broadcastParticipants(room);break;}
      case'update-profile':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId),p=room?.participants.get(clientId);if(!room||!p)return;let changed=false;if(typeof payload.name==='string'&&payload.name.trim()){p.name=payload.name.trim().slice(0,40);changed=true}if(payload.avatarUrl===''||payload.avatarUrl===null){p.avatarUrl=null;changed=true}else if(typeof payload.avatarUrl==='string'){const avatar=payload.avatarUrl.trim();if(!isValidAvatarUrl(avatar))return send(ws,'error',{message:'A foto de perfil precisa ser um link direto de imagem .png, .jpg, .jpeg, .webp ou .gif.'});p.avatarUrl=avatar;changed=true}if(changed)broadcastParticipants(room);break;}
      case'kick-participant':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId);if(!room||room.ownerId!==clientId)return send(ws,'error',{message:'Apenas o dono da sala pode expulsar participantes.'});const target=room.participants.get(payload.targetId);if(!target||target.id===clientId)return;send(target.ws,'kicked',{});room.participants.delete(target.id);target.ws.meta={};broadcastToRoom(room,'participant-left',{id:target.id});broadcastParticipants(room);break;}
      case'transfer-ownership':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId);if(!room||room.ownerId!==clientId)return send(ws,'error',{message:'Apenas o dono da sala pode transferir a posse.'});const target=room.participants.get(payload.targetId);if(!target)return;room.ownerId=target.id;broadcastToRoom(room,'ownership-transferred',{newOwnerId:target.id,reason:'transferred'});broadcastParticipants(room);break;}
      case'change-password':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId);if(!room||room.ownerId!==clientId)return send(ws,'error',{message:'Apenas o dono da sala pode alterar a senha.'});room.password=payload.password?String(payload.password).slice(0,100):null;broadcastToRoom(room,'password-changed',{hasPassword:!!room.password});break;}
      case'remove-password':{const {roomId,clientId}=ws.meta||{},room=rooms.get(roomId);if(!room||room.ownerId!==clientId)return send(ws,'error',{message:'Apenas o dono da sala pode remover a senha.'});room.password=null;broadcastToRoom(room,'password-changed',{hasPassword:false});break;}
      default:send(ws,'error',{message:`Tipo de mensagem desconhecido: ${type}`});
    }
  });
  ws.on('close',()=>leaveCurrentRoom(ws,true));ws.on('error',()=>leaveCurrentRoom(ws,true));
});
const heartbeat=setInterval(()=>{wss.clients.forEach(ws=>{if(ws.isAlive===false)return ws.terminate();ws.isAlive=false;ws.ping()})},30000);wss.on('close',()=>clearInterval(heartbeat));
server.listen(PORT,()=>console.log(`Kpnc Broadcasts rodando em http://localhost:${PORT}`));
