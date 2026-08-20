(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const QUALITY = {
    auto: {},
    '1080p': { width: 1920, height: 1080, frameRate: 30 },
    '720p': { width: 1280, height: 720, frameRate: 30 },
    '480p': { width: 854, height: 480, frameRate: 24 }
  };
  const el = {
    home: $('#screen-home'), room: $('#screen-room'), homeError: $('#home-error'),
    createForm: $('#form-create'), joinForm: $('#form-join'), createUsername: $('#create-username'), createRoomname: $('#create-roomname'), createAvatar: $('#create-avatar'), createLock: $('#create-lock'), createPasswordWrap: $('#create-password-wrap'), createPassword: $('#create-password'),
    joinUsername: $('#join-username'), joinRoomcode: $('#join-roomcode'), joinAvatar: $('#join-avatar'), joinPassword: $('#join-password'), homeTabs: $$('.home-tab'), homeForms: $$('.home-form'),
    themeToggle: $('#theme-toggle'), themeToggleRoom: $('#theme-toggle-room'),
    rail: $('#rail'), btnRailClose: $('#btn-rail-close'), roomName: $('#room-indicator-name'), roomCode: $('#room-indicator-code'), stageRoomName: $('#stage-room-name'), participants: $('#participants-list'), count: $('#count-participants'),
    btnMenu: $('#btn-menu'), btnExpand: $('#btn-expand'), btnInvite: $('#btn-invite'), btnMixer: $('#btn-mixer'),
    grid: $('#video-grid'), empty: $('#stage-empty'), selfPreviewWrap: $('#self-preview-wrap'), selfPreview: $('#self-preview'), selfEmpty: $('#self-preview-empty'), voicePool: $('#voice-audio-pool'),
    btnCall: $('#btn-call'), btnCallLabel: $('#btn-call-label'), btnMic: $('#btn-mic'), btnMicLabel: $('#btn-mic-label'), btnDeafen: $('#btn-deafen'), btnCamera: $('#btn-camera'), btnBroadcast: $('#btn-broadcast'), btnSettings: $('#btn-settings'), btnLeave: $('#btn-leave'),
    sidePanel: $('#side-panel'), btnPanelClose: $('#btn-panel-close'), sideTabs: $$('.side-tab'), sideContents: $$('.side-content'), backdrop: $('#drawer-backdrop'),
    chatForm: $('#form-chat'), chatInput: $('#chat-input'), chat: $('#chat-messages'),
    rangeMaster: $('#range-master'), checkboxDeafenMixer: $('#checkbox-deafen-mixer'), mixerBroadcasts: $('#mixer-broadcasts'), mixerVoices: $('#mixer-voices'),
    inviteLink: $('#invite-link'), btnCopyLink: $('#btn-copy-link'), inviteCode: $('#invite-code'), btnCopyCode: $('#btn-copy-code'),
    ownerPassword: $('#owner-password-block'), newPassword: $('#new-password'), btnSavePassword: $('#btn-save-password'),
    profileName: $('#profile-name'), profileAvatar: $('#profile-avatar'), profileError: $('#profile-error'), btnSaveProfile: $('#btn-save-profile'),
    quality: $('#select-quality'), micSelect: $('#select-mic'), noise: $('#checkbox-noise-suppression'), speaker: $('#select-speaker'), speakerHint: $('#speaker-support-hint'), toast: $('#toast-container')
  };
  const state = {
    ws: null, selfId: null, selfName: '', selfAvatar: '', roomId: null, roomName: '', roomPassword: '', ownerId: null, isOwner: false, hasPassword: false,
    participants: new Map(), peers: new Map(), remoteMedia: new Map(), audioPrefs: new Map(), speaking: new Map(), audioCtx: null,
    localScreen: null, localCamera: null, localMic: null, screenStreamForPeers: null, cameraStreamForPeers: null, micStreamForPeers: null,
    screenOn: false, cameraOn: false, inCall: false, micMuted: true, deafened: false, quality: '720p', noiseSuppression: true, micDeviceId: '', speakerDeviceId: '', masterVolume: 1,
    rtcConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }, reconnectTimer: null, reconnecting: false
  };

  function toast(message, kind = 'info') {
    if (!el.toast) return;
    const n = document.createElement('div'); n.className = `toast${kind === 'error' ? ' toast-error' : ''}${kind === 'success' ? ' toast-success' : ''}`; n.textContent = message; el.toast.appendChild(n); setTimeout(() => n.remove(), 4200);
  }
  function homeError(message) { if (!el.homeError) return; el.homeError.textContent = message; el.homeError.classList.remove('hidden'); }
  function clearHomeError() { el.homeError?.classList.add('hidden'); if (el.homeError) el.homeError.textContent = ''; }
  function validAvatar(url) { if (!url) return true; if (url.length > 800 || /[\s<>"']/.test(url)) return false; try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
  function send(type, payload = {}) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type, payload })); }

  async function loadRtcConfig() {
    try { const r = await fetch('/api/rtc-config', { cache: 'no-store' }); if (r.ok) { const data = await r.json(); if (Array.isArray(data.iceServers) && data.iceServers.length) state.rtcConfig.iceServers = data.iceServers; } } catch { /* STUN fallback */ }
  }

  function connect() {
    if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`); state.ws = ws; let settled = false;
      ws.addEventListener('open', () => { settled = true; state.reconnecting = false; resolve(); });
      ws.addEventListener('error', () => { if (!settled) reject(new Error('socket')); });
      ws.addEventListener('message', (e) => { try { const m = JSON.parse(e.data); handleMessage(m.type, m.payload || {}); } catch (err) { console.warn('Mensagem inválida', err); } });
      ws.addEventListener('close', () => {
        if (!state.roomId || state.reconnecting) return;
        state.reconnecting = true; toast('Conexão perdida. Tentando reconectar...', 'error');
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(reconnectRoom, 1500);
      });
    });
  }
  async function reconnectRoom() {
    if (!state.roomId) return;
    try { await connect(); send('join-room', { userName: state.selfName, roomId: state.roomId, password: state.roomPassword, avatarUrl: state.selfAvatar }); }
    catch { state.reconnectTimer = setTimeout(reconnectRoom, 2500); }
  }

  function handleMessage(type, p) {
    switch (type) {
      case 'room-created': case 'room-joined': enterRoom(p); break;
      case 'error': state.roomId ? toast(p.message || 'Erro no servidor.', 'error') : homeError(p.message || 'Não foi possível concluir a operação.'); break;
      case 'participant-joined': if (p.participant) { state.participants.set(p.participant.id, p.participant); ensurePeer(p.participant.id); renderParticipants(); addSystem(`${p.participant.name} entrou na sala.`); } break;
      case 'participant-left': removeParticipant(p.id); break;
      case 'participants-update': syncParticipants(p.participants || [], p.ownerId); break;
      case 'signal': handleSignal(p.from, p.data); break;
      case 'chat-message': addChatMessage(p); break;
      case 'participant-muted': { const x = state.participants.get(p.id); if (x) { x.muted = !!p.muted; renderParticipants(); } break; }
      case 'ownership-transferred': state.ownerId = p.newOwnerId; state.isOwner = state.selfId === state.ownerId; updateOwnerUI(); renderParticipants(); break;
      case 'password-changed': state.hasPassword = !!p.hasPassword; updateOwnerUI(); break;
      case 'kicked': cleanup(true); toast('Você foi removido da sala.', 'error'); break;
    }
  }
  function syncParticipants(list, ownerId) {
    const incoming = new Set();
    for (const p of list) { incoming.add(p.id); state.participants.set(p.id, p); if (p.id !== state.selfId) ensurePeer(p.id); syncRemoteState(p); }
    for (const id of Array.from(state.participants.keys())) if (!incoming.has(id)) removeParticipant(id, true);
    if (ownerId) state.ownerId = ownerId; state.isOwner = state.selfId === state.ownerId; renderParticipants(); updateOwnerUI(); renderMixer();
  }
  function enterRoom(p) {
    state.selfId = p.selfId; state.roomId = p.roomId; state.roomName = p.roomName; state.ownerId = p.ownerId; state.isOwner = !!p.isOwner; state.hasPassword = !!p.hasPassword;
    state.participants.clear(); for (const x of p.participants || []) state.participants.set(x.id, x);
    el.home?.classList.add('hidden'); el.room?.classList.remove('hidden');
    el.roomName.textContent = state.roomName; el.roomCode.textContent = state.roomId; el.stageRoomName.textContent = state.roomName; el.inviteCode.textContent = state.roomId; el.inviteLink.value = `${location.origin}${location.pathname}?room=${state.roomId}`;
    el.profileName.value = state.selfName; el.profileAvatar.value = state.selfAvatar || ''; el.chat.innerHTML = '';
    renderParticipants(); updateOwnerUI(); updateButtons(); populateDevices();
    for (const x of p.participants || []) if (x.id !== state.selfId) ensurePeer(x.id);
    addSystem(`Você entrou na sala "${state.roomName}".`);
  }

  async function createOrJoin(kind) {
    clearHomeError();
    const create = kind === 'create'; const name = (create ? el.createUsername : el.joinUsername).value.trim(); const room = create ? el.createRoomname.value.trim() : el.joinRoomcode.value.trim().toUpperCase(); const avatar = (create ? el.createAvatar : el.joinAvatar).value.trim();
    if (!name || !room) return homeError(create ? 'Preencha seu nome e o nome da sala.' : 'Preencha seu nome e o código da sala.');
    if (avatar && !validAvatar(avatar)) return homeError('Use uma URL HTTP/HTTPS válida para a foto.');
    state.selfName = name; state.selfAvatar = avatar; state.roomPassword = create && el.createLock.checked ? el.createPassword.value : (!create ? el.joinPassword.value : '');
    try { await connect(); send(create ? 'create-room' : 'join-room', create ? { userName: name, roomName: room, avatarUrl: avatar, password: state.roomPassword } : { userName: name, roomId: room, password: state.roomPassword, avatarUrl: avatar }); } catch { homeError('Não foi possível conectar ao servidor.'); }
  }

  function ensurePeer(id) {
    if (!id || id === state.selfId) return null; if (state.peers.has(id)) return state.peers.get(id);
    const pc = new RTCPeerConnection(state.rtcConfig); const peer = { id, pc, polite: String(state.selfId) > String(id), makingOffer: false, ignoreOffer: false, pending: false }; state.peers.set(id, peer);
    addCurrentTracks(peer);
    pc.onicecandidate = (e) => { if (e.candidate) send('signal', { to: id, data: { type: 'candidate', candidate: e.candidate } }); };
    pc.ontrack = (e) => { const stream = e.streams[0] || new MediaStream([e.track]); handleRemoteTrack(id, stream); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch {} setTimeout(() => { if (state.peers.get(id) === peer && pc.connectionState === 'failed') recreatePeer(id); }, 2500); } else if (pc.connectionState === 'closed') destroyPeer(id); };
    pc.onnegotiationneeded = () => negotiate(peer);
    if (pc.getSenders().some(s => s.track)) queueMicrotask(() => negotiate(peer));
    return peer;
  }
  function addCurrentTracks(peer) { for (const stream of [state.screenStreamForPeers, state.cameraStreamForPeers, state.micStreamForPeers]) if (stream) for (const t of stream.getTracks()) peer.pc.addTrack(t, stream); }
  function recreatePeer(id) { destroyPeer(id); ensurePeer(id); }
  async function negotiate(peer) {
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') { peer.pending = true; return; }
    peer.makingOffer = true; try { await peer.pc.setLocalDescription(); send('signal', { to: peer.id, data: { type: 'description', description: peer.pc.localDescription } }); } catch (e) { console.warn('WebRTC negotiation', e); } finally { peer.makingOffer = false; if (peer.pending && peer.pc.signalingState === 'stable') { peer.pending = false; queueMicrotask(() => negotiate(peer)); } }
  }
  async function handleSignal(from, data) {
    const peer = ensurePeer(from); if (!peer || !data) return;
    try {
      if (data.type === 'candidate') { if (data.candidate) await peer.pc.addIceCandidate(data.candidate).catch(() => {}); return; }
      if (data.type !== 'description') return;
      const desc = data.description; const collision = desc.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable'); peer.ignoreOffer = !peer.polite && collision; if (peer.ignoreOffer) return;
      await peer.pc.setRemoteDescription(desc); if (desc.type === 'offer') { await peer.pc.setLocalDescription(); send('signal', { to: from, data: { type: 'description', description: peer.pc.localDescription } }); }
    } catch (e) { console.warn('WebRTC signaling', e); }
  }
  function destroyPeer(id) { const p = state.peers.get(id); if (p) { try { p.pc.close(); } catch {} state.peers.delete(id); } for (const key of Array.from(state.remoteMedia.keys())) if (key.startsWith(`${id}:`)) cleanupRemoteMedia(key); refreshEmpty(); }
  function removeParticipant(id, silent = false) { const p = state.participants.get(id); if (p && !silent) addSystem(`${p.name} saiu da sala.`); state.participants.delete(id); destroyPeer(id); renderParticipants(); renderMixer(); refreshEmpty(); }

  function addLocalTrackToPeers(track, stream) { for (const peer of state.peers.values()) { peer.pc.addTrack(track, stream); negotiate(peer); } }
  function removeLocalTrackFromPeers(track) { for (const peer of state.peers.values()) { const sender = peer.pc.getSenders().find(s => s.track === track); if (sender) peer.pc.removeTrack(sender); } }
  async function startScreen() {
    if (state.screenOn) return stopScreen();
    try { const q = QUALITY[state.quality]; const stream = await navigator.mediaDevices.getDisplayMedia({ video: Object.keys(q).length ? { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } } : true, audio: true }); state.localScreen = stream; state.screenOn = true; state.screenStreamForPeers = new MediaStream(); for (const t of stream.getTracks()) state.screenStreamForPeers.addTrack(t); for (const t of state.screenStreamForPeers.getTracks()) addLocalTrackToPeers(t, state.screenStreamForPeers); const vt = stream.getVideoTracks()[0]; if (vt) vt.onended = () => stopScreen(); send('start-broadcast', { kind: 'screen', streamId: state.screenStreamForPeers.id }); renderSelfPreview(); updateButtons(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Compartilhamento cancelado.' : 'Não foi possível iniciar a transmissão de tela.', 'error'); }
  }
  function stopScreen() { const s = state.localScreen; if (!s) return; for (const t of state.screenStreamForPeers?.getTracks() || []) removeLocalTrackFromPeers(t); s.getTracks().forEach(t => t.stop()); state.localScreen = null; state.screenStreamForPeers = null; state.screenOn = false; send('stop-broadcast', { kind: 'screen' }); renderSelfPreview(); updateButtons(); }
  async function startCamera() {
    if (state.cameraOn) return stopCamera();
    try { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); state.localCamera = stream; state.cameraOn = true; state.cameraStreamForPeers = new MediaStream(stream.getVideoTracks()); for (const t of state.cameraStreamForPeers.getTracks()) addLocalTrackToPeers(t, state.cameraStreamForPeers); stream.getVideoTracks()[0].onended = () => stopCamera(); send('start-broadcast', { kind: 'camera', streamId: state.cameraStreamForPeers.id }); renderSelfPreview(); updateButtons(); } catch { toast('Não foi possível acessar a câmera.', 'error'); }
  }
  function stopCamera() { const s = state.localCamera; if (!s) return; for (const t of state.cameraStreamForPeers?.getTracks() || []) removeLocalTrackFromPeers(t); s.getTracks().forEach(t => t.stop()); state.localCamera = null; state.cameraStreamForPeers = null; state.cameraOn = false; send('stop-broadcast', { kind: 'camera' }); renderSelfPreview(); updateButtons(); }
  async function joinCall() {
    if (state.inCall) return leaveCall();
    try { const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: state.micDeviceId ? { exact: state.micDeviceId } : undefined, echoCancellation: state.noiseSuppression, noiseSuppression: state.noiseSuppression, autoGainControl: state.noiseSuppression } }); state.localMic = stream; const track = stream.getAudioTracks()[0]; state.micMuted = true; track.enabled = false; state.micStreamForPeers = new MediaStream([track]); state.inCall = true; addLocalTrackToPeers(track, state.micStreamForPeers); send('start-broadcast', { kind: 'voice', streamId: state.micStreamForPeers.id }); send('toggle-mute', { muted: true }); updateButtons(); toast('Você entrou na chamada de voz.', 'success'); } catch { toast('Não foi possível acessar o microfone.', 'error'); }
  }
  function leaveCall() { if (!state.localMic) return; for (const t of state.micStreamForPeers?.getTracks() || []) removeLocalTrackFromPeers(t); state.localMic.getTracks().forEach(t => t.stop()); state.localMic = null; state.micStreamForPeers = null; state.inCall = false; state.micMuted = true; send('stop-broadcast', { kind: 'voice' }); updateButtons(); }
  function toggleMic() { if (!state.inCall) return joinCall(); state.micMuted = !state.micMuted; state.localMic?.getAudioTracks().forEach(t => t.enabled = !state.micMuted); send('toggle-mute', { muted: state.micMuted }); updateButtons(); }
  function setDeafen(v) { state.deafened = !!v; if (el.checkboxDeafenMixer) el.checkboxDeafenMixer.checked = state.deafened; if (state.deafened && state.inCall && !state.micMuted) { state.micMuted = true; state.localMic?.getAudioTracks().forEach(t => t.enabled = false); send('toggle-mute', { muted: true }); } applyAudioSettings(); updateButtons(); }

  function syncRemoteState(p) {
    for (const [key, item] of Array.from(state.remoteMedia.entries())) {
      if (item.peerId !== p.id) continue;
      const active = p.broadcasts?.[item.kind]?.active;
      if (!active || (p.broadcasts?.[item.kind]?.streamId && p.broadcasts[item.kind].streamId !== item.streamId)) cleanupRemoteMedia(key);
    }
  }
  function classify(item) { if (!item.stream.getVideoTracks().length) item.kind = 'voice'; else { const p = state.participants.get(item.peerId); item.kind = p?.broadcasts?.camera?.streamId === item.streamId ? 'camera' : 'screen'; } }
  function handleRemoteTrack(peerId, stream) { const key = `${peerId}:${stream.id}`; let item = state.remoteMedia.get(key); if (!item) { item = { peerId, streamId: stream.id, stream, kind: 'unknown', el: null }; state.remoteMedia.set(key, item); } item.stream = stream; classify(item); for (const t of stream.getTracks()) t.addEventListener('ended', () => { if (stream.getTracks().every(x => x.readyState === 'ended')) cleanupRemoteMedia(key); }, { once: true }); if (item.kind === 'voice') renderVoice(item); else renderTile(item); renderMixer(); }
  function cleanupRemoteMedia(key) { const item = state.remoteMedia.get(key); if (!item) return; item.el?.remove(); if (item.kind !== 'voice') removeTile(`${item.peerId}:${item.kind}`); state.remoteMedia.delete(key); refreshEmpty(); renderMixer(); }
  function tileKey(peerId, kind) { return `${peerId}:${kind}`; }
  function removeTile(key) { document.querySelector(`[data-tile="${CSS.escape(key)}"]`)?.remove(); }
  function pref(key) { if (!state.audioPrefs.has(key)) state.audioPrefs.set(key, { volume: 1, muted: false }); return state.audioPrefs.get(key); }
  function renderVoice(item) { let a = item.el; if (!a) { a = document.createElement('audio'); a.autoplay = true; a.playsInline = true; el.voicePool.appendChild(a); item.el = a; } a.srcObject = item.stream; applyAudioSettings(); a.play().catch(() => {}); }
  function renderTile(item) {
    const key = tileKey(item.peerId, item.kind); let tile = document.querySelector(`[data-tile="${CSS.escape(key)}"]`); if (!tile) { tile = document.createElement('article'); tile.className = 'video-tile'; tile.dataset.tile = key; tile.dataset.peer = item.peerId; tile.dataset.participant = item.peerId; tile.dataset.kind = item.kind; tile.innerHTML = '<div class="video-wrap"><video autoplay playsinline></video><div class="tile-loading">Essa transmissão ainda está carregando…</div><button class="tile-view btn btn-primary hidden" type="button">Ativar</button></div><div class="tile-meta"><span class="tile-avatar"></span><span class="tile-name"></span><span class="tile-kind"></span><button class="tile-mute" type="button">🔇</button></div>'; el.grid.appendChild(tile); tile.querySelector('.tile-view').addEventListener('click', () => { const v = tile.querySelector('video'); v.muted = false; pref(`bcast:${item.peerId}:${item.kind}`).muted = false; v.play().then(() => { tile.querySelector('.tile-view').classList.add('hidden'); }).catch(() => {}); }); tile.querySelector('.tile-mute').addEventListener('click', () => { const p = pref(`bcast:${item.peerId}:${item.kind}`); p.muted = !p.muted; applyAudioSettings(); }); }
    tile.dataset.kind = item.kind; const p = state.participants.get(item.peerId); tile.querySelector('.tile-name').textContent = p?.name || 'Participante'; tile.querySelector('.tile-kind').textContent = item.kind === 'camera' ? 'Câmera' : 'Tela'; const a = tile.querySelector('.tile-avatar'); if (p?.avatarUrl) { a.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; a.classList.add('has-image'); a.textContent = ''; } else { a.style.backgroundImage = ''; a.classList.remove('has-image'); a.textContent = (p?.name || '?')[0].toUpperCase(); }
    const v = tile.querySelector('video'); item.el = v; if (v.srcObject !== item.stream) v.srcObject = item.stream; const loading = tile.querySelector('.tile-loading'); const button = tile.querySelector('.tile-view'); const tryPlay = () => v.play().then(() => { loading.classList.add('hidden'); button.classList.add('hidden'); applyAudioSettings(); }).catch(() => { loading.classList.add('hidden'); if (!state.deafened && !pref(`bcast:${item.peerId}:${item.kind}`).muted) button.classList.remove('hidden'); }); if (v.readyState >= 2) tryPlay(); else { v.onloadedmetadata = tryPlay; v.oncanplay = tryPlay; setTimeout(() => { if (!loading.classList.contains('hidden')) tryPlay(); }, 2500); } refreshEmpty();
  }
  function applyAudioSettings() { const master = state.deafened ? 0 : state.masterVolume; for (const item of state.remoteMedia.values()) if (item.el) { const p = pref(item.kind === 'voice' ? `voice:${item.peerId}` : `bcast:${item.peerId}:${item.kind}`); item.el.muted = state.deafened || p.muted; if ('volume' in item.el) item.el.volume = Math.max(0, Math.min(1, master * p.volume)); } }
  function renderMixer() { if (!el.mixerBroadcasts || !el.mixerVoices) return; const b = Array.from(state.remoteMedia.values()).filter(i => i.kind !== 'voice'); const v = Array.from(state.remoteMedia.values()).filter(i => i.kind === 'voice'); el.mixerBroadcasts.innerHTML = b.length ? '' : '<li class="mixer-empty">Nenhuma transmissão com áudio no momento.</li>'; el.mixerVoices.innerHTML = v.length ? '' : '<li class="mixer-empty">Ninguém está em chamada de voz.</li>'; for (const i of b) el.mixerBroadcasts.appendChild(mixerRow(i.peerId, `bcast:${i.peerId}:${i.kind}`, i.kind === 'camera' ? 'Câmera' : 'Tela')); for (const i of v) el.mixerVoices.appendChild(mixerRow(i.peerId, `voice:${i.peerId}`, 'Voz')); }
  function mixerRow(peerId, key, label) { const p = state.participants.get(peerId); const pr = pref(key); const li = document.createElement('li'); li.className = 'mixer-item'; li.innerHTML = `<span class="m-avatar"></span><span class="m-info"><strong></strong><small>${label}</small></span><input type="range" min="0" max="100" value="${Math.round(pr.volume * 100)}"><button type="button">🔇</button>`; li.querySelector('strong').textContent = p?.name || 'Participante'; const r = li.querySelector('input'); r.addEventListener('input', () => { pr.volume = Number(r.value) / 100; applyAudioSettings(); }); li.querySelector('button').addEventListener('click', () => { pr.muted = !pr.muted; applyAudioSettings(); renderMixer(); }); return li; }
  function refreshEmpty() { el.empty?.classList.toggle('hidden', !!el.grid?.querySelector('.video-tile')); }
  function renderSelfPreview() { const s = state.localScreen || state.localCamera; if (!s) { el.selfPreview.srcObject = null; el.selfEmpty.classList.remove('hidden'); el.selfPreviewWrap.classList.add('hidden'); return; } el.selfPreviewWrap.classList.remove('hidden'); el.selfEmpty.classList.add('hidden'); el.selfPreview.srcObject = s; el.selfPreview.play().catch(() => {}); }

  function renderParticipants() { if (!el.participants) return; el.participants.innerHTML = ''; el.count.textContent = String(state.participants.size); for (const p of state.participants.values()) el.participants.appendChild(participantRow(p)); updateTileProfiles(); }
  function participantRow(p) { const li = document.createElement('li'); li.className = `participant-item${p.muted ? ' is-muted' : ''}`; li.dataset.participant = p.id; li.innerHTML = '<span class="participant-avatar"></span><span class="participant-main"><strong></strong><small></small></span><span class="participant-tags"></span><span class="participant-owner-actions"></span>'; const av = li.querySelector('.participant-avatar'); if (p.avatarUrl) { av.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; av.classList.add('has-image'); } else av.textContent = (p.name || '?')[0].toUpperCase(); li.querySelector('strong').textContent = p.name || 'Participante'; const b = p.broadcasts || {}; li.querySelector('small').textContent = [p.id === state.selfId ? 'Você' : 'Participante', b.voice?.active ? 'Em chamada' : '', b.screen?.active ? 'Compartilhando tela' : '', b.camera?.active ? 'Câmera ligada' : ''].filter(Boolean).join(' · '); if (p.id === state.ownerId) li.querySelector('.participant-tags').textContent = '👑'; if (state.isOwner && p.id !== state.selfId) { const a = li.querySelector('.participant-owner-actions'); const kick = document.createElement('button'); kick.type = 'button'; kick.textContent = '✕'; kick.title = 'Expulsar'; kick.onclick = () => { if (confirm(`Expulsar ${p.name} da sala?`)) send('kick-participant', { targetId: p.id }); }; const transfer = document.createElement('button'); transfer.type = 'button'; transfer.textContent = '⇄'; transfer.title = 'Transferir posse'; transfer.onclick = () => { if (confirm(`Transferir a posse para ${p.name}?`)) send('transfer-ownership', { targetId: p.id }); }; a.append(transfer, kick); } return li; }
  function updateTileProfiles() { $$('.video-tile').forEach(tile => { const p = state.participants.get(tile.dataset.peer); if (!p) return; tile.querySelector('.tile-name').textContent = p.name; }); }
  function updateOwnerUI() { el.ownerPassword?.classList.toggle('hidden', !state.isOwner); }
  function updateButtons() { if (!el.btnBroadcast) return; el.btnBroadcast.querySelector('.ctrl-label').textContent = state.screenOn ? 'Parar tela' : 'Tela'; el.btnCamera.querySelector('.ctrl-label').textContent = state.cameraOn ? 'Parar câmera' : 'Câmera'; el.btnCallLabel.textContent = state.inCall ? 'Sair' : 'Chamada'; el.btnMicLabel.textContent = state.micMuted ? 'Mudo' : 'Falando'; el.btnBroadcast.classList.toggle('active', state.screenOn); el.btnCamera.classList.toggle('active', state.cameraOn); el.btnCall.classList.toggle('active', state.inCall); el.btnMic.classList.toggle('active', state.inCall && !state.micMuted); el.btnMic.disabled = !state.inCall; el.btnDeafen.classList.toggle('active', state.deafened); }
  function addSystem(text) { if (!el.chat) return; const d = document.createElement('div'); d.className = 'chat-system'; d.textContent = text; el.chat.appendChild(d); el.chat.scrollTop = el.chat.scrollHeight; }
  function addChatMessage(p) { const d = document.createElement('div'); d.className = 'chat-message'; d.innerHTML = '<strong></strong><span></span>'; d.querySelector('strong').textContent = p.name || 'Participante'; d.querySelector('span').textContent = p.text || ''; el.chat.appendChild(d); el.chat.scrollTop = el.chat.scrollHeight; }
  function openPanel(tab) { el.sideTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab)); el.sideContents.forEach(c => c.classList.toggle('active', c.dataset.panel === tab)); el.sidePanel.classList.add('open'); el.rail.classList.remove('open'); }
  function closeDrawers() { el.sidePanel?.classList.remove('open'); el.rail?.classList.remove('open'); el.backdrop?.classList.remove('show'); }
  function applyTheme() { const saved = localStorage.getItem('kpnc-theme'); if (saved) document.documentElement.setAttribute('data-theme', saved); }
  function toggleTheme() { const next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('kpnc-theme', next); }
  async function populateDevices() { if (!navigator.mediaDevices?.enumerateDevices) return; try { const ds = await navigator.mediaDevices.enumerateDevices(); el.micSelect.innerHTML = ''; ds.filter(d => d.kind === 'audioinput').forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Microfone ${i + 1}`; el.micSelect.appendChild(o); }); el.speaker.innerHTML = ''; ds.filter(d => d.kind === 'audiooutput').forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Saída ${i + 1}`; el.speaker.appendChild(o); }); } catch {} }
  function setSpeaker() { const id = el.speaker.value; document.querySelectorAll('video,audio').forEach(m => { if (typeof m.setSinkId === 'function' && id) m.setSinkId(id).catch(() => {}); }); }
  function cleanup(skipSocket = false) { if (!skipSocket) send('leave-room'); for (const id of Array.from(state.peers.keys())) destroyPeer(id); [state.localScreen,state.localCamera,state.localMic].forEach(s => s?.getTracks().forEach(t => t.stop())); state.localScreen=state.localCamera=state.localMic=null; state.screenStreamForPeers=state.cameraStreamForPeers=state.micStreamForPeers=null; state.screenOn=state.cameraOn=state.inCall=false; state.micMuted=true; state.roomId=null; state.roomPassword=''; state.participants.clear(); state.remoteMedia.clear(); state.voicePool && (el.voicePool.innerHTML=''); el.grid?.querySelectorAll('.video-tile').forEach(x=>x.remove()); closeDrawers(); el.room?.classList.add('hidden'); el.home?.classList.remove('hidden'); refreshEmpty(); updateButtons(); }

  el.createForm?.addEventListener('submit', e => { e.preventDefault(); createOrJoin('create'); });
  el.joinForm?.addEventListener('submit', e => { e.preventDefault(); createOrJoin('join'); });
  el.createLock?.addEventListener('change', () => el.createPasswordWrap.classList.toggle('hidden', !el.createLock.checked));
  el.homeTabs.forEach(t => t.addEventListener('click', () => { el.homeTabs.forEach(x => x.classList.toggle('active', x === t)); el.homeForms.forEach(x => x.classList.toggle('active', x.dataset.panel === t.dataset.tab)); clearHomeError(); }));
  el.btnBroadcast?.addEventListener('click', startScreen); el.btnCamera?.addEventListener('click', startCamera); el.btnCall?.addEventListener('click', joinCall); el.btnMic?.addEventListener('click', toggleMic); el.btnDeafen?.addEventListener('click', () => setDeafen(!state.deafened));
  el.btnMenu?.addEventListener('click', () => el.rail.classList.add('open')); el.btnRailClose?.addEventListener('click', closeDrawers); el.btnPanelClose?.addEventListener('click', closeDrawers); el.backdrop?.addEventListener('click', closeDrawers);
  el.btnInvite?.addEventListener('click', async () => { openPanel('invite'); try { await navigator.clipboard.writeText(el.inviteLink.value); toast('Link copiado.', 'success'); } catch {} }); el.btnMixer?.addEventListener('click', () => openPanel('mixer')); el.btnSettings?.addEventListener('click', () => openPanel('settings'));
  el.sideTabs.forEach(t => t.addEventListener('click', () => openPanel(t.dataset.tab)));
  el.btnCopyLink?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(el.inviteLink.value); toast('Link copiado.', 'success'); } catch { el.inviteLink.select(); document.execCommand('copy'); } }); el.btnCopyCode?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(el.inviteCode.textContent); toast('Código copiado.', 'success'); } catch {} });
  el.chatForm?.addEventListener('submit', e => { e.preventDefault(); const text = el.chatInput.value.trim(); if (text) { send('chat-message', { text }); el.chatInput.value = ''; } });
  el.btnSaveProfile?.addEventListener('click', () => { const name = el.profileName.value.trim(), avatar = el.profileAvatar.value.trim(); if (!name) return el.profileError.textContent = 'Informe um nome.'; if (!validAvatar(avatar)) return el.profileError.textContent = 'URL de imagem inválida.'; state.selfName=name; state.selfAvatar=avatar; send('update-profile',{name,avatarUrl:avatar}); el.profileError.textContent=''; toast('Perfil atualizado.','success'); });
  el.btnSavePassword?.addEventListener('click', () => { if (!state.isOwner) return; send('change-password',{password:el.newPassword.value}); state.roomPassword=el.newPassword.value; el.newPassword.value=''; toast('Senha atualizada.','success'); });
  el.rangeMaster?.addEventListener('input', () => { state.masterVolume=Number(el.rangeMaster.value)/100; applyAudioSettings(); }); el.checkboxDeafenMixer?.addEventListener('change', () => setDeafen(el.checkboxDeafenMixer.checked)); el.speaker?.addEventListener('change', setSpeaker); el.quality?.addEventListener('change', () => state.quality=el.quality.value); el.noise?.addEventListener('change', () => state.noiseSuppression=el.noise.checked); el.micSelect?.addEventListener('change', () => { state.micDeviceId=el.micSelect.value; });
  el.themeToggle?.addEventListener('click', toggleTheme); el.themeToggleRoom?.addEventListener('click', toggleTheme); el.btnLeave?.addEventListener('click', () => cleanup(false));
  el.btnExpand?.addEventListener('click', () => { const stage=document.querySelector('.stage'); if (!document.fullscreenElement) (stage.requestFullscreen?.() || Promise.resolve()).catch(()=>{}); else document.exitFullscreen?.().catch(()=>{}); });
  document.addEventListener('click', () => { getAudioContext(); document.querySelectorAll('#voice-audio-pool audio').forEach(a => { if (a.paused) a.play().catch(()=>{}); }); }, { passive:true });
  function getAudioContext() { if (!state.audioCtx) { const C=window.AudioContext||window.webkitAudioContext; if (C) state.audioCtx=new C(); } if (state.audioCtx?.state==='suspended') state.audioCtx.resume().catch(()=>{}); return state.audioCtx; }
  window.addEventListener('beforeunload', () => { try { state.ws?.close(); } catch {} });
  applyTheme(); loadRtcConfig();
  const inviteRoom = new URLSearchParams(location.search).get('room'); if (inviteRoom) { el.joinRoomcode.value=inviteRoom.toUpperCase(); el.homeTabs.find(t=>t.dataset.tab==='join')?.click(); }
  refreshEmpty(); updateButtons();
})();
