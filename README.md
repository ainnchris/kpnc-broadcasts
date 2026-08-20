# Kpnc Telas

Aplicação independente de compartilhamento de tela em tempo real usando WebRTC.

Desenvolvido por **Jp Dev's**.

## Recursos

- Novo design em azul, branco e preto, com tema claro e escuro (detalhe sempre em azul)
- Criar e entrar em salas por código/link
- Senha opcional da sala
- Compartilhamento de tela
- Áudio de sistema quando o navegador/OS oferecer suporte
- Visualização da sua própria transmissão em tempo real (auto-preview)
- Configurações de áudio e vídeo: escolha de microfone (entrada) e de saída de som, mute/desmute
- Chat em tempo real entre todos os participantes da sala
- Múltiplos participantes
- Múltiplas transmissões simultâneas
- Lista de participantes
- Dono da sala, expulsar participante, transferir propriedade
- Alterar/remover senha
- Convite por link
- Interface responsiva

## Rodar localmente

Requer Node.js 18+.

```
npm install
npm start
```

Abra `http://localhost:3000`.

## Produção

Para produção, use HTTPS. A API `getDisplayMedia()` exige contexto seguro (HTTPS, exceto localhost). O navegador também exige uma ação explícita do usuário para iniciar a captura.

Para conexões reais entre redes diferentes, configure um servidor TURN e adicione suas credenciais em `public/js/app.js`, na constante `rtcConfig`:

```js
const rtcConfig = {
  iceServers: [
    { urls: "stun:seu-stun.example" },
    {
      urls: "turn:seu-turn.example",
      username: "usuario",
      credential: "senha"
    }
  ]
};
```

## Arquitetura

O servidor (`server.js`) faz apenas signaling e gerenciamento de salas/chat. A mídia é enviada diretamente entre os participantes (peer-to-peer) via WebRTC — o servidor nunca processa vídeo ou áudio. O signaling troca SDP/ICE usando o padrão de "Negociação Perfeita" (Perfect Negotiation) para evitar conflitos quando várias transmissões começam ao mesmo tempo.

Esta é uma implementação independente, sem copiar marca, identidade visual, textos ou assets de qualquer serviço de referência.

## Limitação importante

A arquitetura é mesh (P2P direto entre todos os participantes). Para salas pequenas, como 2-4 pessoas, é simples e barato. Para dezenas de espectadores, substitua a camada P2P por um SFU como mediasoup ou LiveKit.

---

Kpnc Broadcasts — desenvolvido por **Jp Dev's**.
