const fs = require('fs');
const path = require('path');

const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const dataSrc = fs.readFileSync(path.join(__dirname, 'npc-data.js'), 'utf8');
const mustContain = [
  'list 老鸨',
  'buy 女儿红',
  'rumor 老鸨',
  'inquire 老鸨 about 扬州城',
  'list 客栈老板',
  'buy 客房牌',
  'rumor 客栈老板',
  'list 情报贩子',
  'buy 扬州传闻',
  'rumor 情报贩子',
  'rumor 六扇门捕头',
  'inquire 六扇门捕头 about 通缉',
  'list 镖头',
  'buy 简易地图',
  'rumor 镖头',
  "require('./npc-data')",
  'const smartNpcBlueprints = {',
  'const npcCatalog = {'
];
const src = serverSrc + '\n' + dataSrc;
const missing = mustContain.filter(x => !src.includes(x));
if (missing.length) {
  console.error('Missing patterns:', missing);
  process.exit(1);
}
console.log('NPC smoke patterns OK:', mustContain.length);
