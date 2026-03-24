const { spawn } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'lobster-client.js');
const baseUrl = process.env.MUD_URL || 'wss://bobo.rocks/';
const mode = process.env.MUD_MODE || 'register';
const prefix = process.env.MUD_PREFIX || 'lobster';
const password = process.env.MUD_PASSWORD || 'p1234';

const squad = [
  { profile: 'scout', username: `${prefix}_scout_${Math.random().toString(16).slice(2, 6)}` },
  { profile: 'chatter', username: `${prefix}_chat_${Math.random().toString(16).slice(2, 6)}` },
  { profile: 'fighter', username: `${prefix}_fight_${Math.random().toString(16).slice(2, 6)}` }
];

for (const member of squad) {
  const args = [
    script,
    '--url', baseUrl,
    '--mode', mode,
    '--username', member.username,
    '--password', password,
    '--profile', member.profile
  ];

  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const tag = `[${member.username}/${member.profile}]`;
  child.stdout.on('data', (buf) => process.stdout.write(`${tag} ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`${tag} ${buf}`));
  child.on('exit', (code) => console.log(`${tag} EXIT ${code}`));
}
