/**
 * Kpnc Broadcasts — cliente
 * WebRTC mesh + signaling via WebSocket + chat em tempo real +
 * tela e câmera + perfil/avatar em tempo real + configurações de
 * áudio/vídeo + auto-visualização da própria transmissão.
 *
 * Desenvolvido por Jp Dev's
 */
(() => {
  'use strict';

  /* ============================================================
   * Configuração de ICE — adicione um servidor TURN em produção
   * para conexões entre redes diferentes.
   * ============================================================ */
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
      // { urls: 'turn:seu-turn.example', username: 'usuario', credential: 'senha' }
    ]
  };

  const QUALITY_PRESETS = {
    auto: null,
    '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    '720p': { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    '480p': { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
  };

  const IMAGE_URL_REGEX = /^https?:\/\/\S+\.(png|jpe?g)(\?\S*)?(#\S*)?$/i;

  /* ============================================================
   * Estado global da aplicação
   * ============================================================ */
  const state = {
    ws: null,
    selfId: null,
    selfName: '',
    selfAvatarUrl: '',
    roomId: null,
    roomName: '',
    isOwner: false,
    ownerId: null,
    hasPassword: false,
    participants: new Map(),     // id -> {id, name, avatarUrl, muted, broadcasts:{screen,camera}}
    peers: new Map(),            // id -> { pc, polite, makingOffer, ignoreOffer }
    remoteStreams: new Map(),    // "peerId:streamId" -> MediaStream
    hiddenTiles: new Set(),      // ids de tiles que o usuário optou por não assistir (local)
    localScreenStream: null,
    localCameraStream: null,
    localMicStream: null,
    micMuted: true,
    broadcastingScreen: false,
    broadcastingCamera: false,
    screenQuality: '720p',
    selectedMicId: '',
    selectedSpeakerId: '',
    volume: 1,
    noiseSuppression: true
  };

  /* ============================================================
   * Atalhos de DOM
   * ============================================================ */
  const $ = (sel) => document.querySelector(sel);
  const el = {
    themeToggle: $('#theme-toggle'),

    screenHome: $('#screen-home'),
    screenRoom: $('#screen-room'),

    formCreate: $('#form-create'),
    createUsername: $('#create-username'),
    createRoomname: $('#create-roomname'),
    createPassword: $('#create-password'),
    createAvatar: $('#create-avatar'),

    formJoin: $('#form-join'),
    joinUsername: $('#join-username'),
    joinRoomcode: $('#join-roomcode'),
    joinPassword: $('#join-password'),
    joinAvatar: $('#join-avatar'),

    homeError: $('#home-error'),

    roomIndicator: $('#room-indicator'),
    roomIndicatorName: $('#room-indicator-name'),
    roomIndicatorCode: $('#room-indicator-code'),

    videoGrid: $('#video-grid'),
    stageEmpty: $('#stage-empty'),

    btnBroadcast: $('#btn-broadcast'),
    btnCamera: $('#btn-camera'),
    btnMic: $('#btn-mic'),
    btnMicLabel: $('#btn-mic-label'),
    btnSettings: $('#btn-settings'),
    btnInvite: $('#btn-invite'),
    btnLeave: $('#btn-leave'),
    btnPanelToggle: $('#btn-panel-toggle'),
    btnPanelClose: $('#btn-panel-close'),

    sidePanel: $('.side-panel'),
    sideTabs: document.querySelectorAll('.side-tab'),
    sideContents: document.querySelectorAll('.side-content'),

    chatMessages: $('#chat-messages'),
    formChat: $('#form-chat'),
    chatInput: $('#chat-input'),

    inviteLink: $('#invite-link'),
    btnCopyLink: $('#btn-copy-link'),
    inviteCode: $('#invite-code'),

    ownerPasswordBlock: $('#owner-password-block'),
    newPassword: $('#new-password'),
    btnSavePassword: $('#btn-save-password'),

    participantsList: $('#participants-list'),
    countParticipants: $('#count-participants'),

    profileName: $('#profile-name'),
    profileAvatar: $('#profile-avatar'),
    btnSaveProfile: $('#btn-save-profile'),
    profileError: $('#profile-error'),

    selfPreview: $('#self-preview'),
    selfPreviewEmpty: $('#self-preview-empty'),

    selectQuality: $('#select-quality'),

    selectMic: $('#select-mic'),
    btnToggleMicSettings: $('#btn-toggle-mic-settings'),
    checkboxNoiseSuppression: $('#checkbox-noise-suppression'),
    selectSpeaker: $('#select-speaker'),
    speakerSupportHint: $('#speaker-support-hint'),
    rangeVolume: $('#range-volume'),

    toastContainer: $('#toast-container')
  };

  /* ============================================================
   * Tema (claro / escuro) — detalhe sempre em azul
   * ============================================================ */
  function initTheme() {
    const saved = localStorage.getItem('kpnc-theme');
    const preferred = saved || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', preferred);
  }
  el.themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('kpnc-theme', next);
  });
  initTheme();

  /* ============================================================
   * Toasts
   * ============================================================ */
  function toast(message, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast${kind === 'error' ? ' toast-error' : ''}${kind === 'success' ? ' toast-success' : ''}`;
    t.textContent = message;
    el.toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  /* ============================================================
   * WebSocket / signaling
   * ============================================================ */
  function connectSocket() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      state.ws = ws;

      ws.addEventListener('open', () => resolve(ws));
      ws.addEventListener('error', () => reject(new Error('Falha ao conectar ao servidor.')));
      ws.addEventListener('message', (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        handleServerMessage(msg.type, msg.payload || {});
      });
      ws.addEventListener('close', () => {
        if (state.roomId) toast('Conexão com o servidor perdida.', 'error');
      });
    });
  }

  function send(type, payload = {}) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type, payload }));
    }
  }

  function handleServerMessage(type, payload) {
    switch (type) {
      case 'room-created':
      case 'room-joined':
        onEnteredRoom(payload);
        break;
      case 'error':
        if (state.roomId) toast(payload.message, 'error');
        else showHomeError(payload.message);
        break;
      case 'participant-joined':
        state.participants.set(payload.participant.id, payload.participant);
        renderParticipants();
        addSystemChatLine(`${payload.participant.name} entrou na sala.`);
        ensurePeer(payload.participant.id);
        break;
      case 'participant-left':
        removeParticipantUI(payload.id);
        break;
      case 'participants-update':
        payload.participants.forEach((p) => state.participants.set(p.id, p));
        state.ownerId = payload.ownerId;
        state.isOwner = state.ownerId === state.selfId;
        renderParticipants();
        toggleOwnerUI();
        break;
      case 'signal':
        handleSignal(payload.from, payload.data);
        break;
      case 'chat-message':
        addChatMessage(payload);
        break;
      case 'broadcast-started':
        onRemoteBroadcastStarted(payload.id, payload.kind, payload.streamId);
        break;
      case 'broadcast-stopped':
        onRemoteBroadcastStopped(payload.id, payload.kind);
        break;
      case 'participant-muted': {
        const p = state.participants.get(payload.id);
        if (p) { p.muted = payload.muted; renderParticipants(); }
        break;
      }
      case 'kicked':
        toast('Você foi removido da sala pelo dono.', 'error');
        cleanupAndGoHome();
        break;
      case 'ownership-transferred':
        state.ownerId = payload.newOwnerId;
        state.isOwner = state.ownerId === state.selfId;
        toggleOwnerUI();
        if (state.isOwner) toast('Você agora é o dono da sala.', 'success');
        break;
      case 'password-changed':
        state.hasPassword = payload.hasPassword;
        toast(state.hasPassword ? 'Senha da sala atualizada.' : 'Senha da sala removida.', 'success');
        break;
      default:
        break;
    }
  }

  function showHomeError(message) {
    el.homeError.textContent = message;
    el.homeError.classList.remove('hidden');
  }
  function clearHomeError() {
    el.homeError.classList.add('hidden');
    el.homeError.textContent = '';
  }

  /* ============================================================
   * Fluxo: criar / entrar em sala
   * ============================================================ */
  function isValidImageUrl(url) {
    return !url || IMAGE_URL_REGEX.test(url.trim());
  }

  el.formCreate.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearHomeError();
    const avatarUrl = el.createAvatar.value.trim();
    if (avatarUrl && !isValidImageUrl(avatarUrl)) {
      showHomeError('A foto de perfil precisa ser um link direto de imagem .png, .jpg ou .jpeg.');
      return;
    }
    try {
      if (!state.ws) await connectSocket();
      state.selfName = el.createUsername.value.trim();
      state.selfAvatarUrl = avatarUrl;
      send('create-room', {
        userName: state.selfName,
        roomName: el.createRoomname.value.trim(),
        password: el.createPassword.value,
        avatarUrl
      });
    } catch (err) {
      showHomeError('Não foi possível conectar ao servidor.');
    }
  });

  el.formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearHomeError();
    const avatarUrl = el.joinAvatar.value.trim();
    if (avatarUrl && !isValidImageUrl(avatarUrl)) {
      showHomeError('A foto de perfil precisa ser um link direto de imagem .png, .jpg ou .jpeg.');
      return;
    }
    try {
      if (!state.ws) await connectSocket();
      state.selfName = el.joinUsername.value.trim();
      state.selfAvatarUrl = avatarUrl;
      send('join-room', {
        userName: state.selfName,
        roomId: el.joinRoomcode.value.trim().toUpperCase(),
        password: el.joinPassword.value,
        avatarUrl
      });
    } catch (err) {
      showHomeError('Não foi possível conectar ao servidor.');
    }
  });

  // Pré-preenche o código da sala se acessado via link de convite (?room=CODIGO)
  (function prefillFromLink() {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      el.joinRoomcode.value = room.toUpperCase();
      el.joinUsername.focus();
    }
  })();

  function onEnteredRoom(payload) {
    state.selfId = payload.selfId;
    state.roomId = payload.roomId;
    state.roomName = payload.roomName;
    state.isOwner = payload.isOwner;
    state.ownerId = payload.ownerId;
    state.hasPassword = payload.hasPassword;
    state.participants.clear();
    payload.participants.forEach((p) => state.participants.set(p.id, p));

    el.screenHome.classList.add('hidden');
    el.screenRoom.classList.remove('hidden');
    el.roomIndicator.classList.remove('hidden');
    el.roomIndicatorName.textContent = state.roomName;
    el.roomIndicatorCode.textContent = state.roomId;
    el.inviteCode.textContent = state.roomId;

    const link = `${location.origin}${location.pathname}?room=${state.roomId}`;
    el.inviteLink.value = link;

    el.profileName.value = state.selfName;
    el.profileAvatar.value = state.selfAvatarUrl;

    addSystemChatLine(`Bem-vindo(a) à sala "${state.roomName}".`);

    renderParticipants();
    toggleOwnerUI();
    populateDeviceLists();

    // conecta com quem já estava na sala
    payload.participants
      .filter((p) => p.id !== state.selfId)
      .forEach((p) => ensurePeer(p.id));
  }

  function cleanupAndGoHome() {
    send('leave-room');
    for (const id of Array.from(state.peers.keys())) destroyPeer(id);
    [state.localScreenStream, state.localCameraStream, state.localMicStream].forEach((s) => {
      if (s) s.getTracks().forEach((t) => t.stop());
    });
    state.localScreenStream = null;
    state.localCameraStream = null;
    state.localMicStream = null;
    state.broadcastingScreen = false;
    state.broadcastingCamera = false;
    state.roomId = null;
    state.participants.clear();
    state.remoteStreams.clear();
    state.hiddenTiles.clear();
    el.videoGrid.querySelectorAll('.video-tile').forEach((t) => t.remove());
    el.stageEmpty.classList.remove('hidden');
    el.chatMessages.innerHTML = '';
    el.screenRoom.classList.add('hidden');
    el.screenHome.classList.remove('hidden');
    el.roomIndicator.classList.add('hidden');
    updateBroadcastButtonsUI();
  }

  el.btnLeave.addEventListener('click', cleanupAndGoHome);

  /* ============================================================
   * WebRTC — Perfect Negotiation por par de participantes
   *
   * Correção de bug: a versão anterior forçava uma negociação
   * "às cegas" (via datachannel) assim que dois participantes se
   * conectavam. Quando alguém já estava transmitindo, isso podia
   * colidir com a negociação real (que já carrega a faixa de
   * vídeo) e deixar quem entrou depois com a tela preta, só
   * resolvido reiniciando a transmissão. Agora a negociação só
   * começa quando existe mídia de verdade para enviar — sem
   * disparo artificial — o que elimina essa corrida.
   * ============================================================ */
  function ensurePeer(peerId) {
    if (state.peers.has(peerId)) return state.peers.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    const polite = state.selfId > peerId; // regra determinística e simétrica
    const ps = { pc, polite, makingOffer: false, ignoreOffer: false };
    state.peers.set(peerId, ps);

    // Tracks locais já ativos entram nesta nova conexão — isso já é
    // suficiente para disparar a negociação automaticamente.
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((track) => pc.addTrack(track, state.localScreenStream));
    }
    if (state.localCameraStream) {
      state.localCameraStream.getTracks().forEach((track) => pc.addTrack(track, state.localCameraStream));
    }
    if (state.localMicStream) {
      state.localMicStream.getTracks().forEach((track) => pc.addTrack(track, state.localMicStream));
    }

    pc.onnegotiationneeded = async () => {
      try {
        ps.makingOffer = true;
        await pc.setLocalDescription();
        send('signal', { to: peerId, data: { description: pc.localDescription } });
      } catch (err) {
        console.error('Erro ao negociar com', peerId, err);
      } finally {
        ps.makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) send('signal', { to: peerId, data: { candidate: event.candidate } });
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      const key = `${peerId}:${remoteStream.id}`;
      if (!state.remoteStreams.has(key)) state.remoteStreams.set(key, remoteStream);
      const stream = state.remoteStreams.get(key);
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);

      const participant = state.participants.get(peerId);
      const kind = resolveKindForStream(peerId, remoteStream.id);
      const active = kind && participant && participant.broadcasts && participant.broadcasts[kind] && participant.broadcasts[kind].active;

      if (active) showRemoteTile(peerId, remoteStream.id, stream, kind, participant.name);
      else attachHiddenAudio(peerId, remoteStream.id, stream);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        console.warn(`Conexão com ${peerId}: ${pc.connectionState}`);
      }
    };

    return ps;
  }

  function resolveKindForStream(peerId, streamId) {
    const p = state.participants.get(peerId);
    if (!p || !p.broadcasts) return null;
    if (p.broadcasts.screen && p.broadcasts.screen.streamId === streamId) return 'screen';
    if (p.broadcasts.camera && p.broadcasts.camera.streamId === streamId) return 'camera';
    return null;
  }

  async function handleSignal(peerId, data) {
    const ps = ensurePeer(peerId);
    const { pc } = ps;
    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer' &&
          (ps.makingOffer || pc.signalingState !== 'stable');
        ps.ignoreOffer = !ps.polite && offerCollision;
        if (ps.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          send('signal', { to: peerId, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!ps.ignoreOffer) console.error('Erro ao adicionar ICE candidate', err);
        }
      }
    } catch (err) {
      console.error('Erro de sinalização com', peerId, err);
    }
  }

  function destroyPeer(peerId) {
    const ps = state.peers.get(peerId);
    if (ps) {
      ps.pc.close();
      state.peers.delete(peerId);
    }
    for (const key of Array.from(state.remoteStreams.keys())) {
      if (key.startsWith(`${peerId}:`)) {
        const streamId = key.slice(peerId.length + 1);
        removeRemoteTile(peerId, streamId);
        removeHiddenAudio(peerId, streamId);
        state.remoteStreams.delete(key);
      }
    }
  }

  function removeParticipantUI(peerId) {
    const p = state.participants.get(peerId);
    if (p) addSystemChatLine(`${p.name} saiu da sala.`);
    state.participants.delete(peerId);
    destroyPeer(peerId);
    renderParticipants();
  }

  /* ============================================================
   * Vídeo — tiles (grade de transmissão)
   * ============================================================ */
  function updateStageEmptyVisibility() {
    const hasTiles = el.videoGrid.querySelectorAll('.video-tile').length > 0;
    el.stageEmpty.classList.toggle('hidden', hasTiles);
  }

  function kindLabel(kind) {
    return kind === 'camera' ? 'Câmera' : 'Tela';
  }

  function renderLocalTile(kind, stream) {
    const tileId = `tile-local-${kind}`;
    let tile = document.getElementById(tileId);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = tileId;
      tile.className = 'video-tile is-local';
      tile.innerHTML = `
        <video autoplay muted playsinline></video>
        <div class="tile-actions">
          <button type="button" class="tile-action-btn btn-expand-tile" title="Tela cheia">
            <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <span class="tile-badge-you">Você</span>
        <span class="tile-label"><span class="dot-live"></span>${escapeHtml(state.selfName || 'Você')} · ${kindLabel(kind)}</span>
      `;
      el.videoGrid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    updateStageEmptyVisibility();
  }

  function removeLocalTile(kind) {
    const tile = document.getElementById(`tile-local-${kind}`);
    if (tile) tile.remove();
    updateStageEmptyVisibility();
  }

  function showRemoteTile(peerId, streamId, stream, kind, name) {
    const tileId = `tile-remote-${peerId}-${streamId}`;
    removeHiddenAudio(peerId, streamId);

    let tile = document.getElementById(tileId);
    if (!tile) {
      tile = document.createElement('div');
      tile.id = tileId;
      tile.className = 'video-tile';
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="tile-hidden-overlay">
          <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10.5 7-.6 1-1.4 2.1-2.4 3.1M6.6 6.6C4.5 8 3 10 1.5 12c1.9 3 5.6 7 10.5 7 1.4 0 2.7-.3 3.9-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <p class="tile-hidden-text">Você parou de assistir.</p>
          <button type="button" class="btn btn-ghost btn-show-tile" data-tile="${tileId}">Assistir novamente</button>
        </div>
        <div class="tile-actions">
          <button type="button" class="tile-action-btn btn-hide-tile" data-tile="${tileId}" title="Parar de assistir">
            <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10.5 7-.6 1-1.4 2.1-2.4 3.1M6.6 6.6C4.5 8 3 10 1.5 12c1.9 3 5.6 7 10.5 7 1.4 0 2.7-.3 3.9-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="tile-action-btn btn-expand-tile" title="Tela cheia">
            <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <span class="tile-label"><span class="dot-live"></span>${escapeHtml(name)} · ${kindLabel(kind)}</span>
      `;
      el.videoGrid.appendChild(tile);
    } else {
      const label = tile.querySelector('.tile-label');
      if (label) label.innerHTML = `<span class="dot-live"></span>${escapeHtml(name)} · ${kindLabel(kind)}`;
      const hiddenText = tile.querySelector('.tile-hidden-text');
      if (hiddenText) hiddenText.textContent = `Você parou de assistir a transmissão de ${name}.`;
    }

    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
    videoEl.volume = state.volume;
    applySinkId(videoEl);

    if (state.hiddenTiles.has(tileId)) {
      tile.classList.add('is-hidden-view');
      videoEl.pause();
    } else {
      tile.classList.remove('is-hidden-view');
    }
    updateStageEmptyVisibility();
  }

  function removeRemoteTile(peerId, streamId) {
    const tile = document.getElementById(`tile-remote-${peerId}-${streamId}`);
    if (tile) tile.remove();
    updateStageEmptyVisibility();
  }

  function attachHiddenAudio(peerId, streamId, stream) {
    const audioId = `audio-remote-${peerId}-${streamId}`;
    let audioEl = document.getElementById(audioId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = audioId;
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.volume = state.volume;
    applySinkId(audioEl);
  }

  function removeHiddenAudio(peerId, streamId) {
    const audioEl = document.getElementById(`audio-remote-${peerId}-${streamId}`);
    if (audioEl) audioEl.remove();
  }

  function onRemoteBroadcastStarted(peerId, kind, streamId) {
    const p = state.participants.get(peerId);
    if (!p) return;
    p.broadcasts = p.broadcasts || { screen: { active: false, streamId: null }, camera: { active: false, streamId: null } };
    p.broadcasts[kind] = { active: true, streamId };
    renderParticipants();

    const existing = state.remoteStreams.get(`${peerId}:${streamId}`);
    if (existing) showRemoteTile(peerId, streamId, existing, kind, p.name);
  }

  function onRemoteBroadcastStopped(peerId, kind) {
    const p = state.participants.get(peerId);
    if (!p) return;
    const prev = p.broadcasts && p.broadcasts[kind];
    const prevStreamId = prev && prev.streamId;

    if (prevStreamId) {
      removeRemoteTile(peerId, prevStreamId);
      const stream = state.remoteStreams.get(`${peerId}:${prevStreamId}`);
      if (stream) attachHiddenAudio(peerId, prevStreamId, stream);
    }
    if (p.broadcasts) p.broadcasts[kind] = { active: false, streamId: null };
    renderParticipants();
  }

  function applySinkId(mediaEl) {
    if (state.selectedSpeakerId && typeof mediaEl.setSinkId === 'function') {
      mediaEl.setSinkId(state.selectedSpeakerId).catch(() => {});
    }
  }

  /* ============================================================
   * Parar de assistir uma transmissão específica (só localmente —
   * não afeta o que os outros participantes veem)
   * ============================================================ */
  function toggleHideTile(tileId) {
    const tile = document.getElementById(tileId);
    if (!tile) return;
    const videoEl = tile.querySelector('video');
    const isHidden = state.hiddenTiles.has(tileId);

    if (isHidden) {
      state.hiddenTiles.delete(tileId);
      tile.classList.remove('is-hidden-view');
      videoEl.play().catch(() => {});
    } else {
      state.hiddenTiles.add(tileId);
      tile.classList.add('is-hidden-view');
      videoEl.pause();
    }
  }

  /* ============================================================
   * Tela cheia — se ajusta automaticamente à orientação do
   * dispositivo (retrato/paisagem no celular, e no PC)
   * ============================================================ */
  function toggleFullscreen(videoEl) {
    const current = document.fullscreenElement || document.webkitFullscreenElement;
    if (current === videoEl) {
      exitFullscreen();
      return;
    }
    if (videoEl.requestFullscreen) videoEl.requestFullscreen().catch(() => {});
    else if (videoEl.webkitRequestFullscreen) videoEl.webkitRequestFullscreen();
    else if (videoEl.webkitEnterFullscreen) videoEl.webkitEnterFullscreen(); // iOS Safari (fullscreen nativo de vídeo)
    tryLockLandscape();
  }

  function exitFullscreen() {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  function tryLockLandscape() {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  }
  function tryUnlockOrientation() {
    if (screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch { /* nada a fazer */ }
    }
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) tryUnlockOrientation();
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) tryUnlockOrientation();
  });

  // Um único listener para todos os botões de ação dos tiles (criados dinamicamente)
  el.videoGrid.addEventListener('click', (event) => {
    const hideBtn = event.target.closest('.btn-hide-tile');
    if (hideBtn) { toggleHideTile(hideBtn.dataset.tile); return; }

    const showBtn = event.target.closest('.btn-show-tile');
    if (showBtn) { toggleHideTile(showBtn.dataset.tile); return; }

    const expandBtn = event.target.closest('.btn-expand-tile');
    if (expandBtn) {
      const tile = expandBtn.closest('.video-tile');
      const videoEl = tile && tile.querySelector('video');
      if (videoEl) toggleFullscreen(videoEl);
    }
  });

  // Duplo clique/duplo toque no vídeo também alterna tela cheia
  el.videoGrid.addEventListener('dblclick', (event) => {
    const videoEl = event.target.closest('video');
    if (videoEl) toggleFullscreen(videoEl);
  });

  /* ============================================================
   * "Ver tela" / "Ver câmera" a partir da lista de participantes
   * ============================================================ */
  function tileIdFor(p, kind) {
    if (p.isSelf) return `tile-local-${kind}`;
    const b = p.broadcasts && p.broadcasts[kind];
    return b && b.streamId ? `tile-remote-${p.id}-${b.streamId}` : null;
  }

  function focusTile(tileId) {
    if (!tileId) return;
    const tile = document.getElementById(tileId);
    if (!tile) {
      toast('Essa transmissão ainda está carregando — tente novamente em instantes.', 'error');
      return;
    }
    if (state.hiddenTiles.has(tileId)) toggleHideTile(tileId);
    el.sidePanel.classList.remove('open'); // libera a visão no celular
    tile.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tile.classList.add('is-focused');
    setTimeout(() => tile.classList.remove('is-focused'), 1600);
  }

  /* ============================================================
   * Transmitir tela
   * ============================================================ */
  el.btnBroadcast.addEventListener('click', () => {
    if (state.broadcastingScreen) stopScreenBroadcast();
    else startScreenBroadcast();
  });

  async function startScreenBroadcast() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Seu navegador não suporta compartilhamento de tela.', 'error');
      return;
    }
    try {
      const preset = QUALITY_PRESETS[state.screenQuality];
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: preset ? { ...preset } : true, audio: true });
      state.localScreenStream = stream;

      el.selfPreview.srcObject = stream;
      el.selfPreviewEmpty.classList.add('hidden');
      renderLocalTile('screen', stream);

      for (const [, ps] of state.peers) {
        stream.getTracks().forEach((track) => ps.pc.addTrack(track, stream));
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', () => stopScreenBroadcast());

      state.broadcastingScreen = true;
      send('start-broadcast', { kind: 'screen', streamId: stream.id });
      updateBroadcastButtonsUI();
      renderParticipants();
      toast('Você está transmitindo sua tela.', 'success');
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Não foi possível iniciar a transmissão de tela.', 'error');
    }
  }

  function stopScreenBroadcast() {
    if (!state.localScreenStream) return;
    const tracks = state.localScreenStream.getTracks();

    for (const [, ps] of state.peers) {
      ps.pc.getSenders().forEach((sender) => {
        if (sender.track && tracks.includes(sender.track)) ps.pc.removeTrack(sender);
      });
    }
    tracks.forEach((t) => t.stop());

    state.localScreenStream = null;
    el.selfPreview.srcObject = null;
    el.selfPreviewEmpty.classList.remove('hidden');
    removeLocalTile('screen');

    state.broadcastingScreen = false;
    send('stop-broadcast', { kind: 'screen' });
    updateBroadcastButtonsUI();
    renderParticipants();
  }

  /* ============================================================
   * Câmera
   * ============================================================ */
  el.btnCamera.addEventListener('click', () => {
    if (state.broadcastingCamera) stopCameraBroadcast();
    else startCameraBroadcast();
  });

  async function startCameraBroadcast() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Seu navegador não suporta câmera.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      state.localCameraStream = stream;
      renderLocalTile('camera', stream);

      for (const [, ps] of state.peers) {
        stream.getTracks().forEach((track) => ps.pc.addTrack(track, stream));
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', () => stopCameraBroadcast());

      state.broadcastingCamera = true;
      send('start-broadcast', { kind: 'camera', streamId: stream.id });
      updateBroadcastButtonsUI();
      renderParticipants();
      toast('Câmera ligada.', 'success');
    } catch (err) {
      toast('Não foi possível acessar a câmera.', 'error');
    }
  }

  function stopCameraBroadcast() {
    if (!state.localCameraStream) return;
    const tracks = state.localCameraStream.getTracks();

    for (const [, ps] of state.peers) {
      ps.pc.getSenders().forEach((sender) => {
        if (sender.track && tracks.includes(sender.track)) ps.pc.removeTrack(sender);
      });
    }
    tracks.forEach((t) => t.stop());

    state.localCameraStream = null;
    removeLocalTile('camera');

    state.broadcastingCamera = false;
    send('stop-broadcast', { kind: 'camera' });
    updateBroadcastButtonsUI();
    renderParticipants();
  }

  function updateBroadcastButtonsUI() {
    el.btnBroadcast.classList.toggle('is-active', state.broadcastingScreen);
    el.btnBroadcast.querySelector('span').textContent = state.broadcastingScreen ? 'Parar transmissão' : 'Transmitir tela';

    el.btnCamera.classList.toggle('is-active', state.broadcastingCamera);
    el.btnCamera.querySelector('span').textContent = state.broadcastingCamera ? 'Desligar câmera' : 'Câmera';
  }

  /* ============================================================
   * Qualidade da transmissão de tela
   * ============================================================ */
  el.selectQuality.value = state.screenQuality;
  el.selectQuality.addEventListener('change', async (e) => {
    state.screenQuality = e.target.value;
    if (!state.localScreenStream) return;
    const track = state.localScreenStream.getVideoTracks()[0];
    if (!track) return;
    const preset = QUALITY_PRESETS[state.screenQuality];
    try {
      await track.applyConstraints(preset ? { ...preset } : {});
      toast('Qualidade da transmissão atualizada.', 'success');
    } catch {
      toast('Não foi possível ajustar em tempo real neste navegador — pare e inicie a transmissão novamente para aplicar.', 'error');
    }
  });

  /* ============================================================
   * Microfone — captura, mute/desmute, troca de dispositivo
   * ============================================================ */
  el.btnMic.addEventListener('click', toggleMic);
  el.btnToggleMicSettings.addEventListener('click', toggleMic);

  /* Constraints do microfone — cancelamento de eco/ruído liga por padrão
     para evitar que quem transmite capte pelo microfone o áudio dos
     outros participantes saindo da própria caixa de som (efeito de eco). */
  function buildMicConstraints(deviceId) {
    const audio = {
      echoCancellation: state.noiseSuppression,
      noiseSuppression: state.noiseSuppression,
      autoGainControl: state.noiseSuppression
    };
    if (deviceId) audio.deviceId = { exact: deviceId };
    return { audio };
  }

  async function toggleMic() {
    if (!state.localMicStream) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(state.selectedMicId));
        state.localMicStream = stream;
        for (const [, ps] of state.peers) {
          stream.getTracks().forEach((track) => ps.pc.addTrack(track, stream));
        }
        state.micMuted = false;
        populateDeviceLists(); // labels ficam disponíveis após a permissão
      } catch (err) {
        toast('Não foi possível acessar o microfone.', 'error');
        return;
      }
    } else {
      state.micMuted = !state.micMuted;
      state.localMicStream.getAudioTracks().forEach((t) => { t.enabled = !state.micMuted; });
    }
    send('toggle-mute', { muted: state.micMuted });
    updateMicButtonUI();
  }

  async function setNoiseSuppression(enabled) {
    state.noiseSuppression = enabled;
    if (!state.localMicStream) return;
    const track = state.localMicStream.getAudioTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        echoCancellation: enabled,
        noiseSuppression: enabled,
        autoGainControl: enabled
      });
    } catch {
      await switchMicDevice(state.selectedMicId);
    }
  }
  el.checkboxNoiseSuppression.addEventListener('change', (e) => setNoiseSuppression(e.target.checked));

  function updateMicButtonUI() {
    const active = state.localMicStream && !state.micMuted;
    el.btnMic.classList.toggle('is-active', active);
    el.btnMic.classList.toggle('is-muted', !active);
    el.btnMicLabel.textContent = active ? 'Ativo' : 'Mudo';
  }
  updateMicButtonUI();

  async function switchMicDevice(deviceId) {
    state.selectedMicId = deviceId;
    if (!state.localMicStream) return;
    try {
      const newStream = await navigator.mediaDevices.getUserMedia(buildMicConstraints(deviceId));
      const newTrack = newStream.getAudioTracks()[0];
      newTrack.enabled = !state.micMuted;

      for (const [, ps] of state.peers) {
        const sender = ps.pc.getSenders().find((s) => s.track && s.track.kind === 'audio' && state.localMicStream.getAudioTracks().includes(s.track));
        if (sender) sender.replaceTrack(newTrack);
      }

      state.localMicStream.getAudioTracks().forEach((t) => t.stop());
      state.localMicStream = newStream;
    } catch (err) {
      toast('Não foi possível trocar o microfone.', 'error');
    }
  }

  /* ============================================================
   * Configurações de áudio/vídeo — dispositivos, saída, volume
   * ============================================================ */
  async function populateDeviceLists() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const speakers = devices.filter((d) => d.kind === 'audiooutput');

      el.selectMic.innerHTML = mics.length
        ? mics.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `Microfone ${i + 1}`)}</option>`).join('')
        : '<option value="">Nenhum microfone encontrado</option>';

      const supportsSink = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
      if (supportsSink && speakers.length) {
        el.selectSpeaker.innerHTML = speakers.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || `Saída ${i + 1}`)}</option>`).join('');
        el.speakerSupportHint.textContent = '';
      } else {
        el.selectSpeaker.innerHTML = '<option value="">Padrão do sistema</option>';
        el.speakerSupportHint.textContent = supportsSink
          ? 'Nenhum dispositivo de saída adicional encontrado.'
          : 'Seu navegador não permite escolher a saída de áudio — use as configurações do sistema.';
      }
    } catch {
      /* silencioso — provavelmente sem permissão ainda */
    }
  }

  el.selectMic.addEventListener('change', (e) => switchMicDevice(e.target.value));

  el.selectSpeaker.addEventListener('change', (e) => {
    state.selectedSpeakerId = e.target.value;
    document.querySelectorAll('.video-tile video, audio[id^="audio-remote-"]').forEach((mediaEl) => applySinkId(mediaEl));
  });

  el.rangeVolume.addEventListener('input', (e) => {
    state.volume = Number(e.target.value) / 100;
    document.querySelectorAll('#video-grid video, audio[id^="audio-remote-"]').forEach((mediaEl) => {
      if (mediaEl.id !== 'self-preview') mediaEl.volume = state.volume;
    });
  });

  navigator.mediaDevices && navigator.mediaDevices.addEventListener &&
    navigator.mediaDevices.addEventListener('devicechange', populateDeviceLists);

  /* ============================================================
   * Editar perfil em tempo real (nome + foto por link)
   * ============================================================ */
  function showProfileError(message) {
    el.profileError.textContent = message;
    el.profileError.classList.add('hint-error');
  }
  function clearProfileError() {
    el.profileError.textContent = '';
    el.profileError.classList.remove('hint-error');
  }

  el.btnSaveProfile.addEventListener('click', () => {
    clearProfileError();
    const name = el.profileName.value.trim();
    const avatarUrl = el.profileAvatar.value.trim();

    if (!name) { showProfileError('Informe um nome.'); return; }
    if (avatarUrl && !isValidImageUrl(avatarUrl)) {
      showProfileError('A foto precisa ser um link direto de imagem terminando em .png, .jpg ou .jpeg.');
      return;
    }

    state.selfName = name;
    state.selfAvatarUrl = avatarUrl;
    send('update-profile', { name, avatarUrl: avatarUrl || null });
    renderParticipants();
    toast('Perfil atualizado.', 'success');
  });

  /* ============================================================
   * Painel lateral — abas (Chat / Participantes / Configurações)
   * ============================================================ */
  function openPanel(tabName) {
    el.sideTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
    el.sideContents.forEach((c) => c.classList.toggle('active', c.dataset.panel === tabName));
    el.sidePanel.classList.add('open');
  }

  el.sideTabs.forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => openPanel(tabBtn.dataset.tab));
  });

  el.btnSettings.addEventListener('click', () => openPanel('settings'));
  el.btnInvite.addEventListener('click', () => {
    openPanel('participants');
    copyInviteLink();
  });
  el.btnPanelToggle.addEventListener('click', () => el.sidePanel.classList.toggle('open'));
  el.btnPanelClose.addEventListener('click', () => el.sidePanel.classList.remove('open'));

  /* ============================================================
   * Convite / link da sala
   * ============================================================ */
  function copyInviteLink() {
    navigator.clipboard.writeText(el.inviteLink.value)
      .then(() => toast('Link de convite copiado!', 'success'))
      .catch(() => toast('Não foi possível copiar o link.', 'error'));
  }
  el.btnCopyLink.addEventListener('click', copyInviteLink);

  /* ============================================================
   * Senha da sala (dono)
   * ============================================================ */
  el.btnSavePassword.addEventListener('click', () => {
    const value = el.newPassword.value;
    if (value) send('change-password', { password: value });
    else send('remove-password');
    el.newPassword.value = '';
  });

  function toggleOwnerUI() {
    el.ownerPasswordBlock.classList.toggle('hidden', !state.isOwner);
  }

  /* ============================================================
   * Participantes — lista + "ver tela/câmera" + ações do dono
   * ============================================================ */
  function avatarMarkup(p) {
    const initial = escapeHtml((p.name || '?').trim().charAt(0).toUpperCase() || '?');
    if (p.avatarUrl) {
      return `<img src="${escapeHtml(p.avatarUrl)}" alt="" onerror="this.outerHTML='${initial}'">`;
    }
    return initial;
  }

  function renderParticipants() {
    const selfEntry = {
      id: state.selfId,
      name: `${state.selfName} (você)`,
      avatarUrl: state.selfAvatarUrl,
      muted: state.micMuted,
      isSelf: true,
      broadcasts: {
        screen: { active: state.broadcastingScreen, streamId: state.localScreenStream ? state.localScreenStream.id : null },
        camera: { active: state.broadcastingCamera, streamId: state.localCameraStream ? state.localCameraStream.id : null }
      }
    };
    const list = [selfEntry, ...Array.from(state.participants.values()).filter((p) => p.id !== state.selfId)];

    el.countParticipants.textContent = list.length;

    el.participantsList.innerHTML = list.map((p) => {
      const isOwner = p.id === state.ownerId;
      const canManage = state.isOwner && !p.isSelf;
      const screen = p.broadcasts && p.broadcasts.screen;
      const camera = p.broadcasts && p.broadcasts.camera;

      const statusParts = [];
      if (screen && screen.active) statusParts.push('Transmitindo tela');
      if (camera && camera.active) statusParts.push('Câmera ligada');
      if (!statusParts.length) statusParts.push(p.muted ? 'Microfone mudo' : 'Sem transmissão');

      const watchButtons = [];
      if (!p.isSelf && screen && screen.active) {
        watchButtons.push(`<button type="button" class="btn-watch" data-tile="${tileIdFor(p, 'screen')}"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>Ver tela</button>`);
      }
      if (!p.isSelf && camera && camera.active) {
        watchButtons.push(`<button type="button" class="btn-watch" data-tile="${tileIdFor(p, 'camera')}"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>Ver câmera</button>`);
      }

      return `
        <li class="participant-item" data-id="${p.id}">
          <span class="participant-avatar">${avatarMarkup(p)}</span>
          <span class="participant-info">
            <span class="participant-name">${escapeHtml(p.name)}${isOwner ? '<span class="badge-owner">DONO</span>' : ''}</span>
            <span class="participant-sub">${escapeHtml(statusParts.join(' · '))}</span>
            ${watchButtons.length ? `<span class="participant-watch-row">${watchButtons.join('')}</span>` : ''}
          </span>
          ${canManage ? `
          <span class="participant-actions">
            <button type="button" class="btn-transfer" title="Transferir posse da sala" data-id="${p.id}">
              <svg viewBox="0 0 24 24"><path d="M12 2l4 4-4 4M16 6H4M12 22l-4-4 4-4M8 18h12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <button type="button" class="btn-kick danger" title="Expulsar da sala" data-id="${p.id}">
              <svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </button>
          </span>` : ''}
        </li>`;
    }).join('');

    el.participantsList.querySelectorAll('.btn-kick').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Expulsar este participante da sala?')) send('kick-participant', { targetId: btn.dataset.id });
      });
    });
    el.participantsList.querySelectorAll('.btn-transfer').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Transferir a posse da sala para este participante?')) send('transfer-ownership', { targetId: btn.dataset.id });
      });
    });
    el.participantsList.querySelectorAll('.btn-watch').forEach((btn) => {
      btn.addEventListener('click', () => focusTile(btn.dataset.tile));
    });
  }

  /* ============================================================
   * Chat em tempo real
   * ============================================================ */
  el.formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    send('chat-message', { text });
    el.chatInput.value = '';
  });

  function addChatMessage(msg) {
    const isOwn = msg.authorId === state.selfId;
    const row = document.createElement('div');
    row.className = `chat-msg${isOwn ? ' is-own' : ''}`;
    const time = new Date(msg.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <div class="chat-meta"><span class="chat-author">${escapeHtml(isOwn ? 'Você' : msg.name)}</span><span>${time}</span></div>
      <div class="chat-bubble">${escapeHtml(msg.text)}</div>
    `;
    el.chatMessages.appendChild(row);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function addSystemChatLine(text) {
    const row = document.createElement('div');
    row.className = 'chat-msg is-system';
    row.innerHTML = `<div class="chat-bubble">${escapeHtml(text)}</div>`;
    el.chatMessages.appendChild(row);
    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  /* ============================================================
   * Utilidades
   * ============================================================ */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  window.addEventListener('beforeunload', () => {
    if (state.roomId) send('leave-room');
  });
})();
