const WebSocket = require('ws');

const argv = process.argv.slice(2);
const PROFILE_COMMANDS = {
  scout: ['look', 'who', 'map', 'rank'],
  chatter: ['who', 'follows', 'rank'],
  fighter: ['status', 'look', 'train', 'fight'],
  quester: ['look', 'quest', 'map 凤栖', 'map 出海']
};

const options = {
  url: process.env.MUD_URL || 'wss://bobo.rocks/',
  mode: process.env.MUD_MODE || 'register',
  username: process.env.MUD_USERNAME || `lobster_${Math.random().toString(16).slice(2, 8)}`,
  password: process.env.MUD_PASSWORD || 'p1234',
  clientVersion: process.env.MUD_CLIENT_VERSION || 'lobster-1',
  profile: process.env.MUD_PROFILE || 'scout',
  commands: (process.env.MUD_COMMANDS || '').split(',').map(s => s.trim()).filter(Boolean),
  reconnectToken: process.env.MUD_RECONNECT_TOKEN || ''
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const next = argv[i + 1];
  if (arg === '--url') options.url = next, i++;
  else if (arg === '--mode') options.mode = next, i++;
  else if (arg === '--username') options.username = next, i++;
  else if (arg === '--password') options.password = next, i++;
  else if (arg === '--commands') options.commands = next.split(',').map(s => s.trim()).filter(Boolean), i++;
  else if (arg === '--profile') options.profile = next, i++;
  else if (arg === '--token') options.reconnectToken = next, i++;
  else if (arg === '--client-version') options.clientVersion = next, i++;
}

if (!options.commands.length) {
  options.commands = PROFILE_COMMANDS[options.profile] || PROFILE_COMMANDS.scout;
}

const fs = require('fs');
const path = require('path');

const tokenStorePath = path.join(__dirname, '.lobster-sessions.json');

function loadTokenStore() {
  try {
    return JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveTokenStore(store) {
  fs.writeFileSync(tokenStorePath, JSON.stringify(store, null, 2));
}

const tokenStore = loadTokenStore();
if (!options.reconnectToken && tokenStore[options.username]) {
  options.reconnectToken = tokenStore[options.username];
}

const state = {
  token: options.reconnectToken || null,
  sawPrompt: false,
  sentFlow: false,
  step: 0
};

console.log('[LOBSTER] options=', JSON.stringify({ ...options, password: '***', reconnectToken: state.token ? '***' : '' }, null, 2));

const ws = new WebSocket(options.url);

function send(text, delay = 0) {
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      console.log('[SEND]', text);
      ws.send(text);
    }
  }, delay);
}

function buildCoexistCommands() {
  const cmds = [...options.commands];
  if (!cmds.includes('who')) cmds.unshift('who');
  return cmds;
}

function parseDelayCommand(raw) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^wait:(\d+)$/i);
  if (match) return { waitMs: Number(match[1]) };
  return { command: trimmed };
}

function runGameplayCommands() {
  const commands = buildCoexistCommands();
  let delay = 300;
  for (const raw of commands) {
    const item = parseDelayCommand(raw);
    if (item.waitMs) {
      delay += item.waitMs;
      continue;
    }
    send(item.command, delay);
    delay += 700;
  }
  setTimeout(() => {
    console.log('[LOBSTER] test flow complete');
    ws.close();
  }, delay + 1200);
}

ws.on('open', () => {
  console.log('[OPEN]', options.url);
  send(`/client_version ${options.clientVersion}`, 50);
});

ws.on('message', (buf) => {
  const msg = buf.toString();
  console.log('[RECV]', msg.replace(/\n/g, '\\n').slice(0, 1500));

  if (msg.startsWith('session:')) {
    state.token = msg.slice(8).trim();
    tokenStore[options.username] = state.token;
    saveTokenStore(tokenStore);
    console.log('[SESSION_TOKEN]', state.token);
    return;
  }

  if (msg.startsWith('version:')) {
    console.log('[SERVER_VERSION]', msg.slice(8).trim());
    return;
  }

  if (options.mode === 'reconnect' && !state.sentFlow && state.token && msg.includes('欢迎来到【武侠世界】MUD')) {
    state.sentFlow = true;
    send(`/reconnect ${options.username} ${state.token}`, 200);
    return;
  }

  if (options.mode === 'reconnect' && !state.token && msg.includes('欢迎来到【武侠世界】MUD')) {
    console.log('[WARN] reconnect mode 但没有 token，请先 register/login 一次。');
    ws.close();
    return;
  }

  if (options.mode === 'register' && !state.sentFlow && msg.includes('欢迎来到【武侠世界】MUD')) {
    state.sentFlow = true;
    send('register', 200);
    return;
  }

  if (options.mode === 'login' && !state.sentFlow && msg.includes('欢迎来到【武侠世界】MUD')) {
    state.sentFlow = true;
    send('login', 200);
    return;
  }

  if ((options.mode === 'register' || options.mode === 'login') && msg.includes('请输入用户名')) {
    send(options.username, 200);
    return;
  }

  if (options.mode === 'register' && msg.includes('请设置密码')) {
    send(options.password, 200);
    return;
  }

  if (options.mode === 'login' && msg.includes('请输入密码')) {
    send(options.password, 200);
    return;
  }

  if (!state.sawPrompt && msg.includes('\n>')) {
    state.sawPrompt = true;
    runGameplayCommands();
  }
});

ws.on('close', (code) => {
  console.log('[CLOSE]', code);
  if (state.token) {
    console.log('[TIP] reconnect token=', state.token);
  }
});

ws.on('error', (err) => {
  console.error('[ERROR]', err.message);
});