const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const mustContain = [
  'function getArrivalPrefix(',
  'function formatArrival(',
  'function broadcastRoomArrival(',
  "case 'where':",
  'getNpcCurrentRoom(',
  '正在',
  "return '奄奄一息地艰难';",
  'broadcastRoomArrival(player, player.room);'
];
const missing = mustContain.filter(x => !src.includes(x));
if (missing.length) {
  console.error('Missing patterns:', missing);
  process.exit(1);
}
console.log('Movement/where smoke patterns OK:', mustContain.length);
