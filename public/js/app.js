(() => {
  'use strict';

  /* ==========================================================================
     Kpnc Telas — cliente
     Signaling via WebSocket. Mídia (tela, câmera, chamada de voz) trafega
     direto entre navegadores (WebRTC mesh, "Perfect Negotiation").
     ========================================================================== */

  // Para conexões entre redes diferentes em produção, adicione um servidor TURN aqui.
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const QUALITY = {
    auto: {},
    '1080p': { width: 1920, height: 1080, frameRate: 30 },
    '720p': { width: 1280, height: 720, frameRate: 30 },
    '480p': { width: 854, height: 480, frameRate: 24 }
  };

  const IMAGE_URL_REGEX = /^https?:\/\/\S+\.(png|jpe?g)(\?\S*)?(#\S*)?$/i;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  const el = {
    themeToggle: $('#theme-toggle'), themeToggleRoom: $('#theme-toggle-room'),
    home: $('#screen-home'), room: $('#screen-room'), homeError: $('#home-error'),

    createForm: $('#form-create'), joinForm: $('#form-join'),
    createUsername: $('#create-username'), createRoomname: $('#create-roomname'), createAvatar: $('#create-avatar'),
    createLock: $('#create-lock'), createPasswordWrap: $('#create-password-wrap'), createPassword: $('#create-password'),
    joinUsername: $('#join-username'), joinRoomcode: $('#join-roomcode'), joinAvatar: $('#join-avatar'), joinPassword: $('#join-password'),
    homeTabs: $$('.home-tab'), homeForms: $$('.home-form'),

    rail: $('#rail'), btnRailClose: $('#btn-rail-close'),
    roomName: $('#room-indicator-name'), roomCode: $('#room-indicator-code'),
    stageRoomName: $('#stage-room-name'),
    participants: $('#participants-list'), count: $('#count-participants'),
    btnInvite: $('#btn-invite'), btnMixer: $('#btn-mixer'),

    btnMenu: $('#btn-menu'), btnExpand: $('#btn-expand'),
    grid: $('#video-grid'), empty: $('#stage-empty'),
    selfPreviewWrap: $('#self-preview-wrap'), selfPreview: $('#self-preview'), selfEmpty: $('#self-preview-empty'),
    voicePool: $('#voice-audio-pool'),

    btnCall: $('#btn-call'), btnCallLabel: $('#btn-call-label'),
    btnMic: $('#btn-mic'), btnMicLabel: $('#btn-mic-label'),
    btnDeafen: $('#btn-deafen'), btnCamera: $('#btn-camera'), btnBroadcast: $('#btn-broadcast'),
    btnSettings: $('#btn-settings'), btnLeave: $('#btn-leave'),

    sidePanel: $('#side-panel'), btnPanelClose: $('#btn-panel-close'),
    sideTabs: $$('.side-tab'), sideContents: $$('.side-content'),
    backdrop: $('#drawer-backdrop'),

    chatForm: $('#form-chat'), chatInput: $('#chat-input'), chat: $('#chat-messages'),

    rangeMaster: $('#range-master'), checkboxDeafenMixer: $('#checkbox-deafen-mixer'),
    mixerBroadcasts: $('#mixer-broadcasts'), mixerVoices: $('#mixer-voices'),

    inviteLink: $('#invite-link'), btnCopyLink: $('#btn-copy-link'),
    inviteCode: $('#invite-code'), btnCopyCode: $('#btn-copy-code'),
    ownerPassword: $('#owner-password-block'), newPassword: $('#new-password'), btnSavePassword: $('#btn-save-password'),

    profileName: $('#profile-name'), profileAvatar: $('#profile-avatar'), profileError: $('#profile-error'), btnSaveProfile: $('#btn-save-profile'),

    quality: $('#select-quality'), micSelect: $('#select-mic'), noise: $('#checkbox-noise-suppression'),
    speaker: $('#select-speaker'), speakerHint: $('#speaker-support-hint'),

    toast: $('#toast-container')
  };

  const state = {
    ws: null, selfId: null, selfName: '', selfAvatar: '',
    roomId: null, roomName: '', ownerId: null, isOwner: false, hasPassword: false,
    participants: new Map(),
    peers: new Map(),
    remoteMedia: new Map(), // key `${peerId}:${streamId}` -> {peerId,streamId,stream,kind,el}
    audioPrefs: new Map(),  // key -> {volume, muted}
    speakingLoops: new Map(),
    audioCtx: null,

    localScreen: null, localCamera: null, localMic: null,
    screenStreamForPeers: null, cameraStreamForPeers: null, micStreamForPeers: null,
    screenOn: false, cameraOn: false, inCall: false, micMuted: true, deafened: false,

    quality: '720p', noiseSuppression: true, micDeviceId: '', speakerDeviceId: '',
    masterVolume: 1
  };

  /* ------------------------------ util básicos ------------------------------ */
  function toast(message, kind = 'info') {
    const n = document.createElement('div');
    n.className = `toast${kind === 'error' ? ' toast-error' : ''}${kind === 'success' ? ' toast-success' : ''}`;
    n.textContent = message;
    el.toast.appendChild(n);
    setTimeout(() => n.remove(), 4200);
  }
  function showHomeError(m) { el.homeError.textContent = m; el.homeError.classList.remove('hidden'); }
  function clearHomeError() { el.homeError.classList.add('hidden'); el.homeError.textContent = ''; }

  /* ------------------------------ conexão / sala ------------------------------ */
  function send(type, payload = {}) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type, payload }));
  }

  function connect() {
    if (state.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      state.ws = ws;
      let settled = false;
      ws.addEventListener('open', () => { settled = true; resolve(); });
      ws.addEventListener('error', () => { if (!settled) reject(new Error('socket')); });
      ws.addEventListener('message', (e) => {
        try { const m = JSON.parse(e.data); handleMessage(m.type, m.payload || {}); } catch { /* ignore */ }
      });
      ws.addEventListener('close', () => { if (state.roomId) toast('Conexão com o servidor perdida.', 'error'); });
    });
  }

  function handleMessage(type, p) {
    switch (type) {
      case 'room-created': case 'room-joined': enterRoom(p); break;
      case 'error': state.roomId ? toast(p.message, 'error') : showHomeError(p.message); break;
      case 'participant-joined':
        state.participants.set(p.participant.id, p.participant);
        renderParticipants(); addSystem(`${p.participant.name} entrou na sala.`); ensurePeer(p.participant.id);
        break;
      case 'participant-left': removeParticipant(p.id); break;
      case 'participants-update':
        syncParticipants(p.participants || []);
        state.ownerId = p.ownerId; state.isOwner = state.selfId === state.ownerId;
        renderParticipants(); updateOwnerUI();
        break;
      case 'signal': handleSignal(p.from, p.data); break;
      case 'chat-message': addChatMessage(p); break;
      case 'broadcast-started': case 'broadcast-stopped': break; // já refletido via participants-update
      case 'participant-muted': {
        const x = state.participants.get(p.id);
        if (x) { x.muted = !!p.muted; renderParticipants(); }
        break;
      }
      case 'ownership-transferred':
        state.ownerId = p.newOwnerId; state.isOwner = state.selfId === state.ownerId; updateOwnerUI();
        if (state.isOwner) toast('Você agora é o dono da sala.', 'success');
        break;
      case 'password-changed': state.hasPassword = !!p.hasPassword; updateOwnerUI(); break;
      case 'kicked': toast('Você foi removido da sala pelo dono.', 'error'); cleanup(true); break;
    }
  }

  function syncParticipants(list) {
    const incoming = new Set();
    for (const p of list) {
      incoming.add(p.id);
      state.participants.set(p.id, p);
      if (p.id !== state.selfId) ensurePeer(p.id);
    }
    for (const id of Array.from(state.participants.keys())) if (!incoming.has(id)) removeParticipant(id);
    refreshAudioUI();
  }

  function enterRoom(p) {
    state.selfId = p.selfId; state.roomId = p.roomId; state.roomName = p.roomName;
    state.ownerId = p.ownerId; state.isOwner = !!p.isOwner; state.hasPassword = !!p.hasPassword;
    state.participants.clear();
    for (const x of p.participants || []) state.participants.set(x.id, x);

    el.home.classList.add('hidden');
    el.room.classList.remove('hidden');
    el.roomName.textContent = state.roomName; el.roomCode.textContent = state.roomId;
    el.stageRoomName.textContent = state.roomName;
    el.inviteCode.textContent = state.roomId;
    el.inviteLink.value = `${location.origin}${location.pathname}?room=${state.roomId}`;
    el.profileName.value = state.selfName; el.profileAvatar.value = state.selfAvatar || '';
    el.chat.innerHTML = '';

    renderParticipants(); updateOwnerUI(); updateButtons(); populateDevices();
    for (const x of p.participants || []) if (x.id !== state.selfId) ensurePeer(x.id);

    addSystem(`Você entrou na sala "${state.roomName}".`);
  }

  function createOrJoin(kind) {
    clearHomeError();
    return connect().then(() => {
      if (kind === 'create') {
        const name = el.createUsername.value.trim();
        const room = el.createRoomname.value.trim();
        const avatar = el.createAvatar.value.trim();
        if (!name || !room) return showHomeError('Preencha seu nome e o nome da sala.');
        if (avatar && !IMAGE_URL_REGEX.test(avatar)) return showHomeError('Use um link direto .png, .jpg ou .jpeg para a foto.');
        state.selfName = name; state.selfAvatar = avatar;
        send('create-room', {
          userName: name, roomName: room, avatarUrl: avatar,
          password: el.createLock.checked ? el.createPassword.value : ''
        });
      } else {
        const name = el.joinUsername.value.trim();
        const code = el.joinRoomcode.value.trim().toUpperCase();
        const avatar = el.joinAvatar.value.trim();
        if (!name || !code) return showHomeError('Preencha seu nome e o código da sala.');
        if (avatar && !IMAGE_URL_REGEX.test(avatar)) return showHomeError('Use um link direto .png, .jpg ou .jpeg para a foto.');
        state.selfName = name; state.selfAvatar = avatar;
        send('join-room', { userName: name, roomId: code, password: el.joinPassword.value, avatarUrl: avatar });
      }
    }).catch(() => showHomeError('Não foi possível conectar ao servidor.'));
  }

  el.createForm.addEventListener('submit', (e) => { e.preventDefault(); createOrJoin('create'); });
  el.joinForm.addEventListener('submit', (e) => { e.preventDefault(); createOrJoin('join'); });
  el.createLock.addEventListener('change', () => el.createPasswordWrap.classList.toggle('hidden', !el.createLock.checked));
  el.homeTabs.forEach((tab) => tab.addEventListener('click', () => {
    el.homeTabs.forEach((t) => t.classList.toggle('active', t === tab));
    el.homeForms.forEach((f) => f.classList.toggle('active', f.dataset.panel === tab.dataset.tab));
    clearHomeError();
  }));

  /* ------------------------------ WebRTC (Perfect Negotiation) ------------------------------ */
  function ensurePeer(peerId) {
    if (peerId === state.selfId) return null;
    if (state.peers.has(peerId)) return state.peers.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    const peer = { id: peerId, pc, polite: String(state.selfId) > String(peerId), makingOffer: false, ignoreOffer: false, pendingNegotiation: false };
    state.peers.set(peerId, peer);

    if (state.screenStreamForPeers) for (const t of state.screenStreamForPeers.getTracks()) pc.addTrack(t, state.screenStreamForPeers);
    if (state.cameraStreamForPeers) for (const t of state.cameraStreamForPeers.getTracks()) pc.addTrack(t, state.cameraStreamForPeers);
    if (state.micStreamForPeers) for (const t of state.micStreamForPeers.getTracks()) pc.addTrack(t, state.micStreamForPeers);

    pc.onicecandidate = (e) => { if (e.candidate) send('signal', { to: peerId, data: { type: 'candidate', candidate: e.candidate } }); };
    pc.ontrack = (e) => { const stream = e.streams[0]; if (stream) handleRemoteTrack(peerId, stream); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) destroyPeer(peerId); };
    pc.onnegotiationneeded = () => negotiate(peer);
    if (hasLocalSenders(pc)) queueMicrotask(() => negotiate(peer));

    return peer;
  }
  function hasLocalSenders(pc) { return pc.getSenders().some((s) => !!s.track); }

  async function negotiate(peer) {
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') { peer.pendingNegotiation = true; return; }
    peer.makingOffer = true;
    try {
      await peer.pc.setLocalDescription();
      send('signal', { to: peer.id, data: { type: 'description', description: peer.pc.localDescription } });
    } catch (e) { console.warn('Erro de negociação', e); }
    finally {
      peer.makingOffer = false;
      if (peer.pendingNegotiation && peer.pc.signalingState === 'stable') { peer.pendingNegotiation = false; queueMicrotask(() => negotiate(peer)); }
    }
  }

  async function handleSignal(from, data) {
    const peer = ensurePeer(from);
    if (!peer) return;
    try {
      if (data.type === 'candidate') {
        try { await peer.pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.warn('Erro de ICE', e); }
        return;
      }
      if (data.type === 'description') {
        const desc = data.description;
        const collision = desc.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await peer.pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await peer.pc.setLocalDescription();
          send('signal', { to: from, data: { type: 'description', description: peer.pc.localDescription } });
        }
      }
    } catch (e) {
      console.warn('Erro de sinalização', e);
      if (data.type === 'description') setTimeout(() => negotiate(peer), 250);
    }
  }

  function destroyPeer(id) {
    const peer = state.peers.get(id);
    if (peer) { try { peer.pc.close(); } catch { /* ignore */ } state.peers.delete(id); }
    for (const key of Array.from(state.remoteMedia.keys())) if (key.startsWith(`${id}:`)) cleanupRemoteMedia(key);
    refreshEmpty();
  }

  function removeParticipant(id) {
    const p = state.participants.get(id);
    if (p) addSystem(`${p.name} saiu da sala.`);
    state.participants.delete(id);
    stopWatchingSpeaking(id);
    destroyPeer(id);
    $$(`[data-peer="${CSS.escape(id)}"]`).forEach((x) => x.remove());
    renderParticipants(); refreshEmpty(); renderMixer();
  }

  function addLocalTrackToPeers(track, stream) { for (const peer of state.peers.values()) peer.pc.addTrack(track, stream); }
  function removeLocalTrackFromPeers(track) {
    for (const peer of state.peers.values()) {
      const s = peer.pc.getSenders().find((x) => x.track === track);
      if (s) peer.pc.removeTrack(s);
    }
  }

  /* ------------------------------ transmissão de tela ------------------------------ */
  async function startScreen() {
    if (state.screenOn) return stopScreen();
    try {
      const q = QUALITY[state.quality];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: Object.keys(q).length ? { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } } : true,
        audio: true
      });
      state.localScreen = stream; state.screenOn = true;
      const vt = stream.getVideoTracks()[0];
      const ss = new MediaStream([vt]);
      for (const t of stream.getAudioTracks()) ss.addTrack(t);
      state.screenStreamForPeers = ss;
      vt.onended = () => { if (state.screenOn) stopScreen(); };
      for (const t of ss.getTracks()) addLocalTrackToPeers(t, ss);
      send('start-broadcast', { kind: 'screen', streamId: ss.id });
      renderSelfPreview(); updateButtons(); await applyQuality();
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'O compartilhamento de tela foi cancelado.' : 'Não foi possível iniciar a transmissão de tela.', 'error');
    }
  }
  function stopScreen() {
    if (!state.localScreen) return;
    for (const t of state.localScreen.getTracks()) removeLocalTrackFromPeers(t);
    state.localScreen.getTracks().forEach((t) => t.stop());
    state.localScreen = null; state.screenOn = false; state.screenStreamForPeers = null;
    send('stop-broadcast', { kind: 'screen' });
    renderSelfPreview(); updateButtons();
  }

  /* ------------------------------ câmera ------------------------------ */
  async function startCamera() {
    if (state.cameraOn) return stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      state.localCamera = stream; state.cameraOn = true;
      const cs = new MediaStream(stream.getVideoTracks());
      state.cameraStreamForPeers = cs;
      addLocalTrackToPeers(stream.getVideoTracks()[0], cs);
      send('start-broadcast', { kind: 'camera', streamId: cs.id });
      renderSelfPreview(); updateButtons();
    } catch { toast('Não foi possível acessar a câmera.', 'error'); }
  }
  function stopCamera() {
    if (!state.localCamera) return;
    for (const t of state.localCamera.getTracks()) removeLocalTrackFromPeers(t);
    state.localCamera.getTracks().forEach((t) => t.stop());
    state.localCamera = null; state.cameraOn = false; state.cameraStreamForPeers = null;
    send('stop-broadcast', { kind: 'camera' });
    renderSelfPreview(); updateButtons();
  }

  /* ------------------------------ chamada de voz ------------------------------ */
  async function joinCall() {
    if (state.inCall) return leaveCall();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: state.micDeviceId ? { exact: state.micDeviceId } : undefined,
          echoCancellation: state.noiseSuppression, noiseSuppression: state.noiseSuppression, autoGainControl: state.noiseSuppression
        }
      });
      state.localMic = stream;
      const track = stream.getAudioTracks()[0];
      track.enabled = !state.micMuted;
      state.micStreamForPeers = new MediaStream([track]);
      state.inCall = true;
      addLocalTrackToPeers(track, state.micStreamForPeers);
      send('start-broadcast', { kind: 'voice', streamId: state.micStreamForPeers.id });
      send('toggle-mute', { muted: state.micMuted });
      getAudioCtx();
      if (!state.micMuted) watchSpeaking(state.selfId, state.micStreamForPeers);
      updateButtons();
      toast('Você entrou na chamada de voz.', 'success');
    } catch { toast('Não foi possível acessar o microfone.', 'error'); }
  }
  function leaveCall() {
    if (!state.localMic) return;
    for (const t of state.localMic.getTracks()) removeLocalTrackFromPeers(t);
    state.localMic.getTracks().forEach((t) => t.stop());
    state.localMic = null; state.micStreamForPeers = null; state.inCall = false;
    stopWatchingSpeaking(state.selfId);
    send('stop-broadcast', { kind: 'voice' });
    updateButtons();
  }
  function toggleMic() {
    if (!state.inCall) return joinCall();
    state.micMuted = !state.micMuted;
    state.localMic?.getAudioTracks().forEach((t) => { t.enabled = !state.micMuted; });
    send('toggle-mute', { muted: state.micMuted });
    if (!state.micMuted) { getAudioCtx(); watchSpeaking(state.selfId, state.micStreamForPeers); }
    else stopWatchingSpeaking(state.selfId);
    updateButtons();
  }
  function setDeafen(value) {
    state.deafened = value;
    el.checkboxDeafenMixer.checked = value;
    el.btnDeafen.classList.toggle('active', value);
    if (value && state.inCall && !state.micMuted) {
      state.micMuted = true;
      state.localMic?.getAudioTracks().forEach((t) => { t.enabled = false; });
      send('toggle-mute', { muted: true });
      stopWatchingSpeaking(state.selfId);
      updateButtons();
    }
    applyAudioSettings();
  }

  /* ------------------------------ mixer / áudio remoto ------------------------------ */
  function audioKeyVoice(peerId) { return `voice:${peerId}`; }
  function audioKeyBroadcast(peerId, kind) { return `bcast:${peerId}:${kind}`; }
  function getAudioPref(key) {
    if (!state.audioPrefs.has(key)) state.audioPrefs.set(key, { volume: 1, muted: false });
    return state.audioPrefs.get(key);
  }

  function getAudioCtx() {
    if (!state.audioCtx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      state.audioCtx = new C();
    }
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
    return state.audioCtx;
  }

  function watchSpeaking(peerId, stream) {
    if (!stream) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.6;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const token = Symbol();
      state.speakingLoops.set(peerId, token);
      const tick = () => {
        if (state.speakingLoops.get(peerId) !== token) return;
        analyser.getByteFrequencyData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
        setSpeaking(peerId, (sum / data.length) > 10);
        requestAnimationFrame(tick);
      };
      tick();
    } catch { /* ignore */ }
  }
  function stopWatchingSpeaking(peerId) { state.speakingLoops.delete(peerId); setSpeaking(peerId, false); }
  function setSpeaking(peerId, speaking) {
    $$(`[data-participant="${CSS.escape(peerId)}"]`).forEach((n) => n.classList.toggle('speaking', speaking));
  }

  function classifyItem(item) {
    const hasVideo = item.stream.getVideoTracks().length > 0;
    if (!hasVideo) { item.kind = 'voice'; return; }
    const p = state.participants.get(item.peerId);
    item.kind = (p?.broadcasts?.camera?.streamId === item.streamId) ? 'camera' : 'screen';
  }

  function handleRemoteTrack(peerId, stream) {
    const key = `${peerId}:${stream.id}`;
    let item = state.remoteMedia.get(key);
    if (!item) { item = { peerId, streamId: stream.id, stream, kind: 'unknown', el: null }; state.remoteMedia.set(key, item); }
    item.stream = stream;
    classifyItem(item);
    for (const t of stream.getTracks()) t.addEventListener('ended', () => {
      if (stream.getTracks().every((x) => x.readyState === 'ended')) cleanupRemoteMedia(key);
    }, { once: true });
    if (item.kind === 'voice') renderVoiceAudio(item); else renderBroadcastTile(item);
    renderMixer();
  }

  function cleanupRemoteMedia(key) {
    const item = state.remoteMedia.get(key);
    if (!item) return;
    if (item.kind === 'voice') { stopWatchingSpeaking(item.peerId); item.el?.remove(); }
    else { removeTile(tileKey(item.peerId, item.kind)); }
    state.remoteMedia.delete(key);
    refreshEmpty(); renderMixer();
  }

  function renderVoiceAudio(item) {
    let audioEl = item.el;
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true; audioEl.playsInline = true;
      el.voicePool.appendChild(audioEl);
      item.el = audioEl;
    }
    if (audioEl.srcObject !== item.stream) audioEl.srcObject = item.stream;
    applyAudioSettings();
    audioEl.play().catch(() => {});
    watchSpeaking(item.peerId, item.stream);
  }

  function tileKey(peerId, kind) { return `${peerId}:${kind}`; }
  function removeTile(key) { document.querySelector(`[data-tile="${CSS.escape(key)}"]`)?.remove(); }

  function buildTileSkeleton(key, peerId, kind) {
    const tile = document.createElement('article');
    tile.className = 'video-tile'; tile.dataset.tile = key; tile.dataset.peer = peerId; tile.dataset.participant = peerId; tile.dataset.kind = kind;
    tile.innerHTML = `
      <div class="video-wrap">
        <video autoplay playsinline></video>
        <div class="tile-loading">Essa transmissão ainda está carregando…</div>
        <button class="tile-view btn btn-primary hidden" type="button">Ativar som</button>
      </div>
      <div class="tile-meta">
        <span class="tile-avatar"></span>
        <span class="tile-name"></span>
        <span class="tile-kind"></span>
        <button class="tile-mute" type="button" title="Mutar áudio desta transmissão">
          <svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/></svg>
        </button>
      </div>`;
    tile.querySelector('.tile-view').addEventListener('click', () => {
      const pref = getAudioPref(audioKeyBroadcast(peerId, tile.dataset.kind));
      pref.muted = false;
      applyAudioSettings();
      const v = tile.querySelector('video');
      v.play().then(() => {
        tile.querySelector('.tile-loading').classList.add('hidden');
        tile.querySelector('.tile-view').classList.add('hidden');
      }).catch(() => toast('O navegador bloqueou o som. Toque novamente.', 'error'));
      refreshAudioUI();
    });
    tile.querySelector('.tile-mute').addEventListener('click', (e) => {
      const pref = getAudioPref(audioKeyBroadcast(peerId, tile.dataset.kind));
      pref.muted = !pref.muted;
      e.currentTarget.classList.toggle('is-muted', pref.muted);
      applyAudioSettings(); renderMixer();
    });
    return tile;
  }

  function renderBroadcastTile(item) {
    const key = tileKey(item.peerId, item.kind);
    let tile = document.querySelector(`[data-tile="${CSS.escape(key)}"]`);
    if (!tile) { tile = buildTileSkeleton(key, item.peerId, item.kind); el.grid.appendChild(tile); }
    tile.dataset.kind = item.kind;

    const p = state.participants.get(item.peerId);
    tile.querySelector('.tile-name').textContent = p?.name || 'Participante';
    tile.querySelector('.tile-kind').textContent = item.kind === 'screen' ? 'Tela' : 'Câmera';
    const avatar = tile.querySelector('.tile-avatar');
    if (p?.avatarUrl) { avatar.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; avatar.classList.add('has-image'); avatar.textContent = ''; }
    else { avatar.style.backgroundImage = ''; avatar.classList.remove('has-image'); avatar.textContent = (p?.name || '?').charAt(0).toUpperCase(); }

    const v = tile.querySelector('video');
    item.el = v;
    if (v.srcObject !== item.stream) v.srcObject = item.stream;
    const pref = getAudioPref(audioKeyBroadcast(item.peerId, item.kind));
    tile.querySelector('.tile-mute').classList.toggle('is-muted', pref.muted);

    const tryPlay = () => v.play().then(() => {
      tile.querySelector('.tile-loading').classList.add('hidden');
      tile.querySelector('.tile-view').classList.add('hidden');
      applyAudioSettings();
    }).catch(() => {
      v.muted = true; v.play().catch(() => {});
      tile.querySelector('.tile-loading').classList.add('hidden');
      if (!(state.deafened || pref.muted)) tile.querySelector('.tile-view').classList.remove('hidden');
    });
    if (v.readyState >= 2) tryPlay(); else v.onloadedmetadata = tryPlay;
    refreshEmpty();
  }

  function applyAudioSettings() {
    const master = state.deafened ? 0 : state.masterVolume;
    for (const item of state.remoteMedia.values()) {
      if (!item.el) continue;
      const key = item.kind === 'voice' ? audioKeyVoice(item.peerId) : audioKeyBroadcast(item.peerId, item.kind);
      const pref = getAudioPref(key);
      item.el.muted = state.deafened || pref.muted;
      item.el.volume = clamp(master * pref.volume, 0, 1);
    }
  }

  function refreshAudioUI() {
    renderMixer();
    document.querySelectorAll('.video-tile').forEach((tile) => {
      const pref = getAudioPref(audioKeyBroadcast(tile.dataset.peer, tile.dataset.kind));
      tile.querySelector('.tile-mute')?.classList.toggle('is-muted', pref.muted);
    });
  }

  function buildMixerRow(peerId, prefKey, label) {
    const p = state.participants.get(peerId);
    const pref = getAudioPref(prefKey);
    const li = document.createElement('li');
    li.className = 'mixer-item'; li.dataset.participant = peerId;
    li.innerHTML = `
      <span class="m-avatar"></span>
      <span class="m-info"><strong></strong><small>${label}</small></span>
      <input type="range" min="0" max="100" value="${Math.round(pref.volume * 100)}">
      <button type="button" title="Mutar"><svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="7" rx="1.5"/><rect x="17" y="14" width="5" height="7" rx="1.5"/></svg></button>`;
    const avatar = li.querySelector('.m-avatar');
    if (p?.avatarUrl) { avatar.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; avatar.classList.add('has-image'); }
    else avatar.textContent = (p?.name || '?').charAt(0).toUpperCase();
    li.querySelector('strong').textContent = p?.name || 'Participante';
    const range = li.querySelector('input'); const muteBtn = li.querySelector('button');
    muteBtn.classList.toggle('is-muted', pref.muted);
    range.addEventListener('input', () => { pref.volume = Number(range.value) / 100; applyAudioSettings(); });
    muteBtn.addEventListener('click', () => { pref.muted = !pref.muted; muteBtn.classList.toggle('is-muted', pref.muted); applyAudioSettings(); refreshAudioUI(); });
    return li;
  }

  function renderMixer() {
    const bItems = Array.from(state.remoteMedia.values()).filter((i) => i.kind !== 'voice');
    el.mixerBroadcasts.innerHTML = '';
    if (!bItems.length) el.mixerBroadcasts.innerHTML = '<li class="mixer-empty">Nenhuma transmissão com áudio no momento.</li>';
    else bItems.forEach((i) => el.mixerBroadcasts.appendChild(buildMixerRow(i.peerId, audioKeyBroadcast(i.peerId, i.kind), i.kind === 'camera' ? 'Câmera' : 'Tela')));

    const vItems = Array.from(state.remoteMedia.values()).filter((i) => i.kind === 'voice');
    el.mixerVoices.innerHTML = '';
    if (!vItems.length) el.mixerVoices.innerHTML = '<li class="mixer-empty">Ninguém está em chamada de voz.</li>';
    else vItems.forEach((i) => el.mixerVoices.appendChild(buildMixerRow(i.peerId, audioKeyVoice(i.peerId), 'Voz')));
  }

  // Autoplay de áudio às vezes exige um gesto do usuário: tenta destravar em qualquer toque.
  document.addEventListener('click', () => { document.querySelectorAll('#voice-audio-pool audio').forEach((a) => { if (a.paused) a.play().catch(() => {}); }); });

  /* ------------------------------ participantes / UI ------------------------------ */
  function refreshEmpty() { el.empty.classList.toggle('hidden', !!el.grid.querySelector('.video-tile')); }

  function buildParticipantRow(p) {
    const li = document.createElement('li');
    li.className = 'participant-item' + (p.muted ? ' is-muted' : '');
    li.dataset.participant = p.id;
    li.innerHTML = `
      <span class="participant-avatar">
        <span class="mic-badge"><svg viewBox="0 0 24 24"><path d="M5 19L19 5M5 5l14 14"/></svg></span>
      </span>
      <span class="participant-main"><strong></strong><small></small></span>
      <span class="participant-tags"></span>
      <span class="participant-owner-actions"></span>`;
    const avatar = li.querySelector('.participant-avatar');
    if (p.avatarUrl) { avatar.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; avatar.classList.add('has-image'); }
    else avatar.insertAdjacentText('afterbegin', p.name.charAt(0).toUpperCase());
    li.querySelector('strong').textContent = p.name;
    const inVoice = !!p.broadcasts?.voice?.active;
    const inScreen = !!p.broadcasts?.screen?.active;
    const inCam = !!p.broadcasts?.camera?.active;
    const bits = [p.id === state.selfId ? 'Você' : 'Participante'];
    if (inVoice) bits.push('Em chamada');
    if (inScreen) bits.push('Compartilhando tela');
    if (inCam) bits.push('Câmera ligada');
    li.querySelector('small').textContent = bits.join(' · ');
    if (p.id === state.ownerId) li.querySelector('.participant-tags').innerHTML = '<span title="Dono da sala">👑</span>';

    if (state.isOwner && p.id !== state.selfId) {
      const actions = li.querySelector('.participant-owner-actions');
      const kickBtn = document.createElement('button');
      kickBtn.type = 'button'; kickBtn.title = 'Expulsar'; kickBtn.textContent = '✕';
      kickBtn.addEventListener('click', () => { if (confirm(`Expulsar ${p.name} da sala?`)) send('kick-participant', { targetId: p.id }); });
      const transferBtn = document.createElement('button');
      transferBtn.type = 'button'; transferBtn.title = 'Transferir posse da sala'; transferBtn.textContent = '⇄';
      transferBtn.addEventListener('click', () => { if (confirm(`Transferir a posse da sala para ${p.name}?`)) send('transfer-ownership', { targetId: p.id }); });
      actions.append(transferBtn, kickBtn);
    }
    return li;
  }

  function renderParticipants() {
    el.participants.innerHTML = '';
    el.count.textContent = String(state.participants.size);
    for (const p of state.participants.values()) el.participants.appendChild(buildParticipantRow(p));
    updateTileProfiles();
  }
  function updateTileProfiles() {
    document.querySelectorAll('.video-tile').forEach((tile) => {
      const p = state.participants.get(tile.dataset.peer);
      if (!p) return;
      tile.querySelector('.tile-name').textContent = p.name;
      const a = tile.querySelector('.tile-avatar');
      if (p.avatarUrl) { a.style.backgroundImage = `url("${p.avatarUrl.replace(/"/g, '\\"')}")`; a.classList.add('has-image'); a.textContent = ''; }
      else { a.style.backgroundImage = ''; a.classList.remove('has-image'); a.textContent = p.name.charAt(0).toUpperCase(); }
    });
  }

  function updateOwnerUI() { el.ownerPassword.classList.toggle('hidden', !state.isOwner); }

  function updateButtons() {
    el.btnBroadcast.querySelector('.ctrl-label').textContent = state.screenOn ? 'Parar tela' : 'Tela';
    el.btnCamera.querySelector('.ctrl-label').textContent = state.cameraOn ? 'Parar câmera' : 'Câmera';
    el.btnCallLabel.textContent = state.inCall ? 'Sair' : 'Chamada';
    el.btnMicLabel.textContent = state.micMuted ? 'Mudo' : 'Falando';
    el.btnBroadcast.classList.toggle('active', state.screenOn);
    el.btnCamera.classList.toggle('active', state.cameraOn);
    el.btnCall.classList.toggle('active', state.inCall);
    el.btnMic.classList.toggle('active', state.inCall && !state.micMuted);
    el.btnMic.disabled = !state.inCall;
    el.btnDeafen.classList.toggle('active', state.deafened);
  }

  /* ------------------------------ dispositivos ------------------------------ */
  async function populateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const ds = await navigator.mediaDevices.enumerateDevices();
      renderDeviceSelect(el.micSelect, ds.filter((d) => d.kind === 'audioinput'), state.micDeviceId, 'Microfone');
      renderDeviceSelect(el.speaker, ds.filter((d) => d.kind === 'audiooutput'), state.speakerDeviceId, 'Saída');
      el.speakerHint.textContent = 'A seleção de saída depende do suporte do navegador.';
    } catch { /* ignore */ }
  }
  function renderDeviceSelect(select, devices, selected, fallback) {
    select.innerHTML = '';
    for (const d of devices) {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `${fallback} ${select.options.length + 1}`;
      select.appendChild(o);
    }
    if (selected) select.value = selected;
  }
  async function changeMicDevice(deviceId) {
    state.micDeviceId = deviceId;
    if (!state.localMic) return;
    const oldTrack = state.localMic.getAudioTracks()[0];
    const ns = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: state.noiseSuppression, noiseSuppression: state.noiseSuppression, autoGainControl: state.noiseSuppression }
    });
    const nt = ns.getAudioTracks()[0];
    state.micStreamForPeers = new MediaStream([nt]);
    for (const peer of state.peers.values()) {
      const s = peer.pc.getSenders().find((x) => x.track === oldTrack);
      if (s) await s.replaceTrack(nt);
    }
    oldTrack.stop();
    state.localMic = ns;
    nt.enabled = !state.micMuted;
    if (!state.micMuted) watchSpeaking(state.selfId, state.micStreamForPeers);
  }
  function setRemoteOutput() {
    state.speakerDeviceId = el.speaker.value;
    document.querySelectorAll('video, #voice-audio-pool audio').forEach((m) => { if (typeof m.setSinkId === 'function' && state.speakerDeviceId) m.setSinkId(state.speakerDeviceId).catch(() => {}); });
  }
  async function applyQuality() {
    if (!state.localScreen) return;
    const track = state.localScreen.getVideoTracks()[0];
    if (!track) return;
    const q = QUALITY[state.quality];
    try {
      await track.applyConstraints(Object.keys(q).length ? { width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height }, frameRate: { ideal: q.frameRate, max: q.frameRate } } : {});
      toast(`Qualidade aplicada: ${state.quality === 'auto' ? 'automática' : state.quality}.`, 'success');
    } catch { toast('O navegador não permitiu exatamente essa qualidade; usando a melhor disponível.', 'error'); }
  }
  function renderSelfPreview() {
    const stream = state.localScreen || state.localCamera;
    if (!stream) { el.selfPreview.srcObject = null; el.selfEmpty.classList.remove('hidden'); el.selfPreviewWrap.classList.add('hidden'); return; }
    el.selfEmpty.classList.add('hidden'); el.selfPreviewWrap.classList.remove('hidden');
    if (el.selfPreview.srcObject !== stream) el.selfPreview.srcObject = stream;
    el.selfPreview.play().catch(() => {});
  }

  /* ------------------------------ painéis / navegação ------------------------------ */
  function openSidePanel(tabName) {
    el.sideTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
    el.sideContents.forEach((p) => p.classList.toggle('active', p.dataset.panel === tabName));
    el.sidePanel.classList.add('open');
    el.rail.classList.remove('open');
    updateBackdrop();
  }
  function closeDrawers() { el.sidePanel.classList.remove('open'); el.rail.classList.remove('open'); updateBackdrop(); }
  function updateBackdrop() {
    const anyOpen = el.sidePanel.classList.contains('open') || el.rail.classList.contains('open');
    el.backdrop.classList.toggle('show', anyOpen && window.matchMedia('(max-width: 880px)').matches);
  }

  el.sideTabs.forEach((tab) => tab.addEventListener('click', () => openSidePanel(tab.dataset.tab)));
  el.btnPanelClose.addEventListener('click', closeDrawers);
  el.btnMenu.addEventListener('click', () => { el.rail.classList.add('open'); el.sidePanel.classList.remove('open'); updateBackdrop(); });
  el.btnRailClose.addEventListener('click', closeDrawers);
  el.backdrop.addEventListener('click', closeDrawers);
  el.btnInvite.addEventListener('click', () => navigator.clipboard?.writeText(el.inviteLink.value).then(() => toast('Link copiado.', 'success')).catch(() => {}));
  el.btnMixer.addEventListener('click', () => openSidePanel('mixer'));
  el.btnSettings.addEventListener('click', () => openSidePanel('settings'));

  /* ------------------------------ controles principais ------------------------------ */
  el.btnBroadcast.addEventListener('click', startScreen);
  el.btnCamera.addEventListener('click', startCamera);
  el.btnCall.addEventListener('click', joinCall);
  el.btnMic.addEventListener('click', toggleMic);
  el.btnDeafen.addEventListener('click', () => setDeafen(!state.deafened));

  el.quality.addEventListener('change', async () => { state.quality = el.quality.value; await applyQuality(); });
  el.noise.addEventListener('change', async () => {
    state.noiseSuppression = el.noise.checked;
    if (!state.localMic) return;
    const muted = state.micMuted, device = state.micDeviceId;
    state.localMic.getTracks().forEach((t) => t.stop());
    state.localMic = null; state.micDeviceId = device; state.inCall = false;
    await joinCall();
    state.micMuted = muted;
    state.localMic?.getTracks().forEach((t) => { t.enabled = !muted; });
    updateButtons();
  });
  el.micSelect.addEventListener('change', () => changeMicDevice(el.micSelect.value).catch(() => toast('Não foi possível trocar o microfone.', 'error')));
  el.speaker.addEventListener('change', setRemoteOutput);

  el.rangeMaster.addEventListener('input', () => { state.masterVolume = Number(el.rangeMaster.value) / 100; applyAudioSettings(); });
  el.checkboxDeafenMixer.addEventListener('change', () => setDeafen(el.checkboxDeafenMixer.checked));

  el.saveProfile.addEventListener('click', () => {
    if (!state.roomId) return;
    const name = el.profileName.value.trim(), avatar = el.profileAvatar.value.trim();
    if (!name) return showProfileError('Informe um nome.');
    if (avatar && !IMAGE_URL_REGEX.test(avatar)) return showProfileError('Use um link direto .png ou .jpg.');
    state.selfName = name; state.selfAvatar = avatar;
    send('update-profile', { name, avatarUrl: avatar });
    clearProfileError(); toast('Perfil atualizado.', 'success');
  });
  function showProfileError(m) { el.profileError.textContent = m; }
  function clearProfileError() { el.profileError.textContent = ''; }

  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send('chat-message', { text }); el.chatInput.value = '';
  });
  function addSystem(t) { const d = document.createElement('div'); d.className = 'chat-system'; d.textContent = t; el.chat.appendChild(d); el.chat.scrollTop = el.chat.scrollHeight; }
  function addChatMessage(p) {
    const d = document.createElement('div'); d.className = 'chat-message';
    d.innerHTML = '<strong></strong><span></span>';
    d.querySelector('strong').textContent = p.name; d.querySelector('span').textContent = p.text;
    el.chat.appendChild(d); el.chat.scrollTop = el.chat.scrollHeight;
  }

  el.btnCopyLink.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.inviteLink.value); toast('Link copiado.', 'success'); }
    catch { el.inviteLink.select(); document.execCommand('copy'); toast('Link copiado.', 'success'); }
  });
  el.btnCopyCode.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(el.inviteCode.textContent); toast('Código copiado.', 'success'); } catch { /* ignore */ }
  });
  el.btnSavePassword.addEventListener('click', () => {
    if (!state.isOwner) return;
    send('change-password', { password: el.newPassword.value }); el.newPassword.value = '';
    toast('Senha atualizada.', 'success');
  });

  /* ------------------------------ tela cheia / expandir (mobile) ------------------------------ */
  function toggleExpand() {
    const expanded = document.body.classList.contains('stage-expanded');
    if (!expanded) {
      document.body.classList.add('stage-expanded');
      closeDrawers();
      const stage = document.querySelector('.stage');
      const req = stage.requestFullscreen || stage.webkitRequestFullscreen || stage.msRequestFullscreen;
      if (req) req.call(stage).catch(() => {});
      if (screen.orientation?.lock) screen.orientation.lock('landscape').catch(() => {});
    } else {
      document.body.classList.remove('stage-expanded');
      if (document.fullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      if (screen.orientation?.unlock) screen.orientation.unlock();
    }
  }
  el.btnExpand.addEventListener('click', toggleExpand);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.body.classList.remove('stage-expanded'); });

  /* ------------------------------ tema ------------------------------ */
  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('kpnc-theme', next);
  }
  el.themeToggle.addEventListener('click', toggleTheme);
  el.themeToggleRoom.addEventListener('click', toggleTheme);
  (function applyStoredTheme() {
    const saved = localStorage.getItem('kpnc-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  })();

  /* ------------------------------ sair da sala ------------------------------ */
  function cleanup(skipSocket = false) {
    if (!skipSocket) send('leave-room');
    for (const id of Array.from(state.peers.keys())) destroyPeer(id);
    [state.localScreen, state.localCamera, state.localMic].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
    state.localScreen = state.localCamera = state.localMic = null;
    state.screenStreamForPeers = state.cameraStreamForPeers = state.micStreamForPeers = null;
    state.screenOn = state.cameraOn = state.inCall = false; state.micMuted = true; state.deafened = false;
    state.roomId = null; state.selfId = null;
    state.participants.clear(); state.remoteMedia.clear(); state.audioPrefs.clear(); state.speakingLoops.clear();
    document.querySelectorAll('.video-tile').forEach((t) => t.remove());
    el.voicePool.innerHTML = '';
    document.body.classList.remove('stage-expanded');
    closeDrawers();
    el.empty.classList.remove('hidden');
    el.home.classList.remove('hidden'); el.room.classList.add('hidden');
    updateButtons();
  }
  el.btnLeave.addEventListener('click', () => cleanup(false));

  /* ------------------------------ inicialização ------------------------------ */
  (function prefill() {
    const room = new URLSearchParams(location.search).get('room');
    if (room) { el.joinRoomcode.value = room.toUpperCase(); el.homeTabs.find((t) => t.dataset.tab === 'join')?.click(); }
  })();
  refreshEmpty();
})();
