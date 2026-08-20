/**
 * Kpnc Broadcasts — cliente
 * WebRTC mesh + signaling via WebSocket + chat em tempo real +
 * configurações de áudio/vídeo + auto-visualização da própria transmissão.
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

  /* ============================================================
   * Estado global da aplicação
   * ============================================================ */
  const state = {
    ws: null,
    selfId: null,
    selfName: '',
    roomId: null,
    roomName: '',
    isOwner: false,
    ownerId: null,
    hasPassword: false,
    participants: new Map(),   // id -> {id, name, muted, broadcasting}
    peers: new Map(),          // id -> { pc, polite, makingOffer, ignoreOffer }
    remoteStreams: new Map(),  // id -> MediaStream
    localScreenStream: null,
    localMicStream: null,
    micMuted: true,
    broadcasting: false,
    hiddenPeers: new Set(), // transmissões que o usuário optou por não assistir (só localmente)
    selectedMicId: '',
    selectedSpeakerId: '',
    volume: 1,
    noiseSuppression: true // cancelamento de eco/ruído do microfone, ligado por padrão
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

    formJoin: $('#form-join'),
    joinUsername: $('#join-username'),
    joinRoomcode: $('#join-roomcode'),
    joinPassword: $('#join-password'),

    homeError: $('#home-error'),

    roomIndicator: $('#room-indicator'),
    roomIndicatorName: $('#room-indicator-name'),
    roomIndicatorCode: $('#room-indicator-code'),

    videoGrid: $('#video-grid'),
    stageEmpty: $('#stage-empty'),

    btnBroadcast: $('#btn-broadcast'),
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

    selfPreview: $('#self-preview'),
    selfPreviewEmpty: $('#self-preview-empty'),

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
        showError(payload.message);
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
        onRemoteBroadcastStarted(payload.id);
        break;
      case 'broadcast-stopped':
        onRemoteBroadcastStopped(payload.id);
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

  function showError(message) {
    el.homeError.textContent = message;
    el.homeError.classList.remove('hidden');
  }
  function clearError() {
    el.homeError.classList.add('hidden');
    el.homeError.textContent = '';
  }

  /* ============================================================
   * Fluxo: criar / entrar em sala
   * ============================================================ */
  el.formCreate.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    try {
      if (!state.ws) await connectSocket();
      state.selfName = el.createUsername.value.trim();
      send('create-room', {
        userName: state.selfName,
        roomName: el.createRoomname.value.trim(),
        password: el.createPassword.value
      });
    } catch (err) {
      showError('Não foi possível conectar ao servidor.');
    }
  });

  el.formJoin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    try {
      if (!state.ws) await connectSocket();
      state.selfName = el.joinUsername.value.trim();
      send('join-room', {
        userName: state.selfName,
        roomId: el.joinRoomcode.value.trim().toUpperCase(),
        password: el.joinPassword.value
      });
    } catch (err) {
      showError('Não foi possível conectar ao servidor.');
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
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((t) => t.stop());
      state.localScreenStream = null;
    }
    if (state.localMicStream) {
      state.localMicStream.getTracks().forEach((t) => t.stop());
      state.localMicStream = null;
    }
    state.broadcasting = false;
    state.roomId = null;
    state.participants.clear();
    state.remoteStreams.clear();
    el.videoGrid.querySelectorAll('.video-tile').forEach((t) => t.remove());
    el.stageEmpty.classList.remove('hidden');
    el.chatMessages.innerHTML = '';
    el.screenRoom.classList.add('hidden');
    el.screenHome.classList.remove('hidden');
    el.roomIndicator.classList.add('hidden');
    updateBroadcastButtonUI();
  }

  el.btnLeave.addEventListener('click', cleanupAndGoHome);

  /* ============================================================
   * WebRTC — Perfect Negotiation por par de participantes
   * ============================================================ */
  function ensurePeer(peerId) {
    if (state.peers.has(peerId)) return state.peers.get(peerId);

    const pc = new RTCPeerConnection(rtcConfig);
    const polite = state.selfId > peerId; // regra determinística e simétrica
    const ps = { pc, polite, makingOffer: false, ignoreOffer: false };
    state.peers.set(peerId, ps);

    // Tracks locais já ativos entram nesta nova conexão
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((track) => pc.addTrack(track, state.localScreenStream));
    }
    if (state.localMicStream) {
      state.localMicStream.getTracks().forEach((track) => pc.addTrack(track, state.localMicStream));
    }

    // O lado "impolite" força a primeira negociação (mesmo sem tracks) via datachannel
    if (!polite) {
      pc.createDataChannel('kpnc-keepalive');
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
      let stream = state.remoteStreams.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        state.remoteStreams.set(peerId, stream);
      }
      stream.addTrack(event.track);
      const participant = state.participants.get(peerId);
      if (participant && participant.broadcasting) showRemoteTile(peerId, stream);
      else attachHiddenAudio(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        // A limpeza real ocorre via participant-left; aqui só avisamos.
        console.warn(`Conexão com ${peerId}: ${pc.connectionState}`);
      }
    };

    return ps;
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
    state.remoteStreams.delete(peerId);
    removeRemoteTile(peerId);
    removeHiddenAudio(peerId);
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

  function renderLocalTile(stream) {
    let tile = document.getElementById('tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.id = 'tile-local';
      tile.className = 'video-tile is-local';
      tile.innerHTML = `
        <video autoplay muted playsinline></video>
        <div class="tile-actions">
          <button type="button" class="tile-action-btn btn-expand-tile" data-id="local" title="Tela cheia">
            <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <span class="tile-badge-you">Você</span>
        <span class="tile-label"><span class="dot-live"></span>${escapeHtml(state.selfName || 'Você')}</span>
      `;
      el.videoGrid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    updateStageEmptyVisibility();
  }

  function removeLocalTile() {
    const tile = document.getElementById('tile-local');
    if (tile) tile.remove();
    updateStageEmptyVisibility();
  }

  function showRemoteTile(peerId, stream) {
    removeHiddenAudio(peerId);
    let tile = document.getElementById(`tile-remote-${peerId}`);
    const participant = state.participants.get(peerId);
    const name = participant ? participant.name : 'Participante';
    if (!tile) {
      tile = document.createElement('div');
      tile.id = `tile-remote-${peerId}`;
      tile.className = 'video-tile';
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="tile-hidden-overlay">
          <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10.5 7-.6 1-1.4 2.1-2.4 3.1M6.6 6.6C4.5 8 3 10 1.5 12c1.9 3 5.6 7 10.5 7 1.4 0 2.7-.3 3.9-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <p>Você parou de assistir a transmissão de ${escapeHtml(name)}.</p>
          <button type="button" class="btn btn-ghost btn-show-tile" data-id="${peerId}">Assistir novamente</button>
        </div>
        <div class="tile-actions">
          <button type="button" class="tile-action-btn btn-hide-tile" data-id="${peerId}" title="Parar de assistir">
            <svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10.5 7-.6 1-1.4 2.1-2.4 3.1M6.6 6.6C4.5 8 3 10 1.5 12c1.9 3 5.6 7 10.5 7 1.4 0 2.7-.3 3.9-.9M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="tile-action-btn btn-expand-tile" data-id="${peerId}" title="Tela cheia">
            <svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <span class="tile-label"><span class="dot-live"></span>${escapeHtml(name)}</span>
      `;
      el.videoGrid.appendChild(tile);
    }
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
    videoEl.volume = state.volume;
    applySinkId(videoEl);

    // Se o usuário já tinha optado por não assistir esta pessoa, mantém pausado
    if (state.hiddenPeers.has(peerId)) {
      tile.classList.add('is-hidden-view');
      videoEl.pause();
    } else {
      tile.classList.remove('is-hidden-view');
    }
    updateStageEmptyVisibility();
  }

  function removeRemoteTile(peerId) {
    const tile = document.getElementById(`tile-remote-${peerId}`);
    if (tile) tile.remove();
    updateStageEmptyVisibility();
  }

  function attachHiddenAudio(peerId, stream) {
    let audioEl = document.getElementById(`audio-remote-${peerId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-remote-${peerId}`;
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = stream;
    audioEl.volume = state.volume;
    applySinkId(audioEl);
  }

  function removeHiddenAudio(peerId) {
    const audioEl = document.getElementById(`audio-remote-${peerId}`);
    if (audioEl) audioEl.remove();
  }

  function onRemoteBroadcastStarted(peerId) {
    const p = state.participants.get(peerId);
    if (p) p.broadcasting = true;
    const stream = state.remoteStreams.get(peerId);
    if (stream) showRemoteTile(peerId, stream);
    renderParticipants();
  }

  function onRemoteBroadcastStopped(peerId) {
    const p = state.participants.get(peerId);
    if (p) p.broadcasting = false;
    removeRemoteTile(peerId);
    const stream = state.remoteStreams.get(peerId);
    if (stream) attachHiddenAudio(peerId, stream);
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
  function toggleHideTile(peerId) {
    const tile = document.getElementById(`tile-remote-${peerId}`);
    if (!tile) return;
    const videoEl = tile.querySelector('video');
    const isHidden = state.hiddenPeers.has(peerId);

    if (isHidden) {
      state.hiddenPeers.delete(peerId);
      tile.classList.remove('is-hidden-view');
      videoEl.play().catch(() => {});
    } else {
      state.hiddenPeers.add(peerId);
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
    if (hideBtn) { toggleHideTile(hideBtn.dataset.id); return; }

    const showBtn = event.target.closest('.btn-show-tile');
    if (showBtn) { toggleHideTile(showBtn.dataset.id); return; }

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
   * Transmitir tela
   * ============================================================ */
  el.btnBroadcast.addEventListener('click', () => {
    if (state.broadcasting) stopBroadcast();
    else startBroadcast();
  });

  async function startBroadcast() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Seu navegador não suporta compartilhamento de tela.', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      state.localScreenStream = stream;

      // Visualização da própria transmissão (settings) + tile na grade principal
      el.selfPreview.srcObject = stream;
      el.selfPreviewEmpty.classList.add('hidden');
      renderLocalTile(stream);

      for (const [, ps] of state.peers) {
        stream.getTracks().forEach((track) => ps.pc.addTrack(track, stream));
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', () => stopBroadcast());

      state.broadcasting = true;
      send('start-broadcast');
      updateBroadcastButtonUI();
      toast('Você está transmitindo sua tela.', 'success');
    } catch (err) {
      if (err.name !== 'NotAllowedError') toast('Não foi possível iniciar a transmissão de tela.', 'error');
    }
  }

  function stopBroadcast() {
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
    removeLocalTile();

    state.broadcasting = false;
    send('stop-broadcast');
    updateBroadcastButtonUI();
  }

  function updateBroadcastButtonUI() {
    el.btnBroadcast.classList.toggle('is-active', state.broadcasting);
    el.btnBroadcast.querySelector('span').textContent = state.broadcasting ? 'Parar transmissão' : 'Transmitir tela';
  }

  /* ============================================================
   * Microfone — captura, mute/desmute, troca de dispositivo
   * ============================================================ */
  el.btnMic.addEventListener('click', toggleMic);
  el.btnToggleMicSettings.addEventListener('click', toggleMic);

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
      // Alguns navegadores não aceitam mudar em tempo real — refaz a captura.
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
   * Participantes — lista + ações do dono (expulsar / transferir)
   * ============================================================ */
  function renderParticipants() {
    const list = [
      { id: state.selfId, name: `${state.selfName} (você)`, muted: state.micMuted, broadcasting: state.broadcasting, isSelf: true },
      ...Array.from(state.participants.values())
        .filter((p) => p.id !== state.selfId)
    ];

    el.countParticipants.textContent = list.length;

    el.participantsList.innerHTML = list.map((p) => {
      const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
      const isOwner = p.id === state.ownerId;
      const canManage = state.isOwner && !p.isSelf;
      return `
        <li class="participant-item" data-id="${p.id}">
          <span class="participant-avatar">${escapeHtml(initial)}</span>
          <span class="participant-info">
            <span class="participant-name">${escapeHtml(p.name)}${isOwner ? '<span class="badge-owner">DONO</span>' : ''}</span>
            <span class="participant-sub">${p.broadcasting ? 'Transmitindo tela' : (p.muted ? 'Microfone mudo' : 'Sem transmissão')}</span>
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
