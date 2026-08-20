const fs = require('fs');
const path = require('path');
const root = __dirname;
const appPath = path.join(root, 'public/js/app.js');
const cssPath = path.join(root, 'public/css/style.css');

function patch(file, replacements) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [from, to] of replacements) {
    if (!s.includes(from)) throw new Error(`Patch target not found in ${file}: ${from.slice(0, 120)}`);
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
}

patch(appPath, [
  [
    "createUsername:$('#create-username'),createRoomname:$('#create-roomname'),createPassword:$('#create-password'),joinUsername:$('#join-username'),joinRoomcode:$('#join-roomcode'),joinPassword:$('#join-password'),",
    "createUsername:$('#create-username'),createRoomname:$('#create-roomname'),createPassword:$('#create-password'),createAvatar:$('#create-avatar'),joinUsername:$('#join-username'),joinRoomcode:$('#join-roomcode'),joinPassword:$('#join-password'),joinAvatar:$('#join-avatar'),"
  ],
  [
    "if(kind==='create'){const name=el.createUsername.value.trim(),room=el.createRoomname.value.trim();if(!name||!room)return showHomeError('Preencha seu nome e o nome da sala.');state.selfName=name;state.selfAvatar='';send('create-room',{userName:name,roomName:room,password:el.createPassword.value})}else{const name=el.joinUsername.value.trim(),code=el.joinRoomcode.value.trim().toUpperCase();if(!name||!code)return showHomeError('Preencha seu nome e o código da sala.');state.selfName=name;state.selfAvatar='';send('join-room',{userName:name,roomId:code,password:el.joinPassword.value})}",
    "if(kind==='create'){const name=el.createUsername.value.trim(),room=el.createRoomname.value.trim(),avatar=el.createAvatar.value.trim();if(!name||!room)return showHomeError('Preencha seu nome e o nome da sala.');if(avatar&&!IMAGE_URL_REGEX.test(avatar))return showHomeError('Use um link direto .png, .jpg ou .jpeg para a foto.');state.selfName=name;state.selfAvatar=avatar;send('create-room',{userName:name,roomName:room,password:el.createPassword.value,avatarUrl:avatar})}else{const name=el.joinUsername.value.trim(),code=el.joinRoomcode.value.trim().toUpperCase(),avatar=el.joinAvatar.value.trim();if(!name||!code)return showHomeError('Preencha seu nome e o código da sala.');if(avatar&&!IMAGE_URL_REGEX.test(avatar))return showHomeError('Use um link direto .png, .jpg ou .jpeg para a foto.');state.selfName=name;state.selfAvatar=avatar;send('join-room',{userName:name,roomId:code,password:el.joinPassword.value,avatarUrl:avatar})}"
  ],
  [
    "function inferAndRenderRemote(item){const p=state.participants.get(item.peerId);if(!p)return;if(p.broadcasts?.screen?.streamId===item.streamId)item.kind='screen';else if(p.broadcasts?.camera?.streamId===item.streamId)item.kind='camera';else if(item.kind==='unknown')item.kind='screen';ensureBroadcastTile(item.peerId,item.kind,item.streamId,false,item.stream)}",
    "function inferAndRenderRemote(item){const p=state.participants.get(item.peerId);if(p?.broadcasts?.screen?.streamId===item.streamId)item.kind='screen';else if(p?.broadcasts?.camera?.streamId===item.streamId)item.kind='camera';else if(item.kind==='unknown')item.kind='screen';ensureBroadcastTile(item.peerId,item.kind,item.streamId,false,item.stream)}"
  ],
  [
    "function renderSelfPreview(){const stream=state.localScreen||state.localCamera;if(!stream){el.selfPreview.srcObject=null;el.selfEmpty.classList.remove('hidden');return}el.selfEmpty.classList.add('hidden');el.selfPreview.srcObject=stream;el.selfPreview.play().catch(()=>{})}",
    "function renderSelfPreview(){const stream=state.screenStreamForPeers||state.localScreen||state.cameraStreamForPeers||state.localCamera;if(!stream){el.selfPreview.srcObject=null;el.selfEmpty.classList.remove('hidden');return}const videoTrack=stream.getVideoTracks?.()[0];if(videoTrack)videoTrack.enabled=true;el.selfEmpty.classList.add('hidden');const v=el.selfPreview;v.muted=true;v.autoplay=true;v.playsInline=true;if(v.srcObject!==stream)v.srcObject=stream;const play=()=>v.play().catch(()=>{});if(v.readyState>=2)play();else v.onloadedmetadata=play;setTimeout(play,100)}"
  ]
]);

patch(cssPath, [
  [
    ".video-tile video { width: 100%; height: 100%; object-fit: contain; background: #000; }",
    ".video-tile video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }\n.video-tile .video-wrap { position: relative; width: 100%; height: 100%; }\n.tile-meta { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--bg-card); border-top: 1px solid var(--border-soft); min-width: 0; }\n.tile-avatar { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--accent-soft); color: var(--accent); background-position: center; background-repeat: no-repeat; background-size: cover; font-size: 12px; font-weight: 700; }\n.tile-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; color: var(--text); }\n.tile-kind { flex: 0 0 auto; color: var(--text-faint); font-size: 11px; white-space: nowrap; }"
  ],
  [
    ".participant-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }",
    ".participant-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }\n.participant-avatar.has-image { background-position: center; background-repeat: no-repeat; background-size: cover; }\n.participant-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }\n.participant-main strong { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }\n.participant-main small { display: block; color: var(--text-faint); font-size: 12px; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }"
  ]
]);
