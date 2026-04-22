const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const db = require('./db');
const { chatWithNpc, PRIVATE_CONFIG_PATH, EXAMPLE_CONFIG_PATH } = require('./llm-npc');
const { npcCatalog, smartNpcBlueprints } = require('./npc-data');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WS_HEARTBEAT_INTERVAL_MS = 30000;
const WS_HEARTBEAT_MISS_LIMIT = 6;

function heartbeat() {
  this.isAlive = true;
  this.missedPongs = 0;
}

// 服务器启动时间
const serverStartTime = Date.now();

// 计算运行时间
function getUptime() {
  const diff = Date.now() - serverStartTime;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return { days, hours, minutes };
}

db.initDatabase();
db.invalidateAllSessionsForVersionMismatch();

console.log(`[启动检查] 工作目录: ${process.cwd()}`);
console.log(`[启动检查] users.json 路径: ${require('path').resolve('./users.json')}`);
console.log(`[启动检查] mud.db 路径: ${require('path').resolve('./mud.db')}`);

const APP_VERSION = db.APP_VERSION;
const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    frontendVersion: APP_VERSION,
    serverVersion: APP_VERSION,
    minClientVersion: APP_VERSION
  });
});

app.use(express.static(__dirname + '/public', {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

const usersFile = './users.json';
let users = {};

try {
  if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  }
} catch (e) {
  console.log('无法读取用户数据');
}

const jsonUserCount = users && typeof users === 'object' ? Object.keys(users).length : 0;
const importedCount = db.migrateFromJsonUsers(users);
if (importedCount > 0) {
  console.log(`Migrated ${importedCount} users from users.json into SQLite`);
}

const sqliteUsers = db.getAllUsers();
const sqliteUserCount = sqliteUsers.length;

if (jsonUserCount > 0 && sqliteUserCount === 0) {
  console.warn(`[数据风险] 检测到 users.json 有 ${jsonUserCount} 个用户，但 SQLite 中为 0。请确认部署目录是否正确，避免老用户数据丢失。`);
}
if (jsonUserCount === 0 && sqliteUserCount === 0) {
  console.warn('[数据风险] users.json 与 SQLite 都为空。如果这是线上环境，请立即检查是否误用了新空目录或新空库。');
}
if (jsonUserCount > 20 && importedCount === 0 && sqliteUserCount > 0) {
  console.warn(`[数据检查] users.json 中有 ${jsonUserCount} 个用户，SQLite 当前有 ${sqliteUserCount} 个用户，本次未发生迁移。若这是新部署，请确认 SQLite 是否已包含完整老数据。`);
}

users = Object.fromEntries(sqliteUsers.map((user) => [user.name, user]));

function reloadUsersFromDb() {
  users = Object.fromEntries(db.getAllUsers().map((user) => [user.name, user]));
}

function saveUsers() {
  for (const user of Object.values(users)) {
    db.saveUser(user);
  }
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function issueSession(userName, ws) {
  const meta = {
    clientVersion: ws.clientVersion || null,
    ip: ws._socket?.remoteAddress || null,
    userAgent: ws._socket?.parser ? null : null
  };
  const session = db.createSession(userName, meta);
  ws.sessionToken = session.token;
  // ws.send(`session:${session.token}`);
  ws.send(`version:${APP_VERSION}`);
  return session;
}

function markPlayerOnline(player, ws) {
  db.upsertOnlinePresence({
    userName: player.name,
    instanceId: INSTANCE_ID,
    room: player.room,
    clientType: ws.clientVersion ? 'lobster' : 'browser'
  });
}

function markPlayerHeartbeat(player) {
  db.touchOnlinePresence(player.name, player.room);
}

function markPlayerOffline(player) {
  db.removeOnlinePresence(player.name);
}

function restorePlayerFromStoredData(name, storedData) {
  const p = createPlayer(name);
  Object.assign(p, storedData);
  if (storedData.先天) {
    p.先天 = storedData.先天;
  }
  if (storedData.npcRelations && typeof storedData.npcRelations === 'object') {
    for (const [npcName, relation] of Object.entries(storedData.npcRelations)) {
      if (!npcPlayerState[npcName]) npcPlayerState[npcName] = {};
      npcPlayerState[npcName][name] = { ...relation };
    }
  }
  normalizeCombatState(p);
  p.title = getTitle(p.exp);
  return p;
}

function isValidUsername(name) {
  if (!name) return false;
  if (name.length < 2 || name.length > 20) return false;
  if (name.includes(' ')) return false;
  if (/[\r\n\t]/.test(name)) return false;
  return /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(name);
}

const weapons = {
  '木剑': { damage: 5, price: 10, weight: 5, desc: '一把普通的木剑' },
  '铁剑': { damage: 15, price: 50, weight: 8, desc: '精铁打造的剑' },
  '长剑': { damage: 25, price: 100, weight: 10, desc: '锋利的长剑' },
  '屠龙刀': { damage: 80, price: 2000, weight: 30, desc: '武林至尊，宝刀屠龙' },
  '倚天剑': { damage: 75, price: 1800, weight: 25, desc: '倚天不出，谁与争锋' },
  '君子剑': { damage: 45, price: 800, weight: 15, desc: '华山派镇派之宝' },
  '淑女剑': { damage: 40, price: 700, weight: 15, desc: '华山派雌剑' },
  // 黑市商品
  '大片刀': { damage: 30, price: 150, weight: 20, desc: '黑市刀具，锋利无比' },
  '散弹枪': { damage: 500, price: 5000, weight: 15, desc: '远程武器，可发射3次', ammo: 3 },
  '铜钱': { damage: 0, price: 1, weight: 0, desc: '随身携带的铜钱' }
};

const armors = {
  '布衣': { defense: 3, price: 10, weight: 3, desc: '普通的布衣' },
  '皮甲': { defense: 8, price: 30, weight: 8, desc: '皮革制成的护甲' },
  '铁甲': { defense: 15, price: 80, weight: 20, desc: '铁片编织的铠甲' },
  '金丝甲': { defense: 30, price: 500, weight: 10, desc: '刀枪不入的金丝甲' },
  '软猬甲': { defense: 35, price: 800, weight: 12, desc: '桃花岛至宝' }
};

const drinkItems = {
  '米酒': {
    type: '酒', category: '普通酒', price: 12, weight: 1, desc: '温和的米酒，带着淡淡粮香。',
    hp: 0, mp: 0, jingli: 12, drunkValue: 5, cooldown: 6000,
    selfFlavor: '酒液温温地下肚，像一股细小暖流从胸腹间慢慢散开。'
  },
  '女儿红': {
    type: '酒', category: '普通酒', price: 30, weight: 1, desc: '陈香绵长，入口微甜。',
    hp: 12, mp: 8, jingli: 0, drunkValue: 8, cooldown: 8000,
    selfFlavor: '醇厚酒香在舌尖一滚，喉间暖意绵绵不绝，倒真有几分江湖夜雨的意思。'
  },
  '烧刀子': {
    type: '酒', category: '烈酒', price: 45, weight: 1, desc: '酒性猛烈，入喉如火。',
    hp: 0, mp: 10, jingli: 0, drunkValue: 18, cooldown: 10000,
    buff: { atk: 4, crit: 3, hit: -3, dodge: -3, durationMs: 180000 },
    selfFlavor: '这一口烈酒如火线般直贯喉头，烧得你胸腔发热，胆气也随之一壮。'
  },
  '汾酒': {
    type: '酒', category: '雅酒', price: 36, weight: 1, desc: '清冽甘润，后劲却不小。',
    hp: 0, mp: 12, jingli: 0, drunkValue: 10, cooldown: 8000,
    insightChance: 0.18,
    selfFlavor: '酒意清冽，初入口时平平，回味却渐渐浮起，连心神都似被洗得澄明了些。'
  },
  '活血药酒': {
    type: '酒', category: '药酒', price: 55, weight: 1, desc: '药香与酒气交织，可活络气血。',
    hp: 25, mp: 0, jingli: 0, drunkValue: 12, cooldown: 12000,
    selfFlavor: '药力伴着酒气徐徐化开，你只觉筋骨间的滞涩被冲开了几分。'
  },
  '猴儿酒': {
    type: '酒', category: '珍酒', price: 88, weight: 1, desc: '山中异酿，灵气隐隐。',
    hp: 18, mp: 18, jingli: 0, drunkValue: 10, cooldown: 10000,
    insightChance: 0.25, expBonus: 5,
    selfFlavor: '甘香入口，竟带着山林清气，仿佛连胸中浊念都被洗去了半分。'
  },
  '竹叶青': {
    type: '酒', category: '雅酒', price: 60, weight: 1, desc: '清芬透鼻，入口清烈。',
    hp: 0, mp: 16, jingli: 4, drunkValue: 12, cooldown: 9000,
    insightChance: 0.22, expBonus: 4,
    selfFlavor: '竹叶清香直透鼻端，酒意却在喉间忽然转烈，像一缕寒风卷过肺腑。'
  }
};

const skillDb = {
  '基本内功': { type: '被动', desc: '提升最大生命值' },
  '基本拳法': { type: '被动', desc: '提升拳脚攻击力' },
  '基本轻功': { type: '被动', desc: '提升闪避能力' },
  '罗汉拳': { type: '主动', damage: 15, desc: '少林寺基础拳法' },
  '太祖长拳': { type: '主动', damage: 20, desc: '江湖常见拳法' },
  '伏虎拳': { type: '主动', damage: 25, desc: '少林寺进阶拳法' },
  '九阳神功': { type: '被动', desc: '至高无上的内功' },
  '九阴真经': { type: '被动', desc: '天下武学总纲' },
  '北冥神功': { type: '被动', desc: '逍遥派至高内功' },
  '紫霞神功': { type: '被动', desc: '华山派至高内功' },
  '易筋经': { type: '被动', desc: '少林寺至高内功' },
  '降龙十八掌': { type: '主动', damage: 50, desc: '天下第一掌法' },
  '六脉神剑': { type: '主动', damage: 60, desc: '大理段氏绝技' },
  '孤独九剑': { type: '主动', damage: 55, desc: '风清扬绝技' },
  '太极拳': { type: '主动', damage: 40, desc: '张三丰所创' },
  // 桃花岛武功
  '落英神掌': { type: '主动', damage: 30, desc: '桃花岛主黄药师绝技' },
  '弹指神通': { type: '主动', damage: 35, desc: '桃花岛秘传暗器功夫' },
  '玉箫剑法': { type: '主动', damage: 40, desc: '黄药师自创剑法' },
  '碧海潮生曲': { type: '主动', damage: 25, desc: '以音律扰敌心神' },
  '九阴真经': { type: '被动', desc: '天下武学总纲（含桃花岛武学）' },
  '五行八卦掌': { type: '主动', damage: 45, desc: '桃花岛至高掌法' },
  // 陆小凤传奇武功
  '灵犀指': { type: '主动', damage: 50, desc: '陆小凤的独门绝技，可隔空点穴' },
  '天外飞仙': { type: '主动', damage: 60, desc: '西门吹雪的剑法极致，一剑仙人败' },
  '剑神': { type: '被动', damage: 0, desc: '西门吹雪的境界，无招胜有招' },
  '白云城主': { type: '被动', damage: 0, desc: '叶孤城的独门轻功' },
  '紫禁之巅': { type: '主动', damage: 55, desc: '江湖最负盛名的决战剑招' },
  '凤凰步': { type: '被动', damage: 0, desc: '陆小凤的绝顶轻功' },
  '无形剑': { type: '主动', damage: 45, desc: '青衣楼杀手的隐秘剑术' },
  '学文识字': { type: '被动', damage: 0, desc: '提升识读典籍、精神力与悟性发挥' }
};

// 技能别名映射
const skillAliases = {
  "luohanquan": "罗汉拳", "太祖长拳": "太祖长拳", "伏虎拳": "伏虎拳",
  "yijinjing": "易筋经", "jiuyang": "九阳神功", "jiuyin": "九阴真经",
  "beiming": "北冥神功", "zixia": "紫霞神功", "xlongzhang": "降龙十八掌",
  "liumai": "六脉神剑", "dugu": "孤独九剑", "taiji": "太极拳",
  "luoyingshen掌": "落英神掌", "luoying": "落英神掌", "tanzhi": "弹指神通",
  "yuxiao": "玉箫剑法", "bihai": "碧海潮生曲", "wuxing": "五行八卦掌",
  "jibenneigong": "基本内功", "jibenquanfa": "基本拳法", "jibenqinggong": "基本轻功",
  "lingxizhi": "灵犀指", "tianwaifeixian": "天外飞仙", "danzhishentong": "弹指神通", "yuxiaojianfa": "玉箫剑法",
  "literacy": "学文识字"
};

const skillEnglishNames = {
  '基本内功': 'jibenneigong',
  '基本拳法': 'jibenquanfa',
  '基本轻功': 'jibenqinggong',
  '罗汉拳': 'luohanquan',
  '太祖长拳': 'taizuchangquan',
  '伏虎拳': 'fuhuquan',
  '九阳神功': 'jiuyang',
  '九阴真经': 'jiuyin',
  '北冥神功': 'beiming',
  '紫霞神功': 'zixia',
  '易筋经': 'yijinjing',
  '降龙十八掌': 'xianglongshibazhang',
  '六脉神剑': 'liumai',
  '孤独九剑': 'dugu',
  '太极拳': 'taiji',
  '落英神掌': 'luoying',
  '弹指神通': 'tanzhi',
  '玉箫剑法': 'yuxiaojianfa',
  '碧海潮生曲': 'bihaichaoshengqu',
  '五行八卦掌': 'wuxingbaguazhang',
  '灵犀指': 'lingxizhi',
  '天外飞仙': 'tianwaifeixian',
  '学文识字': 'literacy'
};

const titles = [
  { exp: 0, title: '初入江湖' },
  { exp: 100, title: '小有名气' },
  { exp: 500, title: '江湖新秀' },
  { exp: 1500, title: '一代高手' },
  { exp: 5000, title: '名震天下' },
  { exp: 15000, title: '武林盟主' }
];

// 拜师系统
const masters = {
  '岳不群': { school: '华山派', location: '华山派大厅', skill: '紫霞神功', desc: '华山派掌门', requiredExp: 100 },
  'yuebuqun': { school: '华山派', location: '华山派大厅', skill: '紫霞神功', desc: '华山派掌门', requiredExp: 100 },
  '风清扬': { school: '华山派', location: '思过崖', skill: '孤独九剑', desc: '华山派太师叔祖', requiredExp: 500 },
  'fengqingyang': { school: '华山派', location: '思过崖', skill: '孤独九剑', desc: '华山派太师叔祖', requiredExp: 500 },
  '方丈': { school: '少林寺', location: '方丈室', skill: '易筋经', desc: '少林寺方丈', requiredExp: 100 },
  'fangzhang': { school: '少林寺', location: '方丈室', skill: '易筋经', desc: '少林寺方丈', requiredExp: 100 },
  '玄慈': { school: '少林寺', location: '方丈室', skill: '易筋经', desc: '少林寺玄慈大师', requiredExp: 100 },
  'xuanci': { school: '少林寺', location: '方丈室', skill: '易筋经', desc: '少林寺玄慈大师', requiredExp: 100 },
  '扫地僧': { school: '少林寺', location: '藏经阁', skill: '北冥神功', desc: '藏经阁隐居高僧', requiredExp: 500 },
  'saodisen': { school: '少林寺', location: '藏经阁', skill: '北冥神功', desc: '藏经阁隐居高僧', requiredExp: 500 },
  '张三丰': { school: '武当派', location: '武当山', skill: '太极拳', desc: '武当派创始人', requiredExp: 200 },
  // 桃花岛
  '黄药师': { school: '桃花岛', location: '桃花岛', skill: '落英神掌', desc: '桃花岛主', requiredExp: 80 },
  'huangyaoshi': { school: '桃花岛', location: '桃花岛', skill: '落英神掌', desc: '桃花岛主', requiredExp: 80 },
  // 凤栖城（陆小凤传奇）
  '陆小凤': { school: '逍遥派', location: '凤栖城·迎风客栈', skill: '灵犀指', desc: '四条眉毛的陆小凤', requiredExp: 120 },
  'luxiaofeng': { school: '逍遥派', location: '凤栖城·迎风客栈', skill: '灵犀指', desc: '四条眉毛的陆小凤', requiredExp: 120 },
  '西门吹雪': { school: '万梅山庄', location: '紫禁之巅', skill: '天外飞仙', desc: '剑神西门吹雪', requiredExp: 300 },
  'ximenchuixue': { school: '万梅山庄', location: '紫禁之巅', skill: '天外飞仙', desc: '剑神西门吹雪', requiredExp: 300 },
  '叶孤城': { school: '白云城', location: '紫禁之巅', skill: '天外飞仙', desc: '白云城主叶孤城', requiredExp: 300 },
  'yegucheng': { school: '白云城', location: '紫禁之巅', skill: '天外飞仙', desc: '白云城主叶孤城', requiredExp: 300 },
};

const masterSkillLevels = {
  '岳不群': { '基本内功': 18, '基本拳法': 14, '基本轻功': 13, '紫霞神功': 16 },
  'yuebuqun': { '基本内功': 18, '基本拳法': 14, '基本轻功': 13, '紫霞神功': 16 },
  '风清扬': { '基本轻功': 18, '基本拳法': 15, '孤独九剑': 20 },
  'fengqingyang': { '基本轻功': 18, '基本拳法': 15, '孤独九剑': 20 },
  '方丈': { '基本内功': 18, '罗汉拳': 16, '基本轻功': 12, '易筋经': 17 },
  'fangzhang': { '基本内功': 18, '罗汉拳': 16, '基本轻功': 12, '易筋经': 17 },
  '玄慈': { '基本内功': 17, '罗汉拳': 15, '易筋经': 16, '学文识字': 16 },
  'xuanci': { '基本内功': 17, '罗汉拳': 15, '易筋经': 16, '学文识字': 16 },
  '扫地僧': { '基本内功': 22, '易筋经': 21, '北冥神功': 19 },
  'saodisen': { '基本内功': 22, '易筋经': 21, '北冥神功': 19 },
  '张三丰': { '基本内功': 20, '基本轻功': 16, '太极拳': 18 },
  '黄药师': { '基本内功': 16, '落英神掌': 17, '弹指神通': 16, '玉箫剑法': 15, '碧海潮生曲': 15 },
  'huangyaoshi': { '基本内功': 16, '落英神掌': 17, '弹指神通': 16, '玉箫剑法': 15, '碧海潮生曲': 15 },
  '陆小凤': { '基本轻功': 17, '灵犀指': 18 },
  'luxiaofeng': { '基本轻功': 17, '灵犀指': 18 },
  '西门吹雪': { '基本轻功': 15, '天外飞仙': 19 },
  'ximenchuixue': { '基本轻功': 15, '天外飞仙': 19 },
  '叶孤城': { '基本轻功': 15, '天外飞仙': 19 },
  'yegucheng': { '基本轻功': 15, '天外飞仙': 19 }
};

// 扬州城区域 (鹿鼎记)
const rooms = {
  '丽春院': {
    description: '扬州城内最著名的青楼，灯火通明，丝竹之声不绝。这里是韦小宝小时候长大的地方。',
    exits: { '西': '扬州小巷' },
    npcs: ['老鸨', '春花', '秋月'],
    shop: null
  },
  '扬州街北': {
    description: '扬州主街北段，离城门不远，人流熙攘。东边挂着客栈招牌，西边则是一条通往药店和丽春院方向的偏巷。',
    exits: { '东': '客栈', '西': '扬州小巷', '南': '扬州街中', '北': '扬州城门' },
    npcs: ['小贩', '行人', '官兵'],
    shop: null
  },
  '扬州街中': {
    description: '扬州主街正中，两旁店肆林立，吆喝声不绝于耳。再往南便离码头不远。',
    exits: { '东': '武器铺', '西': '药店', '南': '扬州街南', '北': '扬州街北' },
    npcs: ['小贩', '行人', '官兵'],
    shop: null
  },
  '扬州街南': {
    description: '扬州主街南段，空气里渐渐有了水汽和河风，往南便是码头。',
    exits: { '东': '防具铺', '西': '赌场', '南': '扬州码头', '北': '扬州街中' },
    npcs: ['脚夫', '行人'],
    shop: null
  },
  '东郊驿道': {
    description: '扬州城东郊的驿道，向东延伸至凤栖古道。',
    exits: { '西': '扬州街中', '东': '凤栖古道' },
    npcs: ['驿卒'],
    shop: null,
    area: '江湖'
  },
  '凤栖古道': {
    description: '古老的官道，尽头隐约可见凤栖城的灯火。',
    exits: { '西': '东郊驿道', '东': '凤栖城·外门' },
    npcs: ['赶路人'],
    shop: null,
    area: '江湖'
  },
  '凤栖城·外门': {
    description: '凤栖城的外城门，城门高大，来往商旅络绎不绝。',
    exits: { '西': '凤栖古道', '进城': '凤栖城·迎风客栈' },
    npcs: ['城门守卫'],
    shop: null,
    area: '江湖'
  },
  '凤栖城·迎风客栈': {
    description: '凤栖城最著名的客栈，南来北往的江湖客多在此落脚。是凤栖城的中心枢纽。',
    exits: { '离城': '凤栖城·外门', '北': '听雨楼', '东': '四海镖局', '西': '六扇门分署' },
    npcs: ['客栈老板', '小二', '江湖客'],
    shop: null,
    area: '江湖'
  },
  '听雨楼': {
    description: '凤栖城最大的情报交易场所，三教九流汇集于此，打探消息的最佳地点。',
    exits: { '南': '凤栖城·迎风客栈' },
    npcs: ['情报贩子', '神秘人'],
    shop: null,
    area: '江湖'
  },
  '四海镖局': {
    description: '凤栖城最大的镖局，承接各种押镖业务。',
    exits: { '西': '凤栖城·迎风客栈' },
    npcs: ['镖头', '镖师'],
    shop: null,
    area: '江湖'
  },
  '六扇门分署': {
    description: '六扇门在凤栖城的分部，负责维护当地治安。',
    exits: { '东': '凤栖城·迎风客栈' },
    npcs: ['六扇门捕头', '捕快'],
    shop: null,
    area: '江湖'
  },
  '赌场': {
    description: '扬州城内最大的赌场，乌烟瘴气，骰子声、叫喝声此起彼伏。角落里新摆了三张掼蛋牌桌，分别收铜钱、银两、黄金做底注。墙上还贴着说明：输入 guandan 可查看规则，输入 guandan list 可看桌级，赢钱靠手气，输钱别砸桌子。',
    exits: { '北': '扬州小巷' },
    npcs: ['赌徒', '庄家', '荷官', '牌桌老李', '牌桌老周', '牌桌老孙'],
    shop: null
  },
  '扬州码头': {
    description: '运河边的码头，船只来来往往，货物堆积如山。远处停着一艘远洋客轮。',
    exits: { '北': '扬州街南', '东': '运河', '上船': '远洋客轮甲板', '客轮': '远洋客轮甲板' },
    npcs: ['船夫', '脚夫'],
    shop: null
  },
  '运河': {
    description: '京杭大运河水面宽阔，来往船只络绎不绝。',
    exits: { '西': '扬州码头' },
    npcs: [],
    shop: null
  },
  '扬州小巷': {
    description: '一条偏僻的小巷，两边是低矮的民房。北边是药店，南边是赌场，东边便是灯火通明的丽春院，西边可折回主街。',
    exits: { '北': '药店', '南': '赌场', '东': '丽春院', '西': '扬州街北' },
    npcs: ['流浪猫'],
    shop: null
  },
  '扬州城门': {
    description: '扬州城的北门，城门高大坚固，官兵把守严密。',
    exits: { '南': '扬州街北', '北': '扬州郊外' },
    npcs: ['官兵', '守门士兵'],
    shop: null
  },
  '扬州郊外': {
    description: '扬州城北郊的一片树林，林中有一条小路向北方延伸。往东可以听到海浪声，往西似乎有一条官道。',
    exits: { '南': '扬州城门', '北': '少林寺山路', '东': '竹林', '西': '青石官道' },
    npcs: ['猎人'],
    shop: null
  },

  // 凤栖城路线
  '青石官道': {
    description: '一条通往京城的青石官道，路上商旅往来不绝。',
    exits: { '东': '扬州郊外', '西': '枫林渡口' },
    npcs: ['商贩', '镖师'],
    shop: null,
    area: '江湖'
  },
  '枫林渡口': {
    description: '枫林边的渡口，有船只通往凤栖城。',
    exits: { '东': '青石官道', '登船': '凤栖城码头' },
    npcs: ['船夫'],
    shop: null,
    area: '江湖'
  },
  '凤栖城码头': {
    description: '凤栖城著名的码头，岸边停靠着各色船只。这里是江湖中人进入凤栖城的必经之地。',
    exits: { '下船': '凤栖城·东区', '东': '凤栖城·港口区' },
    npcs: ['码头脚夫', '江湖客'],
    shop: null,
    area: '江湖'
  },

  // 凤栖城区域
  '凤栖城·港口区': {
    description: '凤栖城最繁华的港口区域，各路货物在此集散。',
    exits: { '西': '凤栖城码头', '北': '凤栖城·东区', '东': '凤栖城·码头' },
    npcs: ['商人', '水手'],
    shop: null,
    area: '江湖'
  },
  '凤栖城·东区': {
    description: '凤栖城东部街区，青楼、酒馆林立。',
    exits: { '南': '凤栖城·港口区', '北': '凤栖城·西区', '珠光': '珠光宝气阁' },
    npcs: ['行人', '浪子'],
    shop: null,
    area: '江湖'
  },
  '凤栖城·西区': {
    description: '凤栖城西部，平南王府所在，戒备森严。',
    exits: { '南': '凤栖城·东区', '北': '凤栖城·中心广场', '王府': '平南王府' },
    npcs: ['王府侍卫'],
    shop: null,
    area: '江湖'
  },
  '凤栖城·中心广场': {
    description: '凤栖城中心广场，江湖艺人汇集于此。',
    exits: { '南': '凤栖城·西区', '东': '凤栖城·东区', '西北': '青衣楼' },
    npcs: ['卖艺人', '围观群众'],
    shop: null,
    area: '江湖'
  },

  // 凤栖城重要地点
  '珠光宝气阁': {
    description: '珠光宝气阁，江湖最大的珠宝交易场所。阁主霍休富甲天下。',
    exits: { '离开': '凤栖城·东区', '密道': '青衣楼秘密通道' },
    npcs: ['霍休', '珠宝商'],
    shop: null,
    area: '江湖'
  },
  '平南王府': {
    description: '平南王府，当今皇上的胞弟居住之地。守卫森严，普通人难以进入。',
    exits: { '离开': '凤栖城·西区', '书房': '王府书房' },
    npcs: ['平南王', '护卫统领'],
    shop: null,
    area: '江湖'
  },
  '王府书房': {
    description: '平南王的书房，里面藏有各种机密文件。',
    exits: { '返回': '平南王府' },
    npcs: [],
    shop: null,
    area: '江湖'
  },
  '青衣楼': {
    description: '江湖第一杀手组织青衣楼的总部，楼内一百零八楼主神出鬼没。',
    exits: { '东南': '凤栖城·中心广场', '密室': '青衣楼密室' },
    npcs: ['青衣楼杀手', '霍休'],
    shop: null,
    area: '江湖'
  },
  '青衣楼秘密通道': {
    description: '一条连接珠光宝气阁和青衣楼的秘密通道。',
    exits: { '返回': '珠光宝气阁', '出口': '青衣楼密室' },
    npcs: [],
    shop: null,
    area: '江湖'
  },
  '青衣楼密室': {
    description: '青衣楼最隐秘的所在，只有核心成员才知道此处。',
    exits: { '返回': '青衣楼', '出口': '青衣楼秘密通道' },
    npcs: ['青衣楼主人'],
    shop: null,
    area: '江湖'
  },
  '紫禁之巅': {
    description: '皇宫屋顶，江湖中人梦寐以求的决战之地。西门吹雪与叶孤城曾在此决战！',
    exits: { '返回': '凤栖城·中心广场', '飞跃': '皇宫殿顶' },
    npcs: [],
    shop: null,
    area: '江湖'
  },
  '皇宫殿顶': {
    description: '皇宫最高处，可以俯瞰整个凤栖城。',
    exits: { '返回': '紫禁之巅' },
    npcs: ['大内高手'],
    shop: null,
    area: '江湖'
  },

  // 桃花岛迷宫
  '竹林': {
    description: '一片茂密的竹林，竹叶沙沙作响。你注意到地面上有一个奇怪的八卦图案。',
    exits: { '西': '扬州郊外', '东南': '桃花阵入口' },
    npcs: [],
    shop: null,
    area: '江湖'
  },
  '桃花阵入口': {
    description: '桃花阵入口，地上刻着八卦符号。需按正确方位闯入。',
    exits: { '西北': '竹林', '东': '桃花岛外' },
    npcs: [],
    shop: null,
    area: '江湖'
  },
  '桃花岛外': {
    description: '桃花岛外围，桃花盛开。',
    exits: { '西': '桃花阵入口', '进入': '桃花岛' },
    npcs: [],
    shop: null,
    area: '江湖'
  },

  // 武器铺
  '武器铺': {
    description: '武器铺内挂满了各种兵器，墙上挂着屠龙刀和倚天剑。',
    exits: { '西': '扬州街中' },
    npcs: ['铁匠'],
    shop: 'weapon'
  },
  '防具铺': {
    description: '防具铺里挂着各种护甲，角落里还有一件软猬甲。',
    exits: { '西': '扬州街南' },
    npcs: ['裁缝'],
    shop: 'armor'
  },
  '药店': {
    description: '药店内弥漫着药香，柜台后摆满了各种药材。',
    exits: { '东': '扬州街中', '南': '扬州小巷' },
    npcs: ['药师'],
    shop: 'medicine'
  },
  '客栈': {
    description: '江湖客栈大厅，门口挂着两盏大红灯笼，柜台上摆着酒坛。客栈旁还开着兵器和护具铺子。',
    exits: { '西': '扬州街北', '北': '练功房', '上': '客房' },
    npcs: ['店小二', '客栈老板'],
    shop: null
  },
  '练功房': {
    description: '客栈后院的一间石室，虽然简陋但很安静，适合打坐练功。',
    exits: { '南': '客栈' },
    npcs: [],
    shop: null
  },
  '客房': {
    description: '客栈二楼客房，被褥整洁，窗明几净。',
    exits: { '下': '客栈' },
    npcs: [],
    shop: null
  },
  // 少林寺 (倚天屠龙记/天龙八部)
  '少林寺山路': {
    description: '通往少林寺的山路蜿蜒向上，两旁古松苍翠。',
    exits: { '南': '扬州郊外', '北': '少林寺山门' },
    npcs: ['香客', '挑夫'],
    shop: null
  },
  '少林寺山门': {
    description: '少林寺山门高大巍峨，"少林寺"三个金宇高悬门额。两尊金刚力士像分立两侧。',
    exits: { '南': '少林寺山路', '北': '少林寺大院' },
    npcs: ['守门僧'],
    shop: null
  },
  '少林寺大院': {
    description: '少林寺核心区域，青砖铺地，古木参天。大雄宝殿巍峨壮观。',
    exits: { '南': '少林寺山门', '东': '藏经阁', '西': '罗汉堂', '北': '方丈室' },
    npcs: ['少林僧人', '小沙弥'],
    shop: null
  },
  '藏经阁': {
    description: '藏经阁内书架林立，收藏了数千卷佛经和武学典籍。扫地僧正在角落打扫。',
    exits: { '西': '少林寺大院' },
    npcs: ['扫地僧', '藏经阁长老'],
    shop: null
  },
  '罗汉堂': {
    description: '罗汉堂内供奉着五百罗汉金像，形态各异。少林武僧们常在此练武。',
    exits: { '东': '少林寺大院', '北': '少林武僧院' },
    npcs: ['罗汉堂首座', '武僧'],
    shop: null
  },
  '少林武僧院': {
    description: '少林武僧的住所，院内十八铜人像威风凛凛。',
    exits: { '南': '罗汉堂' },
    npcs: ['少林武僧'],
    shop: null
  },
  '方丈室': {
    description: '方丈室庄严素雅，屋内陈设简单。一位白眉老僧正在打坐。',
    exits: { '南': '少林寺大院', '东': '少林僧房' },
    npcs: ['方丈', '玄慈'],
    shop: null
  },
  // 华山派 (笑傲江湖)
  '华山山脚': {
    description: '华山脚下的一块平地，四面环山。一条石阶路向山顶延伸。',
    exits: { '南': '少林寺山路', '北': '华山山门', '东': '华山别院' },
    npcs: ['挑夫', '游客'],
    shop: null
  },
  '华山山门': {
    description: '华山派山门，上书"华山派"三个大字。',
    exits: { '南': '华山山脚', '北': '华山派大厅' },
    npcs: ['华山弟子'],
    shop: null
  },
  '华山派大厅': {
    description: '华山派议事大厅，正中悬挂着一幅华山论剑图。',
    exits: { '南': '华山山门', '东': '思过崖', '西': '华山弟子房', '北': '华山后山' },
    npcs: ['岳不群', 'yuebuqun', 'masteryue', '华山弟子'],
    shop: null
  },
  '华山弟子房': {
    description: '华山派弟子居住的厢房，屋内整洁朴素。令弧冲以前就住在这里。',
    exits: { '东': '华山派大厅' },
    npcs: ['华山弟子'],
    shop: null
  },
  '思过崖': {
    description: '华山后山的一面悬崖，令狐冲曾在此面壁思过。一位白须老者站在悬崖边。',
    exits: { '西': '华山派大厅', '南': '华山密道' },
    npcs: ['风清扬', 'fengqingyang', 'masterfeng'],
    shop: null
  },
  '华山密道': {
    description: '华山派禁地，一条隐秘的山洞，收藏着日月神教的武功秘笈。',
    exits: { '北': '思过崖' },
    npcs: [],
    shop: null
  },
  '华山后山': {
    description: '华山后山风景秀丽，满山红叶。群峰耸立，云雾缭绕。',
    exits: { '南': '华山派大厅', '北': '华山之巅' },
    npcs: ['隐士'],
    shop: null
  },
  '华山之巅': {
    description: '华山最高处，群山都在脚下。这里是当年华山论剑的地方。',
    exits: { '南': '华山后山' },
    npcs: [],
    shop: null
  },
  '华山别院': {
    description: '华山派别院，接待宾客的地方。院内种着几株梅树。',
    exits: { '西': '华山山脚' },
    npcs: ['华山仆役'],
    shop: null
  },
  '华山练功房': {
    description: '华山派练功房，屋内兵器架上摆满了各种武器。',
    exits: { '南': '华山派大厅' },
    npcs: [],
    shop: null
  },
  '少林练功房': {
    description: '少林寺练功房，屋内金砖铺地，宽敞明亮。',
    exits: { '东': '罗汉堂', '南': '少林僧房' },
    npcs: [],
    shop: null
  },
  '少林僧房': {
    description: '少林僧房陈设朴素，木榻、蒲团与经卷摆放整齐。这里既可打坐调息，也可小憩恢复体力。',
    exits: { '西': '方丈室', '北': '少林练功房' },
    npcs: [],
    shop: null
  },

  // ============ 扬州码头 - 出海线 ============
  '远洋客轮甲板': {
    description: '你站在一艘远洋客轮的甲板上。海风呼啸，甲板微微摇晃。远处是一片迷雾',
    exits: { '船舱': '客轮船舱', '船头': '客轮船头', '继续': '风暴海域', '航行': '风暴海域' },
    npcs: ['船长', '水手'],
    shop: null,
    area: '出海'
  },
  '客轮船舱': {
    description: '船舱内灯光昏暗，乘客们议论着即将到来的旅程。',
    exits: { '甲板': '远洋客轮甲板' },
    npcs: ['商人', '乘客'],
    shop: null,
    area: '出海'
  },
  '客轮船头': {
    description: '船头破浪前行，浪花飞溅。你注意到天空中有一道奇异的光芒。',
    exits: { '甲板': '远洋客轮甲板' },
    npcs: [],
    shop: null,
    area: '出海'
  },
  '风暴海域': {
    description: '海面狂风大作，巨浪滔天。船身剧烈摇晃，仿佛随时会被吞没。',
    exits: { '继续': '新港外湾' },
    npcs: [],
    shop: null,
    area: '出海'
  },
  '新港外湾': {
    description: '你穿越了风暴，前方出现了一座灯火辉煌的现代化港口。',
    exits: { '进港': '临海新港城·旧码头区', '返回': '远洋客轮甲板' },
    npcs: ['引航员'],
    shop: null,
    area: '出海'
  },

  // ============ 临海新港城（现代都市） ============
  '临海新港城·旧码头区': {
    description: '你站在临海新港城的旧码头区。现代化的集装箱堆积如山，远处是林立的高楼。这里是黑市和线人的聚集地。',
    exits: { '北': '临海新港城·中央科研区', '东': '临海新港城·金融塔区', '码头': '新港外湾', '仓库': '废弃仓库' },
    npcs: ['黑市商人', '线人老王', '水手长'],
    shop: null,
    area: '都市'
  },
  '临海新港城·中央科研区': {
    description: '这里是临海城的核心——天文台和粒子物理实验室所在地。研究员们行色匆匆，窃窃私语。',
    exits: { '南': '临海新港城·旧码头区', '东': '临海新港城·居住街区', '实验室': '粒子实验室' },
    npcs: ['天文台长', '研究员', '保安'],
    shop: null,
    area: '都市'
  },
  '粒子实验室': {
    description: '粒子物理实验室的核心区域。一台巨型粒子对撞机安静地运转着，墙上的显示屏闪烁着奇怪的数据。',
    exits: { '出口': '临海新港城·中央科研区' },
    npcs: ['首席科学家'],
    shop: null,
    area: '都市'
  },
  '临海新港城·金融塔区': {
    description: 'CBD核心区，摩天大楼直插云霄。这里是资本和权力的中心。',
    exits: { '西': '临海新港城·旧码头区', '北': '临海新港城·居住街区' },
    npcs: ['金融大亨', '秘书', '保镖'],
    shop: null,
    area: '都市'
  },
  '临海新港城·居住街区': {
    description: '普通的居民区，超市、咖啡馆、公园。居民们议论着最近天空中的"异常闪光"。',
    exits: { '西': '临海新港城·中央科研区', '南': '临海新港城·金融塔区', '北': '临海新港城·封锁港防区' },
    npcs: ['居民', '记者', '小孩'],
    shop: null,
    area: '都市'
  },
  '临海新港城·封锁港防区': {
    description: '军港封锁区荷枪实弹的士兵把守。这里是应对"宇宙危机"的前沿阵地。',
    exits: { '南': '临海新港城·居住街区', '深入': '地下指挥中心' },
    npcs: ['军官', '士兵', '安全局联络官'],
    shop: null,
    area: '都市'
  },

  // ============ 三体宇宙线 - 深层设施 ============
  '地下指挥中心': {
    description: '深入地下的危机应对指挥中心。巨大的显示屏上播放着全球观测站的实时数据。',
    exits: { '返回': '临海新港城·封锁港防区', '电梯': '深空通讯站' },
    npcs: ['作战参谋', '科学家'],
    shop: null,
    area: '三体'
  },
  '深空通讯站': {
    description: '巨大的射电望远镜阵列指向星空。这里负责监听来自宇宙的信号。',
    exits: { '返回': '地下指挥中心', '观测': '天文台主控室' },
    npcs: ['通讯官', '天文学家'],
    shop: null,
    area: '三体'
  },
  '天文台主控室': {
    description: '控制着全球最大的天文望远镜。墙上有一个巨大的显示屏，显示着半人马座方向的分析数据。',
    exits: { '返回': '深空通讯站' },
    npcs: ['首席科学家', '研究员'],
    shop: null,
    area: '三体'
  },

  // ============ 三体宇宙线 - ETO巢穴 ============
  '废弃仓库': {
    description: '城郊一处废弃的仓库，表面上已经废弃多年，实际上是ETO（地球三体组织）的秘密联络点。',
    exits: { '离开': '临海新港城·旧码头区', '地下室': 'ETO秘密基地' },
    npcs: ['神秘人', '接头人'],
    shop: null,
    area: '三体'
  },
  'ETO秘密基地': {
    description: 'ETO的地下秘密基地。墙上挂着三体文明的标志—"脱水"与"浸泡"的图案。',
    exits: { '返回': '废弃仓库', '祭坛': '三体祭坛' },
    npcs: ['降临派长老', 'ETO成员'],
    shop: null,
    area: '三体'
  },
  '三体祭坛': {
    description: '一个神秘的祭坛，上面供奉着三体文明的符号。祭坛中央是一个奇怪的水晶球，似乎在接收某种信号。',
    exits: { '返回': 'ETO秘密基地' },
    npcs: ['大主教'],
    shop: null,
    area: '三体'
  },

  // ============ 武侠区域扩展 - 桃花岛 ============
  '桃花岛': {
    description: '桃花岛上落英缤纷，布置着奇门遁甲阵法。黄药师隐居于此。',
    exits: { '离开': '桃花岛外' },
    npcs: ['黄药师', '程英', '陆无双'],
    shop: null,
    area: '江湖'
  }
};

const players = {};
const corpses = {};
const vendettas = new Map();
const skills = {
  '基本内功': { level: 1, exp: 0 },
  '基本拳法': { level: 1, exp: 0 },
  '基本轻功': { level: 1, exp: 0 },
  '学文识字': { level: 0, exp: 0, learnProgress: 0 }
};

const schoolPerformDb = {
  '华山派': {
    '狂风快剑': {
      skill: '孤独九剑', minLevel: 10, minExp: 120, mpCost: 30, damageRate: 1.42, hitBonus: 14, critBonus: 8,
      lines: ['剑光骤起，似狂风卷地', '寒芒连闪，似骤雨穿林', '人未近前，杀机已满长空']
    },
    '紫霞冲霄': {
      skill: '紫霞神功', minLevel: 8, minExp: 100, mpCost: 26, damageRate: 1.34, hitBonus: 12, critBonus: 5,
      lines: ['紫气浮空，真息鼓荡', '掌未发而气已先至', '一式推出，宛如长虹贯日']
    }
  },
  '少林寺': {
    '罗汉伏魔': {
      skill: '罗汉拳', minLevel: 8, minExp: 90, mpCost: 24, damageRate: 1.33, hitBonus: 10, critBonus: 4,
      lines: ['拳出如钟鸣古寺', '步进如金刚镇地', '劲力层层叠叠，直逼心脉']
    }
  },
  '桃花岛': {
    '落英缤纷': {
      skill: '落英神掌', minLevel: 8, minExp: 80, mpCost: 24, damageRate: 1.35, hitBonus: 12, critBonus: 6,
      lines: ['掌影飘摇，如落英满天', '虚实互生，教人难辨来路', '掌风一转，已封人周身要穴']
    }
  },
  '逍遥派': {
    '灵犀一指': {
      skill: '灵犀指', minLevel: 10, minExp: 120, mpCost: 28, damageRate: 1.4, hitBonus: 16, critBonus: 8,
      lines: ['两指轻拈，似慢实疾', '指风破空，直取敌手空门', '旁人未看清，胜负已分三分']
    }
  },
  '万梅山庄': {
    '天外飞仙': {
      skill: '天外飞仙', minLevel: 12, minExp: 220, mpCost: 40, damageRate: 1.55, hitBonus: 16, critBonus: 10,
      lines: ['一剑起处，似九天仙影垂落', '寒光照眼，天地间仿佛只余此剑', '人剑相随，刹那便是生死之分']
    }
  },
  '白云城': {
    '飞仙绝响': {
      skill: '天外飞仙', minLevel: 12, minExp: 220, mpCost: 38, damageRate: 1.5, hitBonus: 15, critBonus: 9,
      lines: ['白云尽散，剑意独明', '身形一纵，仿佛踏月而来', '剑势将尽未尽，却已逼人绝路']
    }
  }
};

const skillBooks = {
  '紫霞神功': ['紫霞秘籍', '紫霞秘笈', '紫霞壁画', '紫霞羊皮卷'],
  '孤独九剑': ['独孤九剑秘籍', '独孤九剑剑谱', '思过崖壁画', '独孤九剑羊皮卷'],
  '易筋经': ['易筋经', '易筋经秘籍', '易筋经羊皮卷'],
  '北冥神功': ['北冥神功秘籍', '北冥残卷', '逍遥羊皮卷'],
  '太极拳': ['太极拳谱', '太极拳经', '真武壁画'],
  '落英神掌': ['落英神掌秘籍', '桃花岛壁画', '落英残卷'],
  '灵犀指': ['灵犀指谱', '灵犀指秘籍'],
  '天外飞仙': ['天外飞仙剑谱', '飞仙残页'],
  '罗汉拳': ['罗汉拳谱'],
  '太祖长拳': ['太祖长拳谱'],
  '伏虎拳': ['伏虎拳谱'],
  '九阳神功': ['九阳真经残卷'],
  '九阴真经': ['九阴真经', '九阴真经残卷'],
  '弹指神通': ['弹指神通秘籍'],
  '玉箫剑法': ['玉箫剑谱'],
  '碧海潮生曲': ['碧海潮生曲谱'],
  '五行八卦掌': ['五行八卦掌谱']
};

const npcPerformDb = {
  '岳不群': { school: '华山派', performs: ['紫霞冲霄'] },
  '风清扬': { school: '华山派', performs: ['狂风快剑'] },
  '方丈': { school: '少林寺', performs: ['罗汉伏魔'] },
  '黄药师': { school: '桃花岛', performs: ['落英缤纷'] },
  '陆小凤': { school: '逍遥派', performs: ['灵犀一指'] },
  '西门吹雪': { school: '万梅山庄', performs: ['天外飞仙'] }
};

const ANSI = {
  reset: '\u001b[0m', red: '\u001b[31m', yellow: '\u001b[33m', magenta: '\u001b[35m', cyan: '\u001b[36m'
};

const mapFull = `
====================【江湖全图】====================
      【少林寺】←←←←←←  【华山派】
         |                      |
   【少林寺山路】          【华山山脚】
         |                      |
    【扬州郊外】----------【扬州城】←←→【凤栖城】
         |                    |
     【扬州城门】          【扬州码头】
                              |
                      【远洋客轮甲板】→【新港外湾】→【临海新港城】

指令: map 扬州 | map 少林 | map 华山 | map 出海 | map 凤栖  查看区域地图
`;

const mapYangzhou = `
====================【扬州城区域】(鹿鼎记)====================
                    【扬州郊外】
                        |
                    【扬州城门】
                        |
                   【扬州街北】
                    /       \
                 西/         \东
                  /           \
            【扬州小巷】      【客栈】
            /   |   \          |
         北/   南|   \东       |北
          /      |    \        |
      【药店】 【赌场】 【丽春院】 【练功房】
          |                       
          |东                     |下
          |                       |
                 【扬州街中】
                /         \
             西/           \东
              /             \
           【药店】         【武器铺】
                \           /
                 \         /
                  【扬州街南】
                 /         \
              西/           \东
               /             \
            【赌场】         【防具铺】
                  |
               【扬州码头】
                  |
                【运河】
                        |
                      【运河】

著名地点: 丽春院(韦小宝成长地)
`;

const mapHuashan = `
====================【华山派】(笑傲江湖)====================
                    【华山之巅】
                        |
                   【华山后山】
                        |
              【华山派大厅】←【思过崖】←【华山密道】
                        |
    【华山山门】←【华山别院】【华山弟子房】
著名地点: 思过崖(令狐冲面壁处)
`;

const mapShaolin = `
====================【少林寺】(倚天屠龙记)====================
                   【方丈室】
                        |
    【藏经阁】←→【少林寺大院】←→【罗汉堂】
                        |              |
                   【少林寺山门】  【少林武僧院】
著名地点: 藏经阁(扫地僧)
`;

const mapSea = `
====================【出海航线】====================
         【扬州码头】
              |
    【远洋客轮甲板】←→【客轮船舱】
              |
         【客轮船头】
              |
         【风暴海域】
              |
        【新港外湾】
              |
   【临海新港城·旧码头区】

提示: 输入 "出海" 从码头登船
`;

const mapCity = `
====================【临海新港城】(现代都市)====================
              【封锁港防区】
                   |
    【金融塔区】←【居住街区】
        |              |
 【旧码头区】←【中央科研区】←【粒子实验室】

区域介绍:
• 旧码头区: 黑市、线人
• 中央科研区: 天文台、粒子实验室
• 金融塔区: 资本势力
• 居住街区: 普通人视角
• 封锁港防区: 军事禁区
`;

const mapFengqi = `
====================【凤栖城】(陆小凤传奇)====================
              【听雨楼】
                   |
    【四海镖局】←【迎风客栈】→【六扇门分署】
                   |
              【凤栖城外门】
                   |
              【凤栖古道】
                   |
              【东郊驿道】
                   |
              【扬州街中】

区域介绍:
• 迎风客栈: 江湖中人落脚之处（中心枢纽）
• 听雨楼: 情报交易场所
• 四海镖局: 护镖任务
• 六扇门分署: 官府任务

前往方式: 扬州街中 -> 东 -> 凤栖城
`;

// 出身模板
const backgrounds = {
  '普通': { name: '普通人家', 根骨: 0, 悟性: 0, 经脉: 0, 福缘: 0 },
  '寒门': { name: '寒门之子', 根骨: 0, 悟性: 0, 经脉: 0, 福缘: 1 },
  '世家': { name: '武林世家', 根骨: 0, 悟性: 0, 经脉: 0, 福缘: 1 },
  '武学': { name: '武学渊源', 根骨: 1, 悟性: 0, 经脉: 0, 福缘: 0 },
  '书香': { name: '书香门第', 根骨: 0, 悟性: 1, 经脉: 0, 福缘: 0 },
};

function createPlayer(name) {
  // 先天资质 (1-10)
  const baseAttr = {
    根骨: 5 + Math.floor(Math.random() * 6),
    悟性: 5 + Math.floor(Math.random() * 6),
    经脉: 5 + Math.floor(Math.random() * 6),
    福缘: 5 + Math.floor(Math.random() * 6),
  };
  
  // 根据先天资质计算后天属性
  const maxHp = 100 + baseAttr.根骨 * 10;       // 根骨影响HP
  const maxMp = 50 + baseAttr.经脉 * 5;         // 经脉影响MP
  const atk = 10 + baseAttr.根骨 * 2;          // 根骨影响攻击
  const def = 5 + Math.floor(baseAttr.根骨 / 2); // 根骨影响防御
  const spd = 10 + baseAttr.悟性;               // 悟性影响身法
  
  // 衍生属性
  const 命中 = 80 + baseAttr.悟性 * 2;
  const 闪避 = 10 + Math.floor(baseAttr.经脉 / 2);
  const 暴击 = 5 + Math.floor(baseAttr.福缘 / 2);
  // 负重上限 = 50 + 根骨 * 10
  const maxWeight = 50 + baseAttr.根骨 * 10;
  
  return {
    name,
    room: '客栈',
    hp: maxHp, maxHp: maxHp,
    mp: maxMp, maxMp: maxMp,
    jingli: 100,
    maxJingli: 100,
    exp: 0, level: 1,
    pvpKills: 0,
    deaths: 0,
    coin: 500,  // 铜钱
    silver: 5,
    gold: 1,
    skills: JSON.parse(JSON.stringify(skills)),
    inventory: ['铜钱'],  // 初始携带铜钱
    maxWeight: maxWeight,  // 负重上限
    weapon: null, armor: null,
    title: '初入江湖',
    follows: [],
    master: null,
    school: null,
    // 任务系统
    quest: null,  // 当前任务
    questProgress: {},  // 任务进度
    hintCount: 0,  // 提示次数
    // 先天资质
    先天: { ...baseAttr },
    // 后天属性
    气血: maxHp,
    内力: maxMp,
    外功攻击: atk,
    内功攻击: 0,
    防御: def,
    身法: spd,
    // 衍生属性
    命中: 命中,
    闪避: 闪避,
    暴击: 暴击,
    // 声望
    门派声望: 0,
    正邪值: 0,
    following: null,
    vendetta: [],
    lastAttacker: null,
    // 晕倒状态
    fainted: false,
    faintTime: 0,
    dead: false,
    deadTime: 0,
    // 睡觉状态
    sleeping: false,
    sleepStartTime: 0,
    // 打坐状态
    meditating: false,
    meditationEndTime: 0,
    // 饮酒状态
    drunk: 0,
    lastDrinkAt: 0,
    lastDrinkDecayAt: 0,
    drinkBuffs: null,
    // 闭关状态
    retreating: false,
    retreatStartTime: 0,
    retreatDurationMs: 0,
    retreatRoom: null,
    // 扬州赌场掼蛋
    guandan: null,
    guandanStats: { wins: 0, games: 0, streak: 0, bestStreak: 0, profitCopper: 0 },
  };
}

const onlinePlayers = {};

const npcDrops = {};
const importantNpcNames = new Set(['老鸨', '情报贩子', '黄药师', '六扇门捕头']);
const npcPlayerState = {};
const npcMoodState = {};
const npcGreetingCooldown = {};

function getNpcMeta(name) {
  return npcCatalog[name] || { alias: name.toLowerCase().replace(/\s+/g, '_'), quote: '……', money: 0, loot: [], role: '江湖人物' };
}

function getMasterDisplayName(masterKey) {
  const aliasMap = {
    yuebuqun: '岳不群', fengqingyang: '风清扬', fangzhang: '方丈', xuanci: '玄慈', saodisen: '扫地僧',
    huangyaoshi: '黄药师', luxiaofeng: '陆小凤', ximenchuixue: '西门吹雪', yegucheng: '叶孤城'
  };
  return aliasMap[masterKey] || masterKey;
}

function isSameMaster(a, b) {
  if (!a || !b) return false;
  return a === b || getMasterDisplayName(a) === getMasterDisplayName(b);
}

function getMasterSkillCap(masterKey, skillName) {
  return Number(masterSkillLevels[masterKey]?.[skillName] || 0);
}

function getSkillLearnNeed(level) {
  const lv = Math.max(1, Number(level || 1));
  return Math.max(1, Math.floor(0.8 * lv * lv + 1.2 * lv));
}

function getManualSkillCap(skillName) {
  if (['基本内功', '基本拳法', '基本轻功', '罗汉拳', '太祖长拳', '伏虎拳', '学文识字'].includes(skillName)) return 12;
  return 8;
}

function getLearnableSkillsForMaster(masterKey) {
  const master = masters[masterKey];
  if (!master?.skill) return [];
  const list = [master.skill, '学文识字'];
  if (master.school === '华山派') list.push('基本内功', '基本拳法', '基本轻功');
  if (master.school === '少林寺') list.push('基本内功', '罗汉拳', '基本轻功');
  if (master.school === '武当派') list.push('基本内功', '太极拳', '基本轻功');
  if (master.school === '桃花岛') list.push('弹指神通', '玉箫剑法', '碧海潮生曲');
  if (master.school === '逍遥派') list.push('基本轻功');
  return [...new Set(list.filter(name => skillDb[name] || name === '学文识字'))];
}

function getManualLiteracyRequirement(itemName = '') {
  if (itemName.includes('残卷')) return 4;
  if (itemName.includes('羊皮卷')) return 6;
  if (itemName.includes('壁画')) return 8;
  if (itemName.includes('真经') || itemName.includes('秘籍')) return 10;
  return 0;
}

function getManualFragments(itemName = '') {
  const map = {
    '九阴真经残卷': { target: '九阴真经', needed: 3 },
    '九阳真经残卷': { target: '九阳神功', needed: 3 },
    '北冥残卷': { target: '北冥神功', needed: 2 },
    '落英残卷': { target: '落英神掌', needed: 2 }
  };
  return map[itemName] || null;
}

function rollReadingEvent(player, itemName) {
  const literacyLevel = getSkillLevel(player, '学文识字');
  const insightChance = Math.min(0.2, 0.04 + literacyLevel * 0.006);
  const misreadChance = Math.max(0.03, 0.12 - literacyLevel * 0.004);
  const roll = Math.random();
  if (roll < misreadChance) {
    return { type: 'misread', message: '你一时错会其意，反把几句关键处读得南辕北辙。' };
  }
  if (roll > 1 - insightChance) {
    return itemName.includes('残卷')
      ? { type: 'fragment', message: '你反复比对残缺字迹，竟隐约拼出了一条新的线索。' }
      : { type: 'insight', message: '你读到会心处，忽觉胸中一亮，对其中义理顿生明悟。' };
  }
  return null;
}

function hasManualForSkill(player, skillName, roomName) {
  const manuals = skillBooks[skillName] || [];
  if (manuals.some(item => player.inventory.includes(item))) return true;
  const room = getRoom(roomName);
  const text = `${room?.description || ''} ${(room?.npcs || []).join(' ')}`;
  return manuals.some(item => text.includes(item) || (item.includes('壁画') && text.includes('壁画')) || (item.includes('羊皮卷') && text.includes('羊皮卷')));
}

function getLearningSource(player, skillName, explicitTeacher) {
  const room = getRoom(player.room);
  const roomNpcs = room?.npcs || [];
  if (explicitTeacher) {
    if (!isSameMaster(explicitTeacher, player.master)) return null;
    const actualTeacher = (roomNpcs || []).find(npcName => isSameMaster(npcName, explicitTeacher));
    if (actualTeacher && masters[actualTeacher]) {
      const skills = getLearnableSkillsForMaster(actualTeacher);
      if (skills.includes(skillName)) return { type: 'master', teacher: actualTeacher };
    }
    return null;
  }

  if (player.master && roomNpcs.includes(player.master)) {
    const skills = getLearnableSkillsForMaster(player.master);
    if (skills.includes(skillName)) return { type: 'master', teacher: player.master };
  }

  if (hasManualForSkill(player, skillName, player.room)) {
    return { type: 'manual' };
  }
  return null;
}

function getDefaultLearningTeacher(player, skillName) {
  const room = getRoom(player.room);
  const roomNpcs = room?.npcs || [];
  if (player.master && roomNpcs.includes(player.master)) {
    const skills = getLearnableSkillsForMaster(player.master);
    if (skills.includes(skillName)) return player.master;
    return null;
  }
  for (const npcName of roomNpcs) {
    if (masters[npcName]) {
      const skills = getLearnableSkillsForMaster(npcName);
      if (skills.includes(skillName)) return npcName;
    }
  }
  return null;
}

function canLearnSkill(player, skillName, source) {
  if (!skillDb[skillName]) return '没有这门武功。';
  if ((player.jingli ?? 100) <= Math.max(10, Math.floor((player.maxJingli ?? 100) * 0.1))) {
    return '你已经昏昏沉沉，精力不足，无法继续学习武功。';
  }
  if (!source) {
    return '学习武功需要师父当面传授，或你手中有秘籍、书册、壁画、羊皮卷可供参悟。';
  }
  let needMaster = '';
  if (source.type === 'manual') {
    const manuals = skillBooks[skillName] || [];
    const matchedManual = manuals.find(item => player.inventory.includes(item) || (getRoom(player.room)?.description || '').includes(item));
    const literacyNeed = getManualLiteracyRequirement(matchedManual || '');
    const literacyLevel = getSkillLevel(player, '学文识字');
    if (literacyLevel < literacyNeed) {
      return `你翻看${matchedManual || '这份秘籍'}，只觉字迹艰深难辨。至少需要学文识字 ${literacyNeed} 级，方能参悟其中关窍。`;
    }
  }
  if (["易筋经", "北冥神功"].includes(skillName) && (!player.master || !["方丈", "玄慈", "扫地僧", "xuanci", "fangzhang", "saodisen"].includes(player.master))) {
    needMaster = '少林寺';
  } else if (["紫霞神功", "孤独九剑"].includes(skillName) && (!player.master || !["岳不群", "风清扬", "yuebuqun", "fengqingyang"].includes(player.master))) {
    needMaster = '华山派';
  }
  if (needMaster && source.type !== 'manual') {
    return `这是${needMaster}绝技，需要拜入${needMaster}门下，再由门中师长当面传授。`;
  }
  const current = player.skills[skillName] || { level: 0, exp: 0, learnProgress: 0 };
  const cap = source.type === 'master' ? getMasterSkillCap(source.teacher, skillName) : getManualSkillCap(skillName);
  if (cap <= 0) {
    return source.type === 'master' ? `【${getMasterDisplayName(source.teacher)}】不会这门武功。` : '你手中的秘籍残缺不全，学不了这门武功。';
  }
  if ((current.level || 0) >= cap) {
    return source.type === 'master'
      ? `你对【${skillName}】的理解已不在【${getMasterDisplayName(source.teacher)}】之下，无法再从他这里精进。`
      : `你手中这份关于【${skillName}】的秘籍，最多只能帮你参悟到 ${cap} 级。`;
  }
  return null;
}

function getLiteracyTeachingFlavor(teacher) {
  const map = {
    '岳不群': '岳不群提笔轻点，先教你辨章法，再教你从字里行间揣摩气度。',
    'yuebuqun': '岳不群提笔轻点，先教你辨章法，再教你从字里行间揣摩气度。',
    '风清扬': '风清扬嫌你拘泥笔画，只叫你先识剑意，再回头看书中文字。',
    'fengqingyang': '风清扬嫌你拘泥笔画，只叫你先识剑意，再回头看书中文字。',
    '方丈': '方丈取来旧经，叫你先静心识字，再从经义里明白持心之法。',
    'fangzhang': '方丈取来旧经，叫你先静心识字，再从经义里明白持心之法。',
    '玄慈': '玄慈语调平缓，一字一句领你辨认经卷中的古意。',
    'xuanci': '玄慈语调平缓，一字一句领你辨认经卷中的古意。',
    '黄药师': '黄药师随手写下几行奇字，要你自己拆解字形与机关。',
    'huangyaoshi': '黄药师随手写下几行奇字，要你自己拆解字形与机关。',
    '陆小凤': '陆小凤边笑边讲，竟把识字说得像在猜灯谜。',
    'luxiaofeng': '陆小凤边笑边讲，竟把识字说得像在猜灯谜。'
  };
  return map[teacher] || `在【${getMasterDisplayName(teacher)}】的指点下，你一点点摸清文字里的门道。`;
}

function applyLearnSkill(player, skillName, source) {
  if (!player.skills[skillName]) player.skills[skillName] = { level: 0, exp: 0, learnProgress: 0 };
  const skill = player.skills[skillName];
  const nextLevel = Math.max(1, (skill.level || 0) + 1);
  const need = getSkillLearnNeed(nextLevel);
  const literacyBonus = skillName === '学文识字' ? 1 : Math.floor(getSkillLevel(player, '学文识字') / 15);
  const gain = source.type === 'master' ? 1 + Math.max(0, Math.floor((player.先天?.悟性 || 5) / 8)) + literacyBonus : 1 + Math.max(0, literacyBonus - 1);
  const baseCost = 8 + Math.floor(nextLevel * 1.5) + (source.type === 'manual' ? 3 : 0);
  const cost = Math.max(8, Math.min(35, baseCost));
  player.jingli = Math.max(0, (player.jingli ?? 100) - cost);
  skill.learnProgress = Number(skill.learnProgress || 0) + gain;
  let upgraded = false;
  if (skill.learnProgress >= need) {
    skill.learnProgress = 0;
    skill.level = nextLevel;
    upgraded = true;
  }
  const sourceText = source.type === 'master'
    ? (skillName === '学文识字' ? getLiteracyTeachingFlavor(source.teacher) : `在【${getMasterDisplayName(source.teacher)}】的指点下`)
    : '对着秘籍苦苦参悟';
  const lowEnergy = player.jingli <= Math.max(10, Math.floor((player.maxJingli ?? 100) * 0.1));
  const progressText = upgraded
    ? `🔥 恭喜！你的【${skillName}】提升到了 ${skill.level} 级！`
    : `你对【${skillName}】又多了几分体悟（进度 ${skill.learnProgress}/${need}）。`;
  return `${sourceText}，${progressText}\n消耗精力 ${cost} 点，当前精力 ${player.jingli}/${player.maxJingli}.${lowEnergy ? '\n你只觉头昏眼花，短时间内已无法继续学习武功。' : ''}`;
}

function getRoomByNpcName(npcName) {
  for (const [roomName, room] of Object.entries(rooms)) {
    if ((room.npcs || []).includes(npcName)) return roomName;
  }
  return null;
}

function getNpcEntranceStyle(npcName, mode = 'arrival') {
  const meta = getNpcMeta(npcName);
  const role = meta.role || '江湖人物';
  if (npcName === '老鸨') return mode === 'arrival' ? '摇着手帕，笑吟吟地走了过来。' : '扭着腰肢，行色匆匆地离开了。';
  if (npcName === '情报贩子') return mode === 'arrival' ? '左右看了看，悄没声地凑了过来。' : '压低斗笠，快步离开了。';
  if (npcName === '黄药师') return mode === 'arrival' ? '拂袖而来，神情冷淡。' : '衣袖一振，飘然离去了。';
  if (npcName === '六扇门捕头') return mode === 'arrival' ? '步伐沉稳地走了过来。' : '神色肃然，快步离开了。';
  if (/掌柜|老板/.test(role)) return mode === 'arrival' ? '掸了掸衣袖，慢慢走了过来。' : '拨了拨算盘，转身离开了。';
  if (/老鸨|红倌/.test(role)) return mode === 'arrival' ? '带着脂粉香气走了过来。' : '裙裾轻摆，转身离开了。';
  if (/捕头|官兵|守卫|士兵/.test(role)) return mode === 'arrival' ? '脚步整齐地走了过来。' : '神色警惕地离开了。';
  if (/高手|掌门|宗师|岛主/.test(role)) return mode === 'arrival' ? '气定神闲地走了过来。' : '衣袂一闪，转眼便离开了。';
  if (/小贩|商贩|商人/.test(role)) return mode === 'arrival' ? '挑着担子走了过来。' : '收拢摊子，匆匆离开了。';
  return mode === 'arrival' ? '走了过来。' : '行色匆匆地离开了。';
}

function broadcastRoomDeparture(leaverName, roomName, type = 'player') {
  let leaveText = type === 'npc' ? `${leaverName}${getNpcEntranceStyle(leaverName, 'departure')}` : `${leaverName}行色匆匆地离开了。`;
  if (type === 'player') {
    const player = players[leaverName] || users[leaverName];
    const drunkStage = player ? getDrunkStage(player) : null;
    if (drunkStage?.key === 'wasted') leaveText = `${leaverName}扶着墙踉踉跄跄地离开了，留下一路淡淡酒气。`;
    else if (drunkStage?.key === 'drunk') leaveText = `${leaverName}脚下虚浮，摇摇晃晃地离开了。`;
    else if (drunkStage?.key === 'tipsy') leaveText = `${leaverName}带着几分酒意，慢悠悠地离开了。`;
  }
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name !== leaverName && players[name]?.room === roomName) {
      client.send(`${leaveText}\n>`);
    }
  }
}

function broadcastRoomArrivalNotice(arriverName, roomName, type = 'player') {
  const arriveText = type === 'npc' ? `${arriverName}${getNpcEntranceStyle(arriverName, 'arrival')}` : `${arriverName}走了过来。`;
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name !== arriverName && players[name]?.room === roomName) {
      client.send(`${arriveText}\n>`);
    }
  }
}

function moveNpcToRoom(npcName, targetRoomName) {
  const currentRoomName = getRoomByNpcName(npcName);
  if (currentRoomName) {
    broadcastRoomDeparture(npcName, currentRoomName, 'npc');
    rooms[currentRoomName].npcs = (rooms[currentRoomName].npcs || []).filter(name => name !== npcName);
  }
  if (rooms[targetRoomName]) {
    if (!rooms[targetRoomName].npcs.includes(npcName)) {
      rooms[targetRoomName].npcs.push(npcName);
      broadcastRoomArrivalNotice(npcName, targetRoomName, 'npc');
    }
    return true;
  }
  return false;
}

function maybeMoveSmartNpc(npcName) {
  const meta = getNpcMeta(npcName);
  const moveCfg = meta.llm?.movement;
  if (!moveCfg?.allowedRooms?.length) return;
  const chance = typeof moveCfg.idleMoveChance === 'number' ? moveCfg.idleMoveChance : 0;
  if (Math.random() > chance) return;
  const currentRoomName = getRoomByNpcName(npcName);
  const candidates = moveCfg.allowedRooms.filter(roomName => rooms[roomName] && roomName !== currentRoomName);
  if (!candidates.length) return;
  const targetRoomName = candidates[Math.floor(Math.random() * candidates.length)];
  moveNpcToRoom(npcName, targetRoomName);
}

function maybeTickSmartNpcs() {
  for (const npcName of Object.keys(npcCatalog)) {
    maybeMoveSmartNpc(npcName);
  }
}

function getNpcVendorText(npcMeta) {
  const items = npcMeta.vendor?.items || [];
  if (!items.length) return '';
  const lines = items.map(item => `- ${item.name}: ${item.price}${item.currency === 'gold' ? '金' : item.currency === 'silver' ? '银' : '铜钱'}，${item.desc}`);
  return `\n她手里常卖的东西有:\n${lines.join('\n')}`;
}

function getCurrencyLabel(currency) {
  return currency === 'gold' ? '金' : currency === 'silver' ? '银' : '铜钱';
}

function getNpcGoodsList(npcName) {
  const npcMeta = getNpcMeta(npcName);
  const items = npcMeta.vendor?.items || [];
  if (!items.length) return null;
  const body = items.map((item, index) => `${index + 1}. ${item.name} ${item.price}${getCurrencyLabel(item.currency)}，${item.desc}`).join('\n');
  return `【${npcName}】货单\n${body}\n输入 buy ${items[0].name} 购买`;
}

function findVendorForItem(player, itemName) {
  const room = getRoom(player.room);
  for (const npcName of room?.npcs || []) {
    const items = getNpcMeta(npcName).vendor?.items || [];
    const found = items.find(item => item.name === itemName);
    if (found) return { npcName, item: found };
  }
  return null;
}

function calcCurrentWeight(player) {
  let currentWeight = 0;
  player.inventory.forEach(item => {
    if (weapons[item] && weapons[item].weight) currentWeight += weapons[item].weight;
    else if (armors[item] && armors[item].weight) currentWeight += armors[item].weight;
  });
  if (player.weapon && weapons[player.weapon] && weapons[player.weapon].weight) currentWeight += weapons[player.weapon].weight;
  if (player.armor && armors[player.armor] && armors[player.armor].weight) currentWeight += armors[player.armor].weight;
  return currentWeight;
}

function canAffordNpcItem(player, item) {
  const currency = item.currency || 'coin';
  const price = item.price || 0;
  if (currency === 'gold') return player.gold >= price;
  if (currency === 'silver') return player.silver >= price;
  return player.coin >= price;
}

function chargeNpcItem(player, item) {
  const currency = item.currency || 'coin';
  const price = item.price || 0;
  if (currency === 'gold') player.gold -= price;
  else if (currency === 'silver') player.silver -= price;
  else player.coin -= price;
}

function getRumorText(npcName, topic = '扬州城近况') {
  if (npcName === '老鸨') {
    const pool = [
      `老鸨左右看了看，压低声音说道：「最近扬州码头来了几拨生面孔，嘴上说跑船，眼神却像是在找人。」`,
      `老鸨捻着手帕说道：「听说客栈里住进了个阔客，出手大方，可连名字都没人打听出来。」`,
      `老鸨轻哼一声说道：「六扇门这两天盯得紧，多半是城里又有大事。你若想听细的，得先让我见见诚意。」`
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (npcName === '情报贩子') {
    const pool = [
      '情报贩子把声音压得极低：「码头最近有批货不走官道，背后的人不简单。」',
      '情报贩子指尖轻敲桌面：「扬州主街上那几个生面孔，不像做买卖的，像是踩点的。」',
      '情报贩子冷笑一声：「你若真想知道谁在城里搅局，就别只盯着明面上的人。」'
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  if (npcName === '客栈老板') {
    return '客栈老板一边拨算盘一边说道：「最近住店的人杂得很，有人赶路，有人躲事，还有人专等夜里碰头。」';
  }
  if (npcName === '六扇门捕头') {
    return '六扇门捕头沉声说道：「城里最近并不太平。闲话少传，路上多看，保命要紧。」';
  }
  if (npcName === '镖头') {
    return '镖头压低嗓门说道：「东郊驿道最近风声紧，单人上路别太招摇，省得被人盯上。」';
  }
  const meta = getNpcMeta(npcName);
  return `${npcName}皱了皱眉，说道：「${topic}这事，我眼下只知道这么多。${meta.quote}」`;
}

function getNpcSpecialHelp(npcName) {
  const map = {
    '老鸨': ['list 老鸨', 'buy 女儿红', 'rumor 老鸨', 'inquire 老鸨 about 扬州城'],
    '客栈老板': ['list 客栈老板', 'buy 客房牌', 'rumor 客栈老板', 'inquire 客栈老板 about 住店'],
    '情报贩子': ['list 情报贩子', 'buy 扬州传闻', 'rumor 情报贩子', 'inquire 情报贩子 about 可疑人物'],
    '六扇门捕头': ['rumor 六扇门捕头', 'inquire 六扇门捕头 about 通缉', 'talk 六扇门捕头'],
    '镖头': ['list 镖头', 'buy 简易地图', 'rumor 镖头', 'inquire 镖头 about 东郊驿道']
  };
  return map[npcName] || [];
}

async function getNpcDialogue({ npcName, player, action, topic, userInput }) {
  const npcMeta = getNpcMeta(npcName);
  const roomName = getRoomByNpcName(npcName) || player.room;
  const room = getRoom(roomName) || { name: roomName, description: '' };
  const relation = getNpcPlayerState(npcName, player.name);
  const mood = touchNpcMood(npcName)?.mood || '平静';
  const attitudeLine = getNpcAttitudeLine(npcName, player);
  const generated = await chatWithNpc({
    npcMeta: {
      ...npcMeta,
      name: npcName,
      currentMood: mood,
      relation,
      attitudeLine,
      hiddenGoals: importantNpcNames.has(npcName)
        ? ['观察玩家是否可靠', '必要时只说半真半假的话', '尽量把玩家卷入自己的局']
        : []
    },
    room: { name: roomName, description: room.description || '' },
    playerName: player.name,
    action,
    topic,
    userInput,
  });
  if (generated) return generated;

  if (action === 'ask' && npcName === '老鸨') {
    if (player.questProgress?.laobaoMessageQuest?.stage === 'done') return '老鸨轻晃团扇，低笑道：「上回那桩递消息的事，你办得不坏。以后再有这种风声，我会先想起你。」';
    if (relation.favor >= 3) return `老鸨压低声音说道：「${topic}这事，我能多告诉你一句，不过你可别转头就把我卖了。」`;
    if (/秘密|把柄|黑市|码头|可疑/.test(topic)) return `老鸨眯起眼，压低声音说道：「${topic}这事啊，我倒是听过些风声。不过你若连茶水钱都不肯出，我最多只能说个半真半假。」`;
    return `老鸨眯起眼，压低声音说道：「${topic}这事啊，我这儿倒听过几耳朵。不过消息分轻重，茶水钱到了，我就多说两句。」`;
  }
  if (action === 'talk' && npcName === '老鸨') {
    return `老鸨满脸堆笑地说道：「客官来得巧，丽春院有酒有消息，想听热闹还是想做生意？银子到位，什么都好说。」${getNpcVendorText(npcMeta)}`;
  }
  if (action === 'talk' && npcName === '情报贩子') {
    return relation.trust >= 3 ? '情报贩子把声音压得极低：「你若还想听更深的，就得替我先办一件事。」' : '情报贩子冷笑一声：「消息我有，价钱也有，就看你买不买得起。便宜话我这里没有，假消息倒是看人送。」';
  }
  if (action === 'talk' && npcName === '黄药师') {
    return relation.favor >= 2 || (player.先天?.悟性 || 0) >= 8 ? '黄药师淡淡说道：「你若真有几分悟性，我倒不介意再听你多说两句。」' : '黄药师负手而立，冷冷道：「空口白话最是无趣，你若无真才实学，少来烦我。」';
  }
  if (action === 'talk' && npcName === '六扇门捕头') {
    if (player.questProgress?.dockCaseQuest?.stage === 'done') return '六扇门捕头点了点头：「上回码头那事，你做得还算稳当。以后若还有难办的案子，我会再找你。」';
    return relation.trust >= 2 ? '六扇门捕头沉声道：「你这人还算有点分寸。若肯帮我盯一盯码头那几个生面孔，城里的事我可以多告诉你一些。」' : '六扇门捕头目光沉稳：「若没正事，就别在公门口多转悠。」';
  }
  if (action === 'inquire' && npcName === '情报贩子') {
    if (relation.suspicion >= 2) return '情报贩子眯起眼道：「你问得太细了。再问下去，我就得怀疑你到底替谁做事。」';
    if (/黑市|码头|秘密|身份/.test(topic || '')) return '情报贩子轻轻一笑：「这话题值钱，我今天最多给你半句真话。真想知道全的，拿诚意来换。」';
  }
  if (action === 'inquire' && npcName === '六扇门捕头') {
    if (/通缉|可疑|案/.test(topic || '')) return relation.trust >= 2 ? '六扇门捕头压低声音道：「这案子我还在查，你若真想插手，就先替我盯紧扬州码头。」' : '六扇门捕头冷冷道：「案情未明，不该你知道的就别多问。」';
  }
  return `${attitudeLine ? `${attitudeLine} ` : ''}${npcMeta.quote}`;
}

function formatNpcName(name) {
  const meta = getNpcMeta(name);
  return `${name}（${meta.alias}）`;
}

function formatNpcList(names = []) {
  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const meta = getNpcMeta(name);
    const key = meta.alias || name;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique.map(name => formatNpcName(name)).join('、');
}

function resolveNpcName(input, room) {
  if (!input || !room) return null;
  for (const npcName of room.npcs || []) {
    const meta = getNpcMeta(npcName);
    if (input === npcName || input === meta.alias) return npcName;
  }
  return null;
}

function getRoomNpcDropKey(roomName, npcName) {
  return `${roomName}::${npcName}`;
}

function ensureNpcDrop(roomName, npcName) {
  const key = getRoomNpcDropKey(roomName, npcName);
  if (!npcDrops[key]) {
    const meta = getNpcMeta(npcName);
    npcDrops[key] = {
      money: meta.money || 0,
      items: [...(meta.loot || [])],
      taken: false,
    };
  }
  return npcDrops[key];
}

function getNpcPlayerState(npcName, playerName) {
  if (!npcPlayerState[npcName]) npcPlayerState[npcName] = {};
  if (!npcPlayerState[npcName][playerName]) {
    npcPlayerState[npcName][playerName] = {
      trust: 0,
      favor: 0,
      suspicion: 0,
      hostility: 0,
      owedFavor: 0,
      lastTopic: null,
      lastSeenAt: 0,
      lastAction: null
    };
  }
  return npcPlayerState[npcName][playerName];
}

function touchNpcMood(npcName) {
  if (!importantNpcNames.has(npcName)) return null;
  const now = Date.now();
  const current = npcMoodState[npcName];
  if (current && now - current.updatedAt < 20 * 60 * 1000) return current;
  const moods = ['热情', '戒备', '不耐烦', '试探', '有求于人'];
  const mood = moods[Math.floor(Math.random() * moods.length)];
  npcMoodState[npcName] = { mood, updatedAt: now };
  return npcMoodState[npcName];
}

function noteNpcInteraction(npcName, player, action, extra = {}) {
  if (!importantNpcNames.has(npcName)) return;
  const state = getNpcPlayerState(npcName, player.name);
  state.lastSeenAt = Date.now();
  state.lastAction = action;
  if (extra.topic) state.lastTopic = extra.topic;
  if (action === 'talk') state.favor += 1;
  if (action === 'ask') state.trust += 1;
  if (action === 'inquire') state.suspicion += extra.sensitive ? 1 : 0;
  if (action === 'fight') state.hostility += 3;
  if (action === 'gift') state.favor += 2;
}

function getNpcAttitudeLine(npcName, player) {
  if (!importantNpcNames.has(npcName)) return '';
  const state = getNpcPlayerState(npcName, player.name);
  const mood = touchNpcMood(npcName)?.mood || '平静';
  if (state.hostility >= 3) return `${npcName}看向你的眼神里带着毫不掩饰的敌意。`;
  if (state.suspicion >= 2) return `${npcName}语气平平，却明显还在提防你。`;
  if (state.favor >= 3 || state.trust >= 3) return `${npcName}见你来了，神色明显比待旁人亲近几分。`;
  if (mood === '不耐烦') return `${npcName}今天像是心气不顺，说话都短了几分。`;
  if (mood === '试探') return `${npcName}像是在掂量你的来路，话里总留着半截。`;
  if (mood === '有求于人') return `${npcName}似乎正有事压在心里，眼神时不时落在你身上。`;
  return '';
}

function shouldTriggerNpcGreeting(npcName, player, force = false) {
  const now = Date.now();
  if (!npcGreetingCooldown[player.name]) npcGreetingCooldown[player.name] = {};
  const last = npcGreetingCooldown[player.name][npcName] || 0;
  if (!force && now - last < 45 * 1000) return false;
  npcGreetingCooldown[player.name][npcName] = now;
  return true;
}

function collectNpcGreetingLines(player, roomName, options = {}) {
  const room = getRoom(roomName || player.room);
  if (!room) return [];
  const force = !!options.force;
  const lines = [];
  for (const npcName of room.npcs || []) {
    if (!importantNpcNames.has(npcName)) continue;
    if (!shouldTriggerNpcGreeting(npcName, player, force)) continue;
    const line = getNpcProactiveLine(npcName, player);
    if (line) lines.push(`【${npcName}】${line}`);
  }
  return lines;
}

function getNpcProactiveLine(npcName, player) {
  if (!importantNpcNames.has(npcName)) return '';
  const state = getNpcPlayerState(npcName, player.name);
  const mood = touchNpcMood(npcName)?.mood || '平静';
  const qp = player.questProgress || {};
  if (npcName === '老鸨') {
    if (qp.laobaoMessageQuest?.stage === 'started') return '老鸨眼波一转，轻声道：「你若真想知道谁在院里递消息，就别只会听，得学会看人。」';
    if (state.favor >= 3) return '老鸨笑着招手道：「熟客来了，今儿有两桩新鲜事，你若想听，我给你留一半真话。」';
    if (mood === '戒备') return '老鸨先四下看了看，这才压低声音道：「今儿风声紧，想听消息，先把手脚放干净些。」';
    return '老鸨甩了甩手帕，笑吟吟道：「客官，想听热闹，还是想买消息？」';
  }
  if (npcName === '情报贩子') {
    if (state.trust >= 3) return '情报贩子朝你勾了勾手指：「你来得巧，我手里有条消息，旁人我还不想卖。」';
    if (mood === '试探') return '情报贩子眯眼打量你：「消息有的是，就看你值不值得我开口。」';
    return '情报贩子指尖轻敲桌面：「过了今晚，有些消息可就不是这个价了。」';
  }
  if (npcName === '黄药师') {
    if (state.favor >= 2) return '黄药师冷冷看你一眼：「比上回强了点，至少没那么不堪入目。」';
    return '黄药师拂袖而立，淡淡道：「若无几分真本事，少来我面前空费口舌。」';
  }
  if (npcName === '六扇门捕头') {
    if (qp.dockCaseQuest?.stage === 'started') return '六扇门捕头压低声音道：「码头那几个人别惊动，先看他们都和谁接头。」';
    if (state.trust >= 2) return '六扇门捕头低声道：「你若有空，替我盯一盯最近在码头晃荡的那几个人。」';
    return '六扇门捕头目光一扫，沉声道：「城里近来不太平，若见着不对劲的人，记得来报。」';
  }
  return '';
}

function ensureMoneyState(player) {
  if (typeof player.coin !== 'number' || Number.isNaN(player.coin)) player.coin = 0;
  if (typeof player.silver !== 'number' || Number.isNaN(player.silver)) player.silver = 0;
  if (typeof player.gold !== 'number' || Number.isNaN(player.gold)) player.gold = 0;
  if (!player.guandan) player.guandan = null;
  if (!player.guandanStats) player.guandanStats = { wins: 0, games: 0, streak: 0, bestStreak: 0, profitCopper: 0 };
  if (typeof player.drunk !== 'number' || Number.isNaN(player.drunk)) player.drunk = 0;
  if (typeof player.lastDrinkAt !== 'number' || Number.isNaN(player.lastDrinkAt)) player.lastDrinkAt = 0;
  if (!player.drinkBuffs || typeof player.drinkBuffs !== 'object') player.drinkBuffs = null;
}

function decayDrunkValue(player, now = Date.now()) {
  const last = Number(player.lastDrinkDecayAt || now);
  const elapsed = Math.max(0, now - last);
  const decay = Math.floor(elapsed / 30000);
  if (decay > 0) {
    player.drunk = Math.max(0, Number(player.drunk || 0) - decay);
    player.lastDrinkDecayAt = last + decay * 30000;
  } else if (!player.lastDrinkDecayAt) {
    player.lastDrinkDecayAt = now;
  }
}

function getDrunkStage(player) {
  const drunk = Number(player.drunk || 0);
  if (drunk >= 100) return { key: 'passed_out', label: '烂醉', attackFactor: 0.8, hitDelta: -18, dodgeDelta: -18 };
  if (drunk >= 80) return { key: 'wasted', label: '烂醉', attackFactor: 0.88, hitDelta: -12, dodgeDelta: -12 };
  if (drunk >= 50) return { key: 'drunk', label: '大醉', attackFactor: 1.06, hitDelta: -8, dodgeDelta: -8 };
  if (drunk >= 20) return { key: 'tipsy', label: '醺然', attackFactor: 1.03, hitDelta: -3, dodgeDelta: -3 };
  if (drunk > 0) return { key: 'light', label: '微醺', attackFactor: 1, hitDelta: 0, dodgeDelta: 0 };
  return { key: 'sober', label: '清醒', attackFactor: 1, hitDelta: 0, dodgeDelta: 0 };
}

function getActiveDrinkBuff(player, now = Date.now()) {
  if (!player.drinkBuffs || Number(player.drinkBuffs.expiresAt || 0) <= now) {
    player.drinkBuffs = null;
    return null;
  }
  return player.drinkBuffs;
}

function broadcastRoomAction(actor, message) {
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name === actor.name) continue;
    if (players[name]?.room === actor.room) {
      client.send(`${message}\n>`);
    }
  }
}

function getDrinkWitnessText(player, drinkName, beforeStage, afterStage) {
  if (afterStage.key === 'passed_out') {
    return `${player.name}摇摇晃晃地从怀中摸出一只${drinkName}，仰头猛灌了几口，忽然脚下一软，眼前一黑，竟当场醉倒在地。周围众人见状，纷纷避开了几步。`;
  }
  if (afterStage.key === 'wasted') {
    return `${player.name}摇摇晃晃地从怀中摸出一只${drinkName}，仰头朝嘴里倒去。酒液顺着嘴角淌下，惹得旁人一阵诧异，忙不迭快步离开。`;
  }
  if (afterStage.key === 'drunk') {
    return `${player.name}提起${drinkName}咕咚灌下，脚步已显虚浮，眼神也有些发散。周围人互望一眼，只觉此人酒劲上头了。`;
  }
  if (afterStage.key === 'tipsy') {
    return `${player.name}随手拍开${drinkName}，仰头饮了几口，面上渐渐泛起酒意，说话声也比平时高了几分。`;
  }
  if (beforeStage.key === 'sober') {
    return `${player.name}从怀中摸出一只${drinkName}，仰头饮下，神情间多了几分暖意。`;
  }
  return `${player.name}又饮了一口${drinkName}，身上的酒气更重了。`;
}

function getDrunkNpcReaction(npcName, player) {
  const stage = getDrunkStage(player);
  if (stage.key === 'sober' || stage.key === 'light') return '';
  if (npcName === '店小二' || npcName === '客栈老板') {
    return stage.key === 'wasted'
      ? `${npcName}皱眉摆手道：「这位爷，您都快站不住了，还是先坐下醒醒酒吧。」`
      : `${npcName}看了你一眼，陪笑道：「客官酒兴不浅，可别喝得太急。」`;
  }
  if (npcName === '六扇门捕头' || npcName === '官兵') {
    return stage.key === 'wasted' || stage.key === 'drunk'
      ? `${npcName}眉头一皱，沉声道：「城中不许借酒滋事，自己当心点。」`
      : `${npcName}瞥了你一眼，道：「少饮几杯，免得惹事。」`;
  }
  if (npcName === '岳不群' || npcName === '方丈' || npcName === '玄慈' || npcName === '张三丰') {
    return `${npcName}轻轻摇头道：「酒能乱性，修行之人当知节制。」`;
  }
  if (npcName === '陆小凤') {
    return `${npcName}眨了眨眼，笑道：「喝酒本是快事，可别先把自己喝趴下了。」`;
  }
  if (npcName === '老鸨') {
    return `${npcName}掩口笑道：「这位爷好大的酒兴，可别一会儿连路都找不着啦。」`;
  }
  return '';
}

function maybeBroadcastDrunkNpcReaction(player) {
  const room = getRoom(player.room);
  const stage = getDrunkStage(player);
  if (!room || (stage.key !== 'tipsy' && stage.key !== 'drunk' && stage.key !== 'wasted')) return;
  const npcName = (room.npcs || []).find(name => getDrunkNpcReaction(name, player));
  if (!npcName) return;
  const reaction = getDrunkNpcReaction(npcName, player);
  if (reaction) broadcastRoomAction(player, reaction);
}

function getDrinkEasterEgg(npcName, drinkName) {
  if (npcName === '陆小凤' && ['女儿红', '烧刀子', '猴儿酒'].includes(drinkName)) {
    return '陆小凤挑眉一笑：「酒倒是好酒，喝归喝，可别误了出手时机。」';
  }
  if (npcName === '黄药师' && drinkName === '猴儿酒') {
    return '黄药师鼻尖微动，淡淡道：「这酒倒还有点山野灵气，没算糟蹋。」';
  }
  if ((npcName === '客栈老板' || npcName === '店小二') && ['米酒', '女儿红', '汾酒'].includes(drinkName)) {
    return `${npcName}笑着招呼道：「这酒配两碟小菜才更对味。」`;
  }
  if (npcName === '老鸨' && drinkName === '女儿红') {
    return '老鸨掩口笑道：「这坛可是院里留的好货，客官倒识货。」';
  }
  return '';
}

function maybeBroadcastDrinkEasterEgg(player, drinkName) {
  const room = getRoom(player.room);
  if (!room) return;
  const npcName = (room.npcs || []).find(name => getDrinkEasterEgg(name, drinkName));
  if (!npcName) return;
  const text = getDrinkEasterEgg(npcName, drinkName);
  if (text) broadcastRoomAction(player, text);
}

function handleSharedDrink(player, targetName) {
  const roomPlayers = Object.values(players).filter(p => p.room === player.room && p.name !== player.name);
  const target = roomPlayers.find(p => p.name === targetName);
  if (!target) return 'NO_TARGET';
  if (player.coin < 20) return 'NO_MONEY';
  player.coin -= 20;
  target.jingli = Math.min(target.maxJingli ?? 100, (target.jingli ?? 100) + 8);
  target.drunk = Math.min(120, Number(target.drunk || 0) + 4);
  target.lastDrinkDecayAt = Date.now();
  recalculateDerivedStats(target);
  broadcastRoomAction(player, `${player.name}招呼店家温了一壶酒，笑着请${target.name}同桌共饮。酒香四散，周围几人都忍不住多看了两眼。`);
  if (onlinePlayers[target.name]) {
    onlinePlayers[target.name].send(`【共饮】${player.name}请你喝了一轮酒。你抿了几口，只觉胸口微暖，酒意略起。\n>`);
  }
  return 'OK';
}

function getDrunkMovementFumble(player) {
  const stage = getDrunkStage(player);
  if (stage.key === 'wasted' && Math.random() < 0.4) {
    return '你脚下发飘，刚迈出半步就撞在门框边上，只得扶墙缓了缓，没能走出去。';
  }
  if (stage.key === 'drunk' && Math.random() < 0.22) {
    return '你眼前景物微微摇晃，脚步一乱，险些摔个跟头，只好先稳住身形。';
  }
  return '';
}

function getPassOutWitnessText(player) {
  return `${player.name}眼神一散，身子晃了两晃，随即扑通一声醉倒在地，半晌再无动静。`;
}

function getDrunkSpeechPrefix(player) {
  const stage = getDrunkStage(player);
  if (stage.key === 'wasted') return '你舌头都有些打卷，含含糊糊地';
  if (stage.key === 'drunk') return '你带着浓浓酒意，声音发飘地';
  if (stage.key === 'tipsy') return '你面带酒红，笑着';
  return '你';
}

function transformDrunkSpeech(player, text) {
  const msg = (text || '').trim();
  if (!msg) return msg;
  const stage = getDrunkStage(player);
  if (stage.key === 'wasted') {
    return msg
      .replace(/你/g, '泥')
      .replace(/我/g, '窝')
      .replace(/不/g, '唔') + '……';
  }
  if (stage.key === 'drunk') {
    return `${msg}${/[。！？!?~]$/.test(msg) ? '' : '……'}`;
  }
  if (stage.key === 'tipsy') {
    return `${msg} 哈。`;
  }
  return msg;
}

function broadcastRoomSpeech(player, prefix, content) {
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name === player.name) continue;
    if (players[name]?.room === player.room) {
      client.send(`${prefix}${player.name}: ${content}\n>`);
    }
  }
}

function getDrunkWakeEffect(player) {
  const stage = getDrunkStage(player);
  if (stage.key === 'sober') return null;
  const before = Number(player.drunk || 0);
  const reduced = stage.key === 'wasted' ? Math.max(0, before - 35) : stage.key === 'drunk' ? Math.max(0, before - 24) : Math.max(0, before - 16);
  player.drunk = reduced;
  player.lastDrinkDecayAt = Date.now();
  player.jingli = Math.min(player.maxJingli ?? 100, Math.max(0, (player.jingli ?? 100) + (stage.key === 'wasted' ? -8 : -3)));
  player.mp = Math.max(0, player.mp - (stage.key === 'wasted' ? 6 : 2));
  if (stage.key === 'wasted') return '你宿醉未醒，口干舌苦，太阳穴突突直跳。';
  if (stage.key === 'drunk') return '你揉了揉额角，只觉酒气散了些，人也清醒不少。';
  return '你打了个呵欠，胸口那点酒意也淡了下去。';
}

function getMoneySummary(player) {
  ensureMoneyState(player);
  return `铜钱:${player.coin} 银:${player.silver} 金:${player.gold}`;
}

function canAffordStake(player, currency, amount) {
  ensureMoneyState(player);
  if (currency === '铜') return player.coin >= amount;
  if (currency === '银') return player.silver >= amount;
  if (currency === '金') return player.gold >= amount;
  return false;
}

function spendStake(player, currency, amount) {
  if (!canAffordStake(player, currency, amount)) return false;
  if (currency === '铜') player.coin -= amount;
  if (currency === '银') player.silver -= amount;
  if (currency === '金') player.gold -= amount;
  return true;
}

function addStake(player, currency, amount) {
  ensureMoneyState(player);
  if (currency === '铜') player.coin += amount;
  if (currency === '银') player.silver += amount;
  if (currency === '金') player.gold += amount;
}

function getGuandanTierInfo(currency) {
  if (currency === '铜') return { min: 100, max: 1000, feePercent: 5, label: '铜钱小桌', difficulty: '普通' };
  if (currency === '银') return { min: 1, max: 20, feePercent: 8, label: '银两中桌', difficulty: '进阶' };
  if (currency === '金') return { min: 1, max: 5, feePercent: 10, label: '黄金大桌', difficulty: '高手' };
  return null;
}

function toCopperValue(currency, amount) {
  if (currency === '铜') return amount;
  if (currency === '银') return amount * 100;
  if (currency === '金') return amount * 10000;
  return 0;
}

function updateGuandanStats(player, game, pos, gross) {
  ensureMoneyState(player);
  player.guandanStats.games += 1;
  player.guandanStats.profitCopper += toCopperValue(game.currency, gross);
  if (pos === 1) {
    player.guandanStats.wins += 1;
    player.guandanStats.streak += 1;
    player.guandanStats.bestStreak = Math.max(player.guandanStats.bestStreak, player.guandanStats.streak);
  } else {
    player.guandanStats.streak = 0;
  }
}

function getStreakReward(player, currency) {
  const streak = player.guandanStats?.streak || 0;
  if (streak === 3) return { currency, amount: 1, text: '连胜三场，荷官赏你一手彩头。' };
  if (streak === 5) return { currency, amount: 2, text: '连胜五场，赌场掌柜亲自加码。' };
  if (streak === 10) return { currency, amount: 5, text: '连胜十场，满堂喝彩，彩金翻涌而来。' };
  return null;
}

function createDeck() {
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const deck = [];
  for (let copy = 0; copy < 2; copy++) {
    for (const rank of ranks) {
      for (let i = 0; i < 4; i++) deck.push(rank);
    }
    deck.push('SJ');
    deck.push('BJ');
  }
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const GUANDAN_RANK_VALUE = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14, SJ: 16, BJ: 17 };

function sortCards(cards) {
  return [...cards].sort((a, b) => GUANDAN_RANK_VALUE[a] - GUANDAN_RANK_VALUE[b]);
}

function getCounts(cards) {
  const map = {};
  for (const c of cards) map[c] = (map[c] || 0) + 1;
  return map;
}

function parsePlay(cards) {
  if (!cards || !cards.length) return null;
  const sorted = sortCards(cards);
  const counts = getCounts(sorted);
  const ranks = Object.keys(counts).sort((a, b) => GUANDAN_RANK_VALUE[a] - GUANDAN_RANK_VALUE[b]);
  const len = sorted.length;
  if (len === 1) return { type: 'single', value: GUANDAN_RANK_VALUE[sorted[0]], cards: sorted, label: sorted[0] };
  if (len === 2 && ranks.length === 1) return { type: 'pair', value: GUANDAN_RANK_VALUE[ranks[0]], cards: sorted, label: `${ranks[0]}${ranks[0]}` };
  if (len === 2 && counts.SJ === 1 && counts.BJ === 1) return { type: 'jokerbomb', value: 999, cards: sorted, label: '王炸' };
  if (len === 3 && ranks.length === 1) return { type: 'triple', value: GUANDAN_RANK_VALUE[ranks[0]], cards: sorted, label: `${ranks[0]}×3` };
  if (len === 4 && ranks.length === 1) return { type: 'bomb', value: GUANDAN_RANK_VALUE[ranks[0]], size: 4, cards: sorted, label: `${ranks[0]}炸弹` };
  if (len === 5 && ranks.length === 2) {
    const tripleRank = ranks.find(r => counts[r] === 3);
    const pairRank = ranks.find(r => counts[r] === 2);
    if (tripleRank && pairRank) return { type: 'fullhouse', value: GUANDAN_RANK_VALUE[tripleRank], cards: sorted, label: `${tripleRank}三带二` };
  }
  return null;
}

function canBeat(play, current) {
  if (!current) return true;
  if (!play) return false;
  if (play.type === 'jokerbomb') return true;
  if (current.type === 'jokerbomb') return false;
  if (play.type === 'bomb' && current.type !== 'bomb') return true;
  if (play.type === 'bomb' && current.type === 'bomb') {
    if ((play.size || 4) !== (current.size || 4)) return (play.size || 4) > (current.size || 4);
    return play.value > current.value;
  }
  if (current.type === 'bomb') return false;
  if (play.type !== current.type) return false;
  return play.cards.length === current.cards.length && play.value > current.value;
}

function removeCardsFromHand(hand, cards) {
  const next = [...hand];
  for (const card of cards) {
    const idx = next.indexOf(card);
    if (idx === -1) return null;
    next.splice(idx, 1);
  }
  return next;
}

function enumeratePlayableHands(hand) {
  const cards = sortCards(hand);
  const counts = getCounts(cards);
  const plays = [];
  const uniq = Object.keys(counts).sort((a, b) => GUANDAN_RANK_VALUE[a] - GUANDAN_RANK_VALUE[b]);
  for (const rank of uniq) plays.push(parsePlay([rank]));
  for (const rank of uniq) if (counts[rank] >= 2) plays.push(parsePlay([rank, rank]));
  for (const rank of uniq) if (counts[rank] >= 3) plays.push(parsePlay([rank, rank, rank]));
  for (const rank of uniq) if (counts[rank] >= 4) plays.push(parsePlay([rank, rank, rank, rank]));
  for (const triple of uniq.filter(r => counts[r] >= 3)) {
    for (const pair of uniq.filter(r => r !== triple && counts[r] >= 2)) {
      plays.push(parsePlay([triple, triple, triple, pair, pair]));
    }
  }
  if (counts.SJ && counts.BJ) plays.push(parsePlay(['SJ', 'BJ']));
  const dedup = new Map();
  for (const p of plays) if (p) dedup.set(`${p.type}:${p.label}`, p);
  return [...dedup.values()].sort((a, b) => {
    const order = { single: 1, pair: 2, triple: 3, fullhouse: 4, bomb: 5, jokerbomb: 6 };
    if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type];
    return a.value - b.value;
  });
}

function formatPlay(play) {
  if (!play) return '无';
  const labels = { single: '单牌', pair: '对子', triple: '三张', fullhouse: '三带二', bomb: '炸弹', jokerbomb: '王炸' };
  return `${labels[play.type] || play.type}:${play.label}`;
}

function buildGuandanState(player, currency, stake) {
  const deck = shuffle(createDeck());
  const tier = getGuandanTierInfo(currency);
  const seats = [player.name, '牌桌老李', '牌桌老周', '牌桌老孙'];
  let aiProfiles = {
    '牌桌老李': '保守',
    '牌桌老周': '激进',
    '牌桌老孙': '均衡'
  };
  if (tier.difficulty === '进阶') aiProfiles = { '牌桌老李': '控牌', '牌桌老周': '激进', '牌桌老孙': '均衡' };
  if (tier.difficulty === '高手') aiProfiles = { '牌桌老李': '控牌', '牌桌老周': '炸弹流', '牌桌老孙': '均衡' };
  const hands = {};
  for (const seat of seats) hands[seat] = sortCards(deck.splice(0, 27));
  return {
    currency,
    stake,
    pot: stake * 4,
    feePercent: tier.feePercent,
    difficulty: tier.difficulty,
    seats,
    hands,
    turnIndex: 0,
    currentPlay: null,
    currentOwner: null,
    passCount: 0,
    ranking: [],
    options: [],
    aiProfiles,
    status: 'playing'
  };
}

function getPlayerGuandanOptions(game, playerName) {
  const all = enumeratePlayableHands(game.hands[playerName] || []);
  return all.filter(p => canBeat(p, game.currentPlay)).slice(0, 12);
}

function renderGuandanTable(game, playerName) {
  const hand = sortCards(game.hands[playerName] || []);
  const options = getPlayerGuandanOptions(game, playerName);
  game.options = options;
  let msg = `\n【扬州赌场·简化掼蛋】\n桌级:${getGuandanTierInfo(game.currency).label} (${game.difficulty}) 底注:${game.stake}${game.currency}\n奖池:${game.pot}${game.currency} 抽水:${game.feePercent}%\n当前牌面:${formatPlay(game.currentPlay)}\n\n`;
  msg += `名次:${game.ranking.length ? game.ranking.join(' -> ') : '尚未决出'}\n`;
  msg += `\n【你的手牌】\n${hand.join(' ')}\n`;
  msg += `\n【桌上余牌】\n`;
  for (const seat of game.seats) {
    msg += `${seat}: ${game.hands[seat].length}张`;
    if (game.aiProfiles && game.aiProfiles[seat]) msg += ` (${game.aiProfiles[seat]})`;
    if (game.ranking.includes(seat)) msg += ' (已出完)';
    if (seat === game.seats[game.turnIndex]) msg += ' ← 当前行动';
    msg += '\n';
  }
  msg += `\n【可出选项】\n`;
  if (!options.length) msg += '无可压牌，请输入 guandan pass\n';
  else options.forEach((p, i) => { msg += `${i + 1}. ${formatPlay(p)} [play:${i + 1}]\n`; });
  msg += '\n指令: guandan play 序号 | guandan pass | guandan hand | guandan quit\n>';
  return msg;
}

function maybeFinishGuandanRound(player, game) {
  if (game.ranking.length >= 4 || game.ranking.length >= game.seats.length - 1) {
    for (const seat of game.seats) {
      if (!game.ranking.includes(seat)) game.ranking.push(seat);
    }
    const pos = game.ranking.indexOf(player.name) + 1;
    const multipliers = [3, 1, -1, -3];
    const gross = multipliers[pos - 1] * game.stake;
    let msg = `【本局结算】\n名次: ${game.ranking.join(' -> ')}\n你的名次: 第${pos}名\n`;
    if (gross > 0) {
      const fee = Math.floor(gross * game.feePercent / 100);
      const net = Math.max(0, gross - fee);
      addStake(player, game.currency, game.stake + net);
      msg += `赢得: +${gross}${game.currency}，抽水:${fee}${game.currency}，实际到账:${game.stake + net}${game.currency}(含返还底注)\n`;
    } else if (gross === 0) {
      addStake(player, game.currency, game.stake);
      msg += `平局退还底注:${game.stake}${game.currency}\n`;
    } else {
      msg += `本局失利，已扣除底注:${game.stake}${game.currency}\n`;
    }
    updateGuandanStats(player, game, pos, gross);
    const reward = pos === 1 ? getStreakReward(player, game.currency) : null;
    if (reward) {
      addStake(player, reward.currency, reward.amount);
      msg += `${reward.text} 额外奖励:${reward.amount}${reward.currency}\n`;
    }
    msg += `掼蛋战绩: ${player.guandanStats.wins}胜/${player.guandanStats.games}局，当前连胜:${player.guandanStats.streak}，最佳连胜:${player.guandanStats.bestStreak}\n`;
    msg += `当前资产: ${getMoneySummary(player)}\n>`;
    player.guandan = null;
    return msg;
  }
  return null;
}

function advanceGuandan(game, player) {
  const actorName = player.name;
  let log = '';
  while (game.status === 'playing' && game.seats[game.turnIndex] !== actorName) {
    const seat = game.seats[game.turnIndex];
    if (game.ranking.length >= game.seats.length - 1) {
      const finishMsg = maybeFinishGuandanRound(player, game);
      if (finishMsg) return log + finishMsg;
    }
    if (game.ranking.includes(seat)) {
      game.turnIndex = (game.turnIndex + 1) % game.seats.length;
      continue;
    }
    const options = enumeratePlayableHands(game.hands[seat]).filter(p => canBeat(p, game.currentPlay));
    const profile = (game.aiProfiles && game.aiProfiles[seat]) || '均衡';
    let selected = null;
    if (!game.currentPlay) {
      if (profile === '激进') selected = options[0] || null;
      else if (profile === '保守' || profile === '控牌') selected = options.find(p => p.type !== 'bomb' && p.type !== 'jokerbomb') || options[0] || null;
      else selected = options.find(p => p.type === 'pair' || p.type === 'triple') || options[0] || null;
    } else {
      const sameType = options.filter(p => p.type === game.currentPlay.type && p.cards.length === game.currentPlay.cards.length);
      if (profile === '激进' || profile === '炸弹流') selected = sameType[0] || options.find(p => p.type === 'bomb' || p.type === 'jokerbomb') || null;
      else if (profile === '保守' || profile === '控牌') selected = sameType[0] || null;
      else selected = sameType[0] || options.find(p => p.type === 'bomb' || p.type === 'jokerbomb') || null;
    }
    if (!selected) {
      game.passCount += 1;
      log += `${seat} 摇了摇头，选择不要。\n`;
    } else {
      game.hands[seat] = removeCardsFromHand(game.hands[seat], selected.cards);
      game.currentPlay = selected;
      game.currentOwner = seat;
      game.passCount = 0;
      log += `${seat} 打出 ${formatPlay(selected)}。\n`;
      if (game.hands[seat].length === 0 && !game.ranking.includes(seat)) {
        game.ranking.push(seat);
        log += `🎉 ${seat} 率先出完了手牌。\n`;
      }
    }
    if (game.passCount >= 2 && game.currentOwner) {
      log += `一轮压制结束，由 ${game.currentOwner} 重新领牌。\n`;
      game.turnIndex = game.seats.indexOf(game.currentOwner);
      game.currentPlay = null;
      game.currentOwner = null;
      game.passCount = 0;
    } else {
      game.turnIndex = (game.turnIndex + 1) % game.seats.length;
    }
    while (game.ranking.includes(game.seats[game.turnIndex]) && game.ranking.length < 4) {
      game.turnIndex = (game.turnIndex + 1) % game.seats.length;
    }
    for (const seatName of game.seats) {
      if (!game.ranking.includes(seatName) && game.hands[seatName].length === 0) game.ranking.push(seatName);
    }
    const finishMsg = maybeFinishGuandanRound(player, game);
    if (finishMsg) return log + finishMsg;
  }
  return log + renderGuandanTable(game, actorName);
}

function getRoom(roomName) {
  return rooms[roomName] || null;
}

function getTitle(exp) {
  for (let i = titles.length - 1; i >= 0; i--) {
    if (exp >= titles[i].exp) return titles[i].title;
  }
  return titles[0].title;
}

// 生成玩家HP状态描述
function getHpStatus(hp, maxHp) {
  const percent = Math.round((hp / maxHp) * 100);
  if (percent >= 80) return "神采奕奕";
  if (percent >= 60) return "气定神闲";
  if (percent >= 40) return "略显疲惫";
  if (percent >= 20) return "无精打采";
  if (percent >= 10) return "摇摇欲坠";
  return "奄奄一息";
}

function getArrivalPrefix(hp, maxHp) {
  const percent = Math.round((hp / maxHp) * 100);
  if (percent >= 80) return '';
  if (percent >= 60) return '气息稍乱地';
  if (percent >= 40) return '略显疲惫地';
  if (percent >= 20) return '脚步虚浮地';
  if (percent >= 10) return '摇摇欲坠地';
  return '奄奄一息地艰难';
}

function formatArrival(name, hp, maxHp) {
  const prefix = getArrivalPrefix(hp, maxHp);
  return prefix ? `${name}${prefix}走了过来` : `${name}走了过来`;
}

function getSkillLevel(player, skillName) {
  return Number(player.skills?.[skillName]?.level || 0);
}

function getInnerSkillLevels(player) {
  return {
    '基本内功': getSkillLevel(player, '基本内功'),
    '九阳神功': getSkillLevel(player, '九阳神功'),
    '九阴真经': getSkillLevel(player, '九阴真经'),
    '北冥神功': getSkillLevel(player, '北冥神功'),
    '紫霞神功': getSkillLevel(player, '紫霞神功'),
    '易筋经': getSkillLevel(player, '易筋经')
  };
}

function getNeigongConflictPenalty(player) {
  const levels = getInnerSkillLevels(player);
  const advanced = Object.entries(levels)
    .filter(([name, level]) => name !== '基本内功' && level > 0)
    .sort((a, b) => b[1] - a[1]);
  if (advanced.length <= 1) {
    return { percent: 0, desc: '内息纯一，运行圆融。' };
  }
  const topLevel = advanced[0][1];
  const conflictingCount = advanced.filter(([, level]) => level >= Math.max(1, topLevel - 3)).length;
  const percent = Math.min(28, (conflictingCount - 1) * 8 + Math.max(0, advanced.length - 2) * 4);
  const names = advanced.map(([name]) => name).join('、');
  return {
    percent,
    desc: `所修内功 ${names} 气机互有掣肘。`
  };
}

function getCultivationRealm(player) {
  const neigongLevel = getNeigongLevel(player);
  if (neigongLevel >= 36) return '宗师';
  if (neigongLevel >= 28) return '圆满';
  if (neigongLevel >= 20) return '大成';
  if (neigongLevel >= 12) return '小成';
  if (neigongLevel >= 6) return '入门';
  return '初窥';
}

function getRealmBreakthroughRequirement(player) {
  const neigongLevel = getNeigongLevel(player);
  if (neigongLevel < 12) return null;
  if (neigongLevel < 20) return { realm: '小成', minExp: 120, minMastery: 12 };
  if (neigongLevel < 28) return { realm: '大成', minExp: 300, minMastery: 20 };
  if (neigongLevel < 36) return { realm: '圆满', minExp: 700, minMastery: 28 };
  return { realm: '宗师', minExp: 1500, minMastery: 36 };
}

function canBreakthroughRealm(player) {
  const req = getRealmBreakthroughRequirement(player);
  if (!req) return { ok: true, req: null };
  const primaryInnerSkill = getPrimaryInnerSkill(player);
  let requiredRoom = null;
  if (req.realm === '小成') requiredRoom = '练功房';
  if (req.realm === '大成') requiredRoom = player.school === '华山派' ? '思过崖' : player.school === '少林寺' ? '方丈室' : '练功房';
  if (req.realm === '圆满') requiredRoom = player.school === '华山派' ? '华山练功房' : player.school === '少林寺' ? '少林练功房' : '思过崖';
  if (req.realm === '宗师') requiredRoom = player.school === '少林寺' ? '藏经阁' : player.school === '华山派' ? '思过崖' : '方丈室';
  const ok = player.exp >= req.minExp && primaryInnerSkill.level >= req.minMastery && (!requiredRoom || player.room === requiredRoom);
  return { ok, req: { ...req, requiredRoom }, primaryInnerSkill };
}

function getNeigongLevel(player) {
  const levels = Object.values(getInnerSkillLevels(player));
  return levels.length ? Math.max(...levels) : 1;
}

function getWugongLevel(player) {
  const offensiveLevels = Object.entries(player.skills || {})
    .filter(([name]) => skillDb[name]?.type === '主动' || name === '基本拳法')
    .map(([, sk]) => Number(sk.level || 0));
  return offensiveLevels.length ? Math.max(...offensiveLevels) : 1;
}

function getMeditationBonusCap(player) {
  const baseInnerSkillLevel = getSkillLevel(player, '基本内功');
  return Math.max(0, Math.floor(baseInnerSkillLevel * 12 + Math.pow(baseInnerSkillLevel, 1.12) * 2));
}

function getMeditationBonuses(player) {
  return {
    maxMpBonus: Math.max(0, Number(player.maxMpBonus || 0)),
    maxHpBonus: Math.max(0, Number(player.maxHpBonus || 0))
  };
}

function getMeditationProgress(player) {
  const cap = getMeditationBonusCap(player);
  const bonuses = getMeditationBonuses(player);
  const ratio = cap > 0 ? Math.min(1, bonuses.maxMpBonus / cap) : 0;
  return {
    cap,
    maxMpBonus: bonuses.maxMpBonus,
    maxHpBonus: bonuses.maxHpBonus,
    ratio,
    percent: Math.round(ratio * 100)
  };
}

function getPrimaryInnerSkill(player) {
  const innerSkills = ['九阳神功', '九阴真经', '北冥神功', '紫霞神功', '易筋经', '基本内功'];
  let best = '基本内功';
  let bestLevel = 0;
  for (const skillName of innerSkills) {
    const level = getSkillLevel(player, skillName);
    if (level > bestLevel) {
      best = skillName;
      bestLevel = level;
    }
  }
  return { name: best, level: bestLevel };
}

function getMeditationRoomFlavor(roomName, innerSkillName = '基本内功') {
  const roomFlavors = {
    '练功房': [
      '石室寂静，只闻自己呼吸渐渐绵长。',
      '石壁微凉，你盘膝而坐，气息缓缓沉入丹田。',
      '客栈后院偶有风过竹梢，更衬得石室幽静。'
    ],
    '华山练功房': [
      '窗外山风猎猎，华山剑意仿佛也随呼吸一并沉浮。',
      '你凝神调息，耳畔似有松涛，与内息往复相合。',
      '山中清气入怀，胸中杂念被一点点洗去。'
    ],
    '少林练功房': [
      '金砖微温，檀香若有若无，呼吸间自生庄严之意。',
      '你抱元守一，仿佛远处晨钟余韵仍在心头回荡。',
      '四下空明，只有一缕禅意随周天运转而愈发清晰。'
    ]
  };
  const skillFlavors = {
    '紫霞神功': '一缕紫气自胸臆间浮沉往复，气机显得格外清灵。',
    '易筋经': '筋骨在呼吸吐纳间微微震鸣，周身气血渐渐圆融。',
    '北冥神功': '丹田深处仿佛生出一泓深潭，四散真气缓缓归流。',
    '九阳神功': '体内暖意层层翻涌，经脉像被烈阳一点点照亮。',
    '九阴真经': '一股清冷真息贴着经脉游走，杂火与躁意渐渐熄去。',
    '基本内功': '你循着最朴实的吐纳法门，一点点稳住内息根基。'
  };
  const roomPool = roomFlavors[roomName] || ['你屏息凝神，缓缓运转周天。'];
  return `${roomPool[Math.floor(Math.random() * roomPool.length)]}\n${skillFlavors[innerSkillName] || skillFlavors['基本内功']}`;
}

function rollMeditationEvent(player, hpCost, innerSkillName) {
  const progress = getMeditationProgress(player);
  const hpRatio = player.maxHp > 0 ? player.hp / player.maxHp : 1;
  const basicInnerSkillLevel = getSkillLevel(player, '基本内功');
  const insightChance = Math.min(0.18, 0.02 + basicInnerSkillLevel * 0.001 + hpCost * 0.00015);
  const backlashChance = Math.min(0.2, Math.max(0, 0.06 - basicInnerSkillLevel * 0.0012 + (0.25 - hpRatio) * 0.12 + progress.ratio * 0.05));

  if (Math.random() < backlashChance) {
    const hpPenalty = Math.max(1, Math.floor(hpCost * 0.12));
    const mpPenalty = Math.max(1, Math.floor((player.maxMp || 1) * 0.05));
    return {
      type: 'backlash',
      hpPenalty,
      mpPenalty,
      message: innerSkillName === '北冥神功'
        ? '你贪求吞纳过急，诸般杂气倒卷丹田，险些岔了真息。'
        : '你一念稍乱，周天运转顿时失衡，真气在经脉间猛地一窒。'
    };
  }

  if (Math.random() < insightChance) {
    const bonusMp = Math.max(1, Math.floor(hpCost * 0.08 + basicInnerSkillLevel * 0.4));
    const bonusHp = Math.max(0, Math.floor(bonusMp * 0.4));
    const bonusExp = Math.max(3, Math.floor(hpCost * 0.12));
    return {
      type: 'insight',
      bonusMp,
      bonusHp,
      bonusExp,
      message: innerSkillName === '紫霞神功'
        ? '你忽觉紫气东来，心神澄明，刹那间竟窥见一线更高明的运气法门。'
        : innerSkillName === '易筋经'
        ? '你只觉筋骨齐鸣，气血与真息融成一片，似乎悟到更深一层的门径。'
        : '你福至心灵，周天运转竟比往日顺畅许多，隐隐有顿悟之感。'
    };
  }

  return null;
}

function getMeditationCooldownMs(player) {
  const basicInnerSkillLevel = getSkillLevel(player, '基本内功');
  return Math.max(8000, 18000 - basicInnerSkillLevel * 150);
}

function getCultivationSiteBonus(roomName, innerSkillName = '基本内功') {
  const siteBonuses = {
    '思过崖': { exp: 1.2, mp: 1.15, hp: 1.05, desc: '思过崖孤绝清冷，最利参悟心关。', school: '华山派', favored: ['紫霞神功', '九阴真经'] },
    '方丈室': { exp: 1.1, mp: 1.08, hp: 1.18, desc: '方丈室禅意深深，闭关时更易稳固根基。', school: '少林寺', favored: ['易筋经'] },
    '少林练功房': { exp: 1.05, mp: 1.06, hp: 1.12, desc: '少林练功房气息沉稳，适合夯实气血。', school: '少林寺', favored: ['易筋经', '基本内功'] },
    '华山练功房': { exp: 1.08, mp: 1.12, hp: 1.04, desc: '华山练功房山风激荡，更助内息精进。', school: '华山派', favored: ['紫霞神功'] },
    '练功房': { exp: 1, mp: 1, hp: 1, desc: '石室幽静，虽无奇遇，却也最适合踏实修炼。', school: null, favored: ['基本内功'] }
  };
  const base = siteBonuses[roomName] || { exp: 1, mp: 1, hp: 1, desc: '此地只算寻常。', school: null, favored: [] };
  const bonus = { ...base, resonance: false };
  if (base.favored.includes(innerSkillName)) {
    bonus.exp = Number((bonus.exp * 1.08).toFixed(3));
    bonus.mp = Number((bonus.mp * 1.12).toFixed(3));
    bonus.hp = Number((bonus.hp * 1.08).toFixed(3));
    bonus.resonance = true;
    bonus.desc += ` 此地与你所修的${innerSkillName}隐隐共鸣。`;
  }
  return bonus;
}

function rollRetreatInterruption(player, roomName, innerSkillName) {
  const chance = roomName === '思过崖' || roomName === '方丈室' ? 0.08 : 0.05;
  if (Math.random() > chance) return null;
  if (roomName === '思过崖') {
    return {
      type: 'encounter',
      expFactor: 1.18,
      mpFactor: 1.12,
      hpFactor: 1,
      message: '山风穿崖而过，你恍惚间似见前人剑痕未散，竟从中悟出几分新意。'
    };
  }
  if (roomName === '方丈室') {
    return {
      type: 'guidance',
      expFactor: 1.1,
      mpFactor: 1,
      hpFactor: 1.2,
      message: '檀香袅袅间，你仿佛听见一声低沉佛号，心神顿时安定下来。'
    };
  }
  return {
    type: 'disturb',
    expFactor: 0.88,
    mpFactor: 0.9,
    hpFactor: 0.92,
    message: innerSkillName === '北冥神功'
      ? '你正欲沉入更深层的吐纳，外界杂音忽入耳中，丹田回流顿时散了几分。'
      : '你闭关正紧，忽被外间细碎声响扰动，气机微微一乱。'
  };
}

function rollRetreatEvent(player, retreatMinutes, innerSkillName) {
  const basicInnerSkillLevel = getSkillLevel(player, '基本内功');
  const insightChance = Math.min(0.22, 0.05 + retreatMinutes * 0.01 + basicInnerSkillLevel * 0.0015);
  const bottleneckChance = Math.min(0.18, 0.04 + retreatMinutes * 0.008);
  const backlashChance = Math.max(0.02, 0.08 - basicInnerSkillLevel * 0.001);

  const roll = Math.random();
  if (roll < backlashChance) {
    return {
      type: 'backlash',
      expFactor: 0.7,
      mpBonusFactor: 0.65,
      hpBonusFactor: 0.7,
      message: innerSkillName === '九阳神功'
        ? '你强催真火过甚，胸中热浪翻腾，险些逆冲心脉。'
        : '你闭关时心神一乱，真息逆行，经脉隐隐作痛。'
    };
  }
  if (roll < backlashChance + bottleneckChance) {
    return {
      type: 'bottleneck',
      expFactor: 0.85,
      mpBonusFactor: 0.8,
      hpBonusFactor: 0.8,
      message: '你隐约触到一层关隘，虽未尽破，却也摸清了前路所在。'
    };
  }
  if (roll > 1 - insightChance) {
    return {
      type: 'insight',
      expFactor: 1.35,
      mpBonusFactor: 1.4,
      hpBonusFactor: 1.25,
      message: innerSkillName === '易筋经'
        ? '你在寂然中忽觉周身关节尽开，筋骨皮膜俱有新悟。'
        : '你灵台一明，似有一道灵光贯通上下，所悟远胜平日。'
    };
  }
  return null;
}

function broadcastRetreatBreakthrough(player, roomName, eventType) {
  const roomPlayers = Object.values(players).filter(p => p.room === roomName && p.name !== player.name);
  if (!roomPlayers.length) return;
  const msg = eventType === 'insight'
    ? `【江湖】${player.name}闭关而出，眸中精光隐现，似是大有所得。\n>`
    : eventType === 'backlash'
    ? `【江湖】${player.name}闭关出关时脚步微乱，气息似有些浮动。\n>`
    : `【江湖】${player.name}闭关已毕，神色沉静，似又精进一步。\n>`;
  for (const other of roomPlayers) {
    if (onlinePlayers[other.name]) onlinePlayers[other.name].send(msg);
  }
}

function recalculateDerivedStats(player) {
  decayDrunkValue(player);
  const baseAttr = player.先天 || { 根骨: 5, 悟性: 5, 经脉: 5, 福缘: 5 };
  const literacyLevel = getSkillLevel(player, '学文识字');
  const effectiveWuxing = baseAttr.悟性 + Math.floor(literacyLevel / 12);
  const neigongLevel = getNeigongLevel(player);
  const wugongLevel = getWugongLevel(player);
  const baseInnerSkillLevel = getSkillLevel(player, '基本内功');
  const meditationCap = getMeditationBonusCap(player);
  const meditationMpBonus = Math.min(Math.max(0, Number(player.maxMpBonus || 0)), meditationCap);
  const meditationHpBonus = Math.max(0, Number(player.maxHpBonus || Math.floor(meditationMpBonus * 0.6)));
  const conflictPenalty = getNeigongConflictPenalty(player);
  const conflictFactor = Math.max(0.65, 1 - conflictPenalty.percent / 100);
  const drunkStage = getDrunkStage(player);
  const drinkBuff = getActiveDrinkBuff(player);
  player.maxMpBonus = meditationMpBonus;
  player.maxHpBonus = meditationHpBonus;
  player.maxMp = Math.floor((50 + baseAttr.经脉 * 5 + neigongLevel * 6 + baseInnerSkillLevel * 3 + meditationMpBonus) * conflictFactor);
  player.maxHp = Math.floor((100 + baseAttr.根骨 * 10 + neigongLevel * 3 + Math.floor(player.maxMp * 0.18) + meditationHpBonus) * (0.82 + conflictFactor * 0.18));
  player.maxJingli = 100 + literacyLevel * 4 + Math.floor(effectiveWuxing * 3);
  player.外功攻击 = Math.floor((10 + baseAttr.根骨 * 2 + wugongLevel * 2) * drunkStage.attackFactor) + (drinkBuff?.atk || 0);
  player.内功攻击 = Math.floor(neigongLevel * 1.2);
  player.防御 = 5 + Math.floor(baseAttr.根骨 / 2) + Math.floor(neigongLevel / 3);
  player.身法 = 10 + effectiveWuxing + Math.floor(wugongLevel / 3);
  player.命中 = 80 + effectiveWuxing * 2 + Math.floor(wugongLevel * 0.8) + drunkStage.hitDelta + (drinkBuff?.hit || 0);
  player.闪避 = 10 + Math.floor(baseAttr.经脉 / 2) + Math.floor(player.身法 / 8) + drunkStage.dodgeDelta + (drinkBuff?.dodge || 0);
  player.暴击 = 5 + Math.floor(baseAttr.福缘 / 2) + Math.floor(wugongLevel / 5) + (drinkBuff?.crit || 0);
  player.hp = Math.max(0, Math.min(player.hp ?? player.maxHp, player.maxHp));
  player.mp = Math.max(0, Math.min(player.mp ?? player.maxMp, player.maxMp));
  player.jingli = Math.max(0, Math.min(player.jingli ?? player.maxJingli, player.maxJingli));
  player.气血 = player.hp;
  player.内力 = player.mp;
}

function normalizeCombatState(player) {
  player.follows = Array.isArray(player.follows) ? player.follows : [];
  player.following = player.following || null;
  player.vendetta = Array.isArray(player.vendetta) ? player.vendetta : [];
  player.lastAttacker = player.lastAttacker || null;
  player.pvpKills = Number(player.pvpKills || 0);
  player.deaths = Number(player.deaths || 0);
  player.dead = !!player.dead;
  player.deadTime = Number(player.deadTime || 0);
  recalculateDerivedStats(player);
}

function syncVendettaMap(player) {
  vendettas.set(player.name, new Set(player.vendetta || []));
}

function addVendetta(player, targetName) {
  if (!targetName || targetName === player.name) return false;
  normalizeCombatState(player);
  if (!player.vendetta.includes(targetName)) player.vendetta.push(targetName);
  syncVendettaMap(player);
  return true;
}

function clearVendettaBetween(nameA, nameB) {
  for (const [selfName, targetName] of [[nameA, nameB], [nameB, nameA]]) {
    const role = players[selfName] || users[selfName];
    if (!role) continue;
    role.vendetta = (role.vendetta || []).filter(v => v !== targetName);
    vendettas.set(selfName, new Set(role.vendetta));
  }
}

function ensureCorpseRoom(roomName) {
  if (!corpses[roomName]) corpses[roomName] = [];
  return corpses[roomName];
}

function createCorpse({ roomName, ownerName, sourceType = 'player', items = [], coin = 0, silver = 0, gold = 0 }) {
  const corpse = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${ownerName}的尸体`, ownerName, sourceType, items: [...items], coin, silver, gold, createdAt: Date.now(), expiresAt: Date.now() + 3 * 60 * 1000
  };
  ensureCorpseRoom(roomName).push(corpse);
  setTimeout(() => cleanupCorpse(roomName, corpse.id), 3 * 60 * 1000);
  return corpse;
}

function cleanupCorpse(roomName, corpseId) {
  const roomCorpses = ensureCorpseRoom(roomName);
  const index = roomCorpses.findIndex(c => c.id === corpseId);
  if (index >= 0) {
    const [corpse] = roomCorpses.splice(index, 1);
    for (const p of Object.values(players)) {
      if (p.room === roomName && onlinePlayers[p.name]) {
        onlinePlayers[p.name].send(`一阵轻烟飘过，${corpse.name}化作飞灰，消失不见了。\n>`);
      }
    }
  }
}

function findCorpseInRoom(roomName, keyword) {
  return ensureCorpseRoom(roomName).find(c => c.name === keyword || c.ownerName === keyword || c.name.includes(keyword));
}

function getCorpseSummary(roomName) {
  const roomCorpses = ensureCorpseRoom(roomName);
  return roomCorpses.length ? `\n地上横着: ${roomCorpses.map(c => c.name).join('、')}` : '';
}

function getPerformByName(player, input) {
  const schoolPerforms = schoolPerformDb[player.school] || {};
  return Object.entries(schoolPerforms).find(([name]) => name === input || name.toLowerCase() === input.toLowerCase()) || null;
}

function getNpcCombatProfile(npcName) {
  const meta = getNpcMeta(npcName);
  const role = meta.role || '江湖人物';
  let tier = 1;
  if (/掌门|方丈|宗师|楼主|城主|王|大亨|首席|长老/.test(role)) tier = 4;
  else if (/捕头|统领|高手|镖头|岛主/.test(role)) tier = 3;
  else if (/弟子|护卫|武僧|杀手|官兵|庄家/.test(role)) tier = 2;
  const npcPerform = npcPerformDb[npcName];
  return {
    tier,
    school: npcPerform?.school || null,
    performs: npcPerform?.performs || [],
    maxHp: 65 + tier * 28,
    attack: 10 + tier * 6,
    defense: 4 + tier * 3,
    hit: 68 + tier * 6,
    dodge: 8 + tier * 4,
    exp: 12 + tier * 12,
    coin: 6 + tier * 10
  };
}

function describeCorpse(corpse) {
  const loot = [];
  if (corpse.coin) loot.push(`${corpse.coin}铜钱`);
  if (corpse.silver) loot.push(`${corpse.silver}银`);
  if (corpse.gold) loot.push(`${corpse.gold}金`);
  if (corpse.items?.length) loot.push(corpse.items.join('、'));
  const ageSec = Math.max(0, Math.floor((Date.now() - corpse.createdAt) / 1000));
  const freshness = ageSec < 30 ? '尸身尚温' : ageSec < 90 ? '血迹未干' : ageSec < 150 ? '尸身渐冷' : '已开始腐朽';
  return `\n${corpse.name}，${freshness}。\n${loot.length ? `尸体上还留着: ${loot.join('、')}\n` : '尸体上已被搜刮得干干净净。\n'}`;
}

function ensureInvestigationProgress(player) {
  player.questProgress = player.questProgress || {};
  if (!player.questProgress.dockCaseQuest) player.questProgress.dockCaseQuest = { stage: 'idle', clues: {}, solved: false };
  if (!player.questProgress.laobaoMessageQuest) player.questProgress.laobaoMessageQuest = { stage: 'idle', clues: {}, solved: false };
}

function updateRoomClue(player, roomName) {
  ensureInvestigationProgress(player);
  if (player.questProgress.dockCaseQuest.stage === 'started') {
    if (roomName === '扬州码头') player.questProgress.dockCaseQuest.clues.dock = '你发现码头脚夫总避开一个总在黄昏出现的生面孔。';
    if (roomName === '客栈') player.questProgress.dockCaseQuest.clues.inn = '客栈老板提过最近有阔客住店，却从不留真名。';
    if (roomName === '扬州小巷') player.questProgress.dockCaseQuest.clues.alley = '巷口有人提到“白伞”和“夜里换手递信”。';
  }
  if (player.questProgress.laobaoMessageQuest.stage === 'started') {
    if (roomName === '丽春院') player.questProgress.laobaoMessageQuest.clues.brothel = '你注意到有人递杯时总用左手，袖口还带着淡淡胭脂香。';
    if (roomName === '扬州码头') player.questProgress.laobaoMessageQuest.clues.dock = '码头上有人嘴上说跑船，鞋底却干净得不像常年踩水的人。';
    if (roomName === '客栈') player.questProgress.laobaoMessageQuest.clues.inn = '客栈里有人每次听到“丽春院”三个字，眼神都会微微一紧。';
  }
}

function getBalanceSummary(player) {
  const neigongLevel = getNeigongLevel(player);
  const wugongLevel = getWugongLevel(player);
  const performs = Object.entries(schoolPerformDb[player.school] || {});
  let msg = `【当前平衡参数】\n`;
  msg += `武功等级:${wugongLevel} 内功等级:${neigongLevel}\n`;
  msg += `HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp}\n`;
  msg += `外攻:${player.外功攻击} 内攻:${player.内功攻击} 防御:${player.防御}\n`;
  msg += `命中:${player.命中} 闪避:${player.闪避} 暴击:${player.暴击}\n`;
  if (performs.length) {
    msg += `\n【绝招参数】\n`;
    for (const [name, info] of performs) {
      msg += `${name} | 倍率:${info.damageRate} | 耗蓝:${info.mpCost} | 命中+${info.hitBonus} | 暴击+${info.critBonus}\n`;
    }
  }
  const room = getRoom(player.room);
  const npcName = room?.npcs?.[0];
  if (npcName) {
    const npc = getNpcCombatProfile(npcName);
    msg += `\n【当前房间NPC参考】${npcName}\n`;
    msg += `tier:${npc.tier} HP:${npc.maxHp} 攻:${npc.attack} 防:${npc.defense} 命中:${npc.hit}\n`;
  }
  return msg;
}

function formatPerformLines(lines = []) {
  const colors = [ANSI.red, ANSI.yellow, ANSI.magenta, ANSI.cyan];
  return lines.map((line, index) => `${colors[index % colors.length]}※ ${line}${ANSI.reset}`).join('\n');
}

function resolveCombatTarget(player, targetName) {
  return Object.values(players).find(p => p.name === targetName && p.room === player.room && p.name !== player.name) || null;
}

function resolveCombatSubject(player, rawTargetName) {
  const targetName = (rawTargetName || '').trim();
  if (!targetName) return null;
  const playerTarget = resolveCombatTarget(player, targetName);
  if (playerTarget) return { kind: 'player', target: playerTarget, name: playerTarget.name };
  const room = getRoom(player.room);
  const npcName = resolveNpcName(targetName, room);
  if (npcName) return { kind: 'npc', target: npcName, name: npcName };
  return null;
}

function removeNpcFromRoom(roomName, npcName) {
  const room = getRoom(roomName);
  if (!room) return;
  room.npcs = (room.npcs || []).filter(name => name !== npcName);
}

function createNpcCorpse(roomName, npcName) {
  const drop = ensureNpcDrop(roomName, npcName);
  const profile = getNpcCombatProfile(npcName);
  createCorpse({
    roomName,
    ownerName: npcName,
    sourceType: 'npc',
    items: [...(drop.items || [])],
    coin: drop.money || profile.coin || 0,
    silver: 0,
    gold: 0
  });
  drop.items = [];
  drop.money = 0;
  drop.taken = true;
  removeNpcFromRoom(roomName, npcName);
}

function setFaintState(player) {
  player.fainted = true;
  player.faintTime = Date.now();
  player.hp = Math.max(1, Math.min(player.hp, 10));
}

function runPlayerVsPlayerCombat(attacker, defender, options = {}) {
  normalizeCombatState(attacker);
  normalizeCombatState(defender);
  const performData = options.performData || null;
  const performName = options.performName || null;
  const attackPhrases = ['大喝一声', '身形疾进', '招式凌厉', '掌风呼呼', '剑光闪闪', '真气激荡', '功力运足', '身形晃动'];
  const baseAttackerAtk = attacker.外功攻击 + attacker.内功攻击 + (attacker.weapon ? weapons[attacker.weapon].damage : 0);
  const baseDefenderAtk = defender.外功攻击 + defender.内功攻击 + (defender.weapon ? weapons[defender.weapon].damage : 0);
  const hitBonus = performData?.hitBonus || 0;
  const critBonus = performData?.critBonus || 0;
  const damageRate = performData?.damageRate || 1;
  let log = `
╔══════════════════════════════════════╗
║         ⚔️  ${attacker.name} VS ${defender.name}  ⚔️          ║
╚══════════════════════════════════════╝
${performData ? `${formatPerformLines(performData.lines)}
` : ''}【${defender.name}】HP: ${defender.hp}/${defender.maxHp} ${getHpStatus(defender.hp, defender.maxHp)}
【${attacker.name}】HP: ${attacker.hp}/${attacker.maxHp} MP:${attacker.mp}/${attacker.maxMp} ${getHpStatus(attacker.hp, attacker.maxHp)}

───────────────────────────────────────
`;
  let round = 1;
  while (attacker.hp > 0 && defender.hp > 0) {
    const hitRoll = Math.random() * 100;
    const defenderDodge = Math.min(60, Math.max(5, defender.闪避));
    if (hitRoll <= Math.max(35, attacker.命中 + hitBonus - defenderDodge)) {
      let dmg = Math.max(1, Math.floor((baseAttackerAtk + Math.floor(Math.random() * 12)) * damageRate - defender.防御 / 2));
      const crit = Math.random() * 100 < (attacker.暴击 + critBonus);
      if (crit) dmg = Math.floor(dmg * 1.5);
      defender.hp -= dmg;
      defender.lastAttacker = attacker.name;
      const phrase = attackPhrases[Math.floor(Math.random() * attackPhrases.length)];
      log += `第${round}招 │ ${attacker.name}${performName ? `使出【${performName}】` : phrase}，击中${defender.name}！-${dmg}HP${crit ? '【暴击】' : ''}
`;
    } else {
      log += `第${round}招 │ ${attacker.name}一招落空，被${defender.name}闪身避开。
`;
    }
    if (defender.hp <= 0) break;
    const enemyHitRoll = Math.random() * 100;
    const attackerDodge = Math.min(60, Math.max(5, attacker.闪避));
    if (enemyHitRoll <= Math.max(35, defender.命中 - attackerDodge)) {
      const eDmg = Math.max(1, Math.floor(baseDefenderAtk + Math.random() * 10 - attacker.防御 / 2));
      attacker.hp -= eDmg;
      attacker.lastAttacker = defender.name;
      const ePhrase = attackPhrases[Math.floor(Math.random() * attackPhrases.length)];
      log += `第${round}招 │ ${defender.name}${ePhrase}，击中${attacker.name}！-${eDmg}HP
`;
    } else {
      log += `第${round}招 │ ${defender.name}一招抢攻，却被${attacker.name}从容避开。
`;
    }
    log += `        │ ${attacker.name} HP:${Math.max(0, attacker.hp)}/${attacker.maxHp}  ${defender.name} HP:${Math.max(0, defender.hp)}/${defender.maxHp}
───────────────────────────────────────
`;
    round++;
  }
  let result = 'ongoing';
  if (defender.hp <= 0) result = 'defender_dead';
  else if (attacker.hp <= 0) result = 'attacker_dead';
  else if (attacker.hp <= 10 || defender.hp <= 10) result = 'faint';
  return { log, result };
}

function runPlayerVsNpcCombat(player, npcName, roomName, options = {}) {
  normalizeCombatState(player);
  const performData = options.performData || null;
  const performName = options.performName || null;
  const npcProfile = getNpcCombatProfile(npcName);
  const npcPerformName = npcProfile.performs?.length ? npcProfile.performs[Math.floor(Math.random() * npcProfile.performs.length)] : null;
  const npcPerformInfo = npcPerformName && npcProfile.school ? schoolPerformDb[npcProfile.school]?.[npcPerformName] : null;
  const enemyMaxHp = npcProfile.maxHp;
  let enemyHp = enemyMaxHp;
  const playerAtk = player.外功攻击 + player.内功攻击 + (player.weapon ? weapons[player.weapon].damage : 0);
  const attackPhrases = ['大喝一声', '身形疾进', '招式凌厉', '掌风呼呼', '剑光闪闪', '真气激荡', '功力运足', '身形晃动', '攻势如潮', '招式精妙'];
  const enemyAttackPhrases = ['反手一击', '攻势凌厉', '招架不住', '掌力雄浑', '招式毒辣', '迎面攻来', '功力深厚', '变招迅速', '真气弥漫', '内力惊人'];
  let combatLog = `
╔══════════════════════════════════════╗
║           ⚔️  江湖恶斗  ⚔️           ║
╚══════════════════════════════════════╝
${performData ? `${formatPerformLines(performData.lines)}
` : ''}
【${npcName}】HP: ${enemyHp}/${enemyMaxHp}
【${player.name}】HP: ${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp}

───────────────────────────────────────
`;
  let round = 1;
  while (enemyHp > 0 && player.hp > 0) {
    const dmg = Math.max(1, Math.floor((playerAtk + Math.random() * 10) * (performData?.damageRate || 1) - npcProfile.defense / 2));
    enemyHp -= dmg;
    combatLog += `第${round}招 │ ${player.name}${performName ? `使出【${performName}】` : attackPhrases[Math.floor(Math.random() * attackPhrases.length)]}，击中${npcName}！-${dmg}HP
`;
    if (enemyHp <= 0) break;
    const eHitRoll = Math.random() * 100;
    if (eHitRoll > Math.max(35, npcProfile.hit - player.闪避)) {
      combatLog += `第${round}招 │ ${npcName}虚晃一招，被${player.name}闪身避过。\n`;
      combatLog += `        │ ${player.name} HP:${Math.max(0, player.hp)}/${player.maxHp}  ${npcName} HP:${Math.max(0, enemyHp)}/${enemyMaxHp}\n───────────────────────────────────────\n`;
      round++;
      continue;
    }
    const npcDamageRate = npcPerformInfo ? Math.min(1.22, npcPerformInfo.damageRate) : 1;
    const eDmg = Math.max(1, Math.floor((npcProfile.attack + Math.floor(Math.random() * 8)) * npcDamageRate - player.防御 / 2 - (player.armor ? armors[player.armor].defense / 2 : 0)));
    player.hp -= eDmg;
    combatLog += `第${round}招 │ ${npcName}${npcPerformName ? `使出【${npcPerformName}】` : ` ${enemyAttackPhrases[Math.floor(Math.random() * enemyAttackPhrases.length)]}`}，击中${player.name}！-${eDmg}HP
`;
    combatLog += `        │ ${player.name} HP:${Math.max(0, player.hp)}/${player.maxHp}  ${npcName} HP:${Math.max(0, enemyHp)}/${enemyMaxHp}
───────────────────────────────────────
`;
    round++;
  }
  if (enemyHp <= 0) return { log: combatLog, result: 'npc_dead' };
  if (player.hp <= 0) return { log: combatLog, result: 'player_dead' };
  if (player.hp <= 10) return { log: combatLog, result: 'player_faint' };
  return { log: combatLog, result: 'ongoing' };
}

function applyDeathPenalty(player) {
  player.deaths = (player.deaths || 0) + 1;
  player.exp = Math.max(0, Math.floor(player.exp * 0.9));
  player.maxMp = Math.max(30, Math.floor(player.maxMp * 0.95));
  player.maxHp = Math.max(60, Math.floor(player.maxHp * 0.95));
  player.hp = Math.max(1, Math.floor(player.maxHp * 0.35));
  player.mp = Math.floor(player.maxMp * 0.35);
  recalculateDerivedStats(player);
}

function handlePlayerDeath(victim, killer, wsVictim) {
  victim.dead = true;
  victim.deadTime = Date.now();
  victim.fainted = false;
  victim.hp = 0;
  createCorpse({
    roomName: victim.room,
    ownerName: victim.name,
    sourceType: 'player',
    items: [...(victim.inventory || []), ...(victim.weapon ? [victim.weapon] : []), ...(victim.armor ? [victim.armor] : [])],
    coin: victim.coin || 0,
    silver: victim.silver || 0,
    gold: victim.gold || 0
  });
  victim.inventory = [];
  victim.weapon = null;
  victim.armor = null;
  victim.coin = 0;
  victim.silver = 0;
  victim.gold = 0;
  if (killer) {
    killer.pvpKills = (killer.pvpKills || 0) + 1;
    clearVendettaBetween(victim.name, killer.name);
  }
  applyDeathPenalty(victim);
  victim.room = '客栈';
  victim.dead = false;
  victim.deadTime = 0;
  if (wsVictim) {
    wsVictim.send(`\n☠️ 你已死亡，尸体留在原地。\n你在客栈中幽幽醒转，只觉功力大损。\n【当前】HP:${victim.hp}/${victim.maxHp} MP:${victim.mp}/${victim.maxMp}\n>`);
  }
}

function tryAutoVendettaCombat(arriver) {
  const enemies = (arriver.vendetta || []).map(name => resolveCombatTarget(arriver, name)).filter(Boolean);
  if (!enemies.length) return;
  const enemy = enemies[0];
  const result = runPlayerVsPlayerCombat(arriver, enemy, {});
  if (onlinePlayers[arriver.name]) onlinePlayers[arriver.name].send(`仇人【${enemy.name}】现身此地，你杀机陡起，立刻出手！\n${result.log}\n>`);
  if (onlinePlayers[enemy.name]) onlinePlayers[enemy.name].send(`【警讯】${arriver.name}与你仇怨未了，见面便痛下杀手！\n${result.log}\n>`);
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name !== arriver.name && name !== enemy.name && players[name]?.room === arriver.room) {
      client.send(`【江湖风云】${arriver.name}与${enemy.name}仇人见面，甫一照面便大打出手！\n>`);
    }
  }
  if (result.result === 'defender_dead') {
    handlePlayerDeath(enemy, arriver, onlinePlayers[enemy.name]);
  } else if (result.result === 'attacker_dead') {
    handlePlayerDeath(arriver, enemy, onlinePlayers[arriver.name]);
  } else {
    if (arriver.hp <= 10) setFaintState(arriver);
    if (enemy.hp <= 10) setFaintState(enemy);
  }
}

function broadcastRoomArrival(arriver, roomName) {
  updateRoomClue(arriver, roomName);
  for (const [name, client] of Object.entries(onlinePlayers)) {
    if (name === arriver.name) continue;
    const targetPlayer = users[name];
    if (!targetPlayer || targetPlayer.room !== roomName) continue;
    const drunkStage = getDrunkStage(arriver);
    let arrivalText = formatArrival(arriver.name, arriver.hp, arriver.maxHp);
    if (drunkStage.key === 'wasted') arrivalText = `${arriver.name}脚步踉跄地晃了过来，满身酒气，险些撞翻一旁桌椅`;
    else if (drunkStage.key === 'drunk') arrivalText = `${arriver.name}带着一身酒意走了过来，步伐已有些不稳`;
    else if (drunkStage.key === 'tipsy') arrivalText = `${arriver.name}面带薄红地走了过来，似乎刚饮过几杯`;
    client.send(`【系统】${arrivalText}。\n>`);
  }
  tryAutoVendettaCombat(arriver);
  const followers = Object.values(players).filter(p => p.following === arriver.name && p.room !== arriver.room && !p.dead && !p.fainted);
  for (const follower of followers) {
    broadcastRoomDeparture(follower.name, follower.room, 'player');
    follower.room = arriver.room;
    follower.hp = Math.max(1, follower.hp);
    broadcastRoomArrivalNotice(follower.name, follower.room, 'player');
    if (onlinePlayers[follower.name]) {
      onlinePlayers[follower.name].send(`你一路跟随${arriver.name}，来到了${arriver.room}。\n${formatOutputBrief(follower, follower.room)}`);
    }
  }
}

function getNpcCurrentRoom(npcName) {
  for (const [roomName, room] of Object.entries(rooms)) {
    if ((room.npcs || []).includes(npcName)) return roomName;
  }
  return null;
}

// 生成玩家描述
function getPlayerDescription(targetPlayer) {
  const p = targetPlayer;
  
  // 容貌描述
  const 容貌描述 = p.先天 && p.先天.根骨 ? 
    (p.先天.根骨 >= 9 ? "容貌俊美" : p.先天.根骨 >= 7 ? "面貌端正" : "其貌不扬") :
    "面貌普通";
  
  // 衣着描述
  const 衣着 = p.armor ? `身着${p.armor}` : "衣着朴素";
  
  // 装备描述
  const 武器 = p.weapon ? `手持${p.weapon}` : "空着手";
  
  // 气血状态
  const 状态 = getHpStatus(p.hp, p.maxHp);
  
  // 职位描述
  const 职位 = p.title || "江湖人士";
  
  return `${p.name}，${容貌描述}，${衣着}，${武器}。\n${职位}，${状态}。`;
}

// 简洁输出（不带详细属性）
function formatOutputBrief(player, message) {
  let output = `\n=== ${message} ===\n\n`;
  const room = getRoom(player.room);
  if (room) {
    output += room.description + getCorpseSummary(player.room) + '\n';
    output += `\n出口: ${Object.keys(room.exits).join('、')}\n`;
    const playersInRoom = Object.values(players).filter(p => p.room === player.room && p.name !== player.name);
    if (playersInRoom.length > 0) {
      output += `你看到: ${playersInRoom.map(p => formatArrival(p.name, p.hp, p.maxHp)).join('、')}\n`;
    }
    if (room.npcs.length > 0) {
      output += `你看到: ${formatNpcList(room.npcs)}\n`;
    }
    if (room.shop) {
      output += `\n【店铺】输入 shop 查看商品\n`;
    }
  }
  const greetingLines = collectNpcGreetingLines(player, player.room, { force: /^你向|你走进了|欢迎回来|注册成功|你登上/.test(message) });
  if (greetingLines.length) output += `\n${greetingLines.join('\n')}\n`;
  output += `\n> `;
  return output;
}

// 完整输出（带详细属性）
function formatOutput(player, message) {
  let output = `\n=== ${message} ===\n\n`;
  const room = getRoom(player.room);
  if (room) {
    output += room.description + getCorpseSummary(player.room) + '\n';
    output += `\n出口: ${Object.keys(room.exits).join('、')}\n`;
    const playersInRoom = Object.values(players).filter(p => p.room === player.room && p.name !== player.name);
    if (playersInRoom.length > 0) {
      output += `你看到: ${playersInRoom.map(p => formatArrival(p.name, p.hp, p.maxHp)).join('、')}\n`;
    }
    if (room.npcs.length > 0) {
      output += `你看到: ${formatNpcList(room.npcs)}\n`;
    }
    if (room.shop) {
      output += `\n【店铺】输入 shop 查看商品\n`;
    }
  }
  let weaponDmg = player.weapon ? weapons[player.weapon].damage : 0;
  let armorDef = player.armor ? armors[player.armor].defense : 0;
  output += `\n【${player.name}】${player.title}\n`;
  output += `根骨:${player.先天.根骨} 悟性:${player.先天.悟性} 经脉:${player.先天.经脉} 福缘:${player.先天.福缘}\n`;
  output += `HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} STA:${player.jingli ?? 100}/${player.maxJingli ?? 100}\n`;
  output += `攻击:${player.外功攻击} 防御:${player.防御} 身法:${player.身法}\n`;
  output += `经验:${player.exp} 铜钱:${player.coin}\n`;
  output += `修炼境界:${getCultivationRealm(player)} 主修内功:${getPrimaryInnerSkill(player).name}\n`;
  output += `酒意:${getDrunkStage(player).label} (${Math.max(0, Math.floor(player.drunk || 0))}/100)\n`;
  if (player.weapon || player.armor) {
    output += `装备: ${player.weapon || '无'}(攻+${weaponDmg}) ${player.armor || '无'}(防+${armorDef})\n`;
  }
  const greetingLines = collectNpcGreetingLines(player, player.room, { force: /^你向|你走进了|欢迎回来|注册成功|你登上/.test(message) });
  if (greetingLines.length) output += `\n${greetingLines.join('\n')}\n`;
  output += '\n>';
  return output;
}

wss.on('connection', (ws, req) => {
  let player = null;
  let state = 'welcome';
  let tempName = '';

  ws.isAlive = true;
  ws.missedPongs = 0;
  ws.on('pong', heartbeat);

  const remoteIp = req?.headers?.['cf-connecting-ip'] || req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown';
  console.log(`[WebSocket连接] ip=${remoteIp}`);

  ws.send('\n🦞 欢迎来到【武侠世界】MUD！\n\n请选择:\n1. 登录 (login)\n2. 注册 (register)\n> ');

  ws.on('error', (err) => {
    console.log(`[WebSocket错误] ip=${remoteIp} player=${player?.name || '-'} message=${err.message}`);
  });

  ws.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : (reasonBuffer || '');
    console.log(`[WebSocket关闭] ip=${remoteIp} player=${player?.name || '-'} code=${code} reason=${reason || '-'} alive=${ws.isAlive}`);
    if (player && players[player.name]) {
      console.log(`[玩家断开] ${player.name}`);
      if (users[player.name]) {
        Object.assign(users[player.name], {
          exp: player.exp, level: player.level, coin: player.coin,
          skills: player.skills, hp: player.hp, mp: player.mp,
          inventory: player.inventory, weapon: player.weapon, armor: player.armor,
          follows: player.follows, master: player.master, school: player.school
        });
        saveUsers();
      }
      delete players[player.name];
      if (onlinePlayers[player.name]) delete onlinePlayers[player.name];
      markPlayerOffline(player);
    }
  });

  ws.on('message', async (data) => {
    const input = data.toString().trim();

    if (input === '/ping') {
      ws.isAlive = true;
      ws.missedPongs = 0;
      return;
    }

    if (input.startsWith('/client_version ')) {
      ws.clientVersion = input.substring('/client_version '.length).trim();
      return;
    }

    // 检查玩家是否晕倒
    if (player && player.fainted) {
      const now = Date.now();
      if (now - player.faintTime >= 20000) {
        // 20秒后醒来
        player.fainted = false;
        player.hp = 10;
        ws.send('你缓缓醒来，头痛欲裂，咬牙站了起来。\n【当前】HP: 10/' + player.maxHp + '\n>');
        return;
      } else {
        // 晕倒中，无法输入
        ws.send('═══════════════════════════════════════\n       你眼前一黑，没有了任何知觉......\n═══════════════════════════════════════\n');
        return;
      }
    }

    // 检查玩家是否在睡觉
    if (player && player.sleeping) {
      const now = Date.now();
      if (now - player.sleepStartTime >= 20000) {
        // 20秒后醒来
        player.sleeping = false;
        player.hp = player.maxHp;
        player.jingli = player.maxJingli ?? 100;
        const drunkWakeMsg = getDrunkWakeEffect(player);
        let wakeMsg;
        if (player.hp >= player.maxHp * 0.8) {
          wakeMsg = '一觉醒来，你感到神清气爽';
        } else if (player.hp >= player.maxHp * 0.5) {
          wakeMsg = '一觉醒来，你感觉身体恢复了不少';
        } else {
          wakeMsg = '一觉醒来，你感觉腰酸背痛';
        }
        ws.send(wakeMsg + `。${drunkWakeMsg ? `\n${drunkWakeMsg}` : ''}\n【当前】HP: ` + player.hp + '/' + player.maxHp + ` MP:${player.mp}/${player.maxMp} STA:${player.jingli}/${player.maxJingli} 酒意:${getDrunkStage(player).label}(${Math.max(0, Math.floor(player.drunk || 0))}/100)\n>`);
        saveProgress();
        return;
      } else {
        ws.send('你正在睡觉，不要打扰你。\n>');
        return;
      }
    }

    // 检查玩家是否在打坐
    if (player && player.meditating) {
      const now = Date.now();
      if (now >= Number(player.meditationEndTime || 0)) {
        player.meditating = false;
        player.meditationEndTime = 0;
        if (users[player.name]) {
          users[player.name].meditating = false;
          users[player.name].meditationEndTime = 0;
          db.saveUser(player.name, player);
        }
        ws.send('你缓缓睁开双眼，长长吐出一口浊气，起身而立。方才内息已沿周天运转一遍，丹田之中似乎又丰盈了几分。\n>');
        return;
      }
      ws.send('你正盘膝入定，真气尚在经脉间流转，暂时不能起身行动。\n>');
      return;
    }

    // 检查玩家是否在闭关
    if (player && player.retreating) {
      const now = Date.now();
      if (now - Number(player.retreatStartTime || 0) >= Number(player.retreatDurationMs || 0)) {
        const retreatMinutes = Math.max(1, Math.round((player.retreatDurationMs || 60000) / 60000));
        const basicInnerSkillLevel = getSkillLevel(player, '基本内功');
        const primaryInnerSkill = getPrimaryInnerSkill(player);
        const retreatRoomName = player.retreatRoom || player.room;
        const siteBonus = getCultivationSiteBonus(retreatRoomName, primaryInnerSkill.name);
        const retreatEvent = rollRetreatEvent(player, retreatMinutes, primaryInnerSkill.name);
        const retreatInterrupt = rollRetreatInterruption(player, retreatRoomName, primaryInnerSkill.name);
        let expGain = Math.max(20, Math.floor((retreatMinutes * 18 + basicInnerSkillLevel * 3) * siteBonus.exp));
        let mpBonusGain = Math.max(2, Math.floor(retreatMinutes * (1.2 + basicInnerSkillLevel * 0.08) * siteBonus.mp));
        let hpBonusGain = Math.max(1, Math.floor(mpBonusGain * 0.5 * siteBonus.hp));
        const skillExpGain = Math.max(10, retreatMinutes * 8);
        if (retreatEvent) {
          expGain = Math.max(8, Math.floor(expGain * retreatEvent.expFactor));
          mpBonusGain = Math.max(1, Math.floor(mpBonusGain * retreatEvent.mpBonusFactor));
          hpBonusGain = Math.max(1, Math.floor(hpBonusGain * retreatEvent.hpBonusFactor));
        }
        if (retreatInterrupt) {
          expGain = Math.max(6, Math.floor(expGain * retreatInterrupt.expFactor));
          mpBonusGain = Math.max(1, Math.floor(mpBonusGain * retreatInterrupt.mpFactor));
          hpBonusGain = Math.max(1, Math.floor(hpBonusGain * retreatInterrupt.hpFactor));
        }
        const oldMaxMp = player.maxMp;
        const oldMaxHp = player.maxHp;
        player.retreating = false;
        player.retreatStartTime = 0;
        player.retreatDurationMs = 0;
        player.retreatRoom = null;
        player.maxMpBonus = Math.max(0, Number(player.maxMpBonus || 0)) + mpBonusGain;
        player.maxHpBonus = Math.max(0, Number(player.maxHpBonus || 0)) + hpBonusGain;
        player.exp += expGain;
        if (player.skills[primaryInnerSkill.name]) {
          player.skills[primaryInnerSkill.name].exp = (player.skills[primaryInnerSkill.name].exp || 0) + skillExpGain;
          if (player.skills[primaryInnerSkill.name].exp >= player.skills[primaryInnerSkill.name].level * 28) {
            player.skills[primaryInnerSkill.name].exp = 0;
            player.skills[primaryInnerSkill.name].level += 1;
          }
        }
        recalculateDerivedStats(player);
        if (retreatEvent?.type === 'backlash') {
          player.hp = Math.max(1, Math.floor(player.maxHp * 0.45));
          player.mp = Math.max(0, Math.floor(player.maxMp * 0.35));
        } else {
          player.hp = Math.min(player.maxHp, Math.max(player.hp, Math.floor(player.maxHp * 0.7)));
          player.mp = player.maxMp;
        }
        player.title = getTitle(player.exp);
        const actualMaxMpGain = player.maxMp - oldMaxMp;
        const actualMaxHpGain = player.maxHp - oldMaxHp;
        const eventMsg = retreatEvent?.type === 'insight'
          ? `\n✨【顿悟】${retreatEvent.message}`
          : retreatEvent?.type === 'bottleneck'
          ? `\n🪨【瓶颈】${retreatEvent.message}`
          : retreatEvent?.type === 'backlash'
          ? `\n⚠️【走火】${retreatEvent.message}`
          : '';
        const interruptMsg = retreatInterrupt?.type === 'encounter'
          ? `\n🌫️【奇遇】${retreatInterrupt.message}`
          : retreatInterrupt?.type === 'guidance'
          ? `\n🪔【点化】${retreatInterrupt.message}`
          : retreatInterrupt?.type === 'disturb'
          ? `\n🍃【扰动】${retreatInterrupt.message}`
          : '';
        const resonanceMsg = siteBonus.resonance ? `\n🔔【共鸣】${primaryInnerSkill.name}与此地气机互相激荡，你的闭关收获更胜平日。` : '';
        ws.send(`你缓缓收功，结束了这一轮闭关。${eventMsg}${interruptMsg}${resonanceMsg}\n【闭关宝地】${siteBonus.desc}\n【闭关成果】经验+${expGain}，MP上限+${actualMaxMpGain}，HP上限+${actualMaxHpGain}\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} 主修内功:${primaryInnerSkill.name}\n>`);
        broadcastRetreatBreakthrough(player, retreatRoomName, retreatEvent?.type || retreatInterrupt?.type || 'normal');
        saveProgress();
        return;
      } else {
        const remainSec = Math.max(1, Math.ceil((Number(player.retreatDurationMs || 0) - (now - Number(player.retreatStartTime || 0))) / 1000));
        ws.send(`你正在闭关参悟，暂时无暇分心，还需${remainSec}秒方可出关。\n>`);
        return;
      }
    }

    if (state === 'welcome') {
      if (input === '1' || input === 'login') {
        state = 'login';
        ws.send('请输入用户名:');
      } else if (input === '2' || input === 'register') {
        state = 'register';
        ws.send('请输入用户名:');
      } else {
        ws.send('请输入 1 或 2:');
      }
      return;
    }

    if (state === 'login') {
      tempName = input;
      if (!users[tempName]) {
        ws.send('用户不存在，请先注册:');
        state = 'register';
        return;
      }
      ws.send('请输入密码:');
      state = 'login_pwd';
      return;
    }

    if (state === 'login_pwd') {
      if (users[tempName] && users[tempName].password === input) {
        player = restorePlayerFromStoredData(tempName, users[tempName]);
        const savedData = users[tempName];
        
        // 检查是否晕倒状态需要恢复
        if (player.fainted && player.faintTime) {
          const now = Date.now();
          if (now - player.faintTime >= 20000) {
            player.fainted = false;
            player.hp = 10;
          }
        }
        
        // 检查是否睡觉状态需要恢复
        if (player.sleeping && player.sleepStartTime) {
          const now = Date.now();
          if (now - player.sleepStartTime >= 20000) {
            player.sleeping = false;
            player.hp = player.maxHp;
          }
        }
        
        ensureMoneyState(player);
        normalizeCombatState(player);
        syncVendettaMap(player);
        player.title = getTitle(player.exp);
        players[tempName] = player;
        onlinePlayers[tempName] = ws;
        state = 'playing';
        markPlayerOnline(player, ws);
        
        reloadUsersFromDb();
        users[tempName] = db.getUser(tempName) || users[tempName];

        // 欢迎消息 + 在线人数 + 运行时间
        const onlineCount = Object.keys(onlinePlayers).length;
        const uptime = getUptime();
        const welcomeMsg = '\n╔════════════════════════════════════╗\n' +
'║   欢迎' + tempName + '登陆武侠世界！         ║\n' +
'║   当前在线玩家: ' + onlineCount + '人               ║\n' +
'║   江湖儿女江湖老，烟雨楼台烟雨深   ║\n' +
'║   廿载凡尘磨傲骨，一片冰心在玉壶   ║\n' +
'║   世界已经运行了' + uptime.days + '天' + uptime.hours + '小时' + uptime.minutes + '分钟    ║\n' +
'╚════════════════════════════════════╝\n';
        ws.send(welcomeMsg);
        ws.send(formatOutput(player, '欢迎回来，' + tempName + '！'));
        
        const session = issueSession(tempName, ws);
        ws.send('【江湖秘术】' + tempName + '又回到了这个世界~');
        
        // 通知关注者
        if (savedData && savedData.follows) {
          for (const followedName of savedData.follows) {
            if (onlinePlayers[followedName]) {
              onlinePlayers[followedName].send(`【系统】你关注的【${tempName}】已上线！\n>`);
            }
          }
        }
      } else {
        ws.send('密码错误，请重新输入用户名:');
        state = 'login';
      }
      return;
    }

    if (state === 'register') {
      tempName = input;
      if (!isValidUsername(tempName)) {
        ws.send('用户名需为2-20位，仅支持中文、字母、数字、下划线，且不能包含空格或命令格式。');
        return;
      }
      if (users[tempName]) {
        ws.send('用户名已存在，请输入其他名字:');
        return;
      }
      ws.send('请设置密码:');
      state = 'register_pwd';
      return;
    }

    if (state === 'register_pwd') {
      if (input.length < 3) {
        ws.send('密码至少3个字符:');
        return;
      }
      // 先创建玩家获取先天资质
      const newPlayer = createPlayer(tempName);
      users[tempName] = {
        name: tempName,
        password: input, exp: 0, level: 1, gold: 50,
        skills: JSON.parse(JSON.stringify(skills)),
        hp: newPlayer.hp, mp: newPlayer.mp,
        inventory: [], weapon: null, armor: null, 
        follows: [], following: null, vendetta: [], lastAttacker: null,
        master: null, school: null,
        pvpKills: 0, deaths: 0,
        // 保存先天资质
        先天: newPlayer.先天,
        气血: newPlayer.气血,
        内力: newPlayer.内力,
        外功攻击: newPlayer.外功攻击,
        内功攻击: newPlayer.内功攻击,
        防御: newPlayer.防御,
        身法: newPlayer.身法,
        命中: newPlayer.命中,
        闪避: newPlayer.闪避,
        暴击: newPlayer.暴击,
        maxHp: newPlayer.maxHp,
        maxMp: newPlayer.maxMp,
        门派声望: 0,
        achievements: [],
        quest: null,
        questProgress: {},
        npcRelations: {}
      };
      saveUsers();
      reloadUsersFromDb();
      player = newPlayer;
      ensureMoneyState(player);
      normalizeCombatState(player);
      players[tempName] = player;
      onlinePlayers[tempName] = ws;
      state = 'playing';
      markPlayerOnline(player, ws);
      console.log(`[注册] ${tempName} 注册成功`);
      // 注册欢迎消息 + 在线人数
      const onlineCount = Object.keys(onlinePlayers).length;
      ws.send(`╔════════════════════════════════════╗
║   欢迎${tempName}登陆武侠世界！         ║
║   当前在线玩家: ${onlineCount}人               ║
╚════════════════════════════════════╝
`);
      const session = issueSession(tempName, ws);
      ws.send('【江湖秘术】' + tempName + '又回到了这个世界~');
      ws.send(formatOutput(player, '注册成功！江湖欢迎你'));
      return;
    }

    if (state === 'playing') {
      const parts = input.split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');

      function saveProgress() {
        if (users[player.name]) {
          markPlayerHeartbeat(player);
          ensureMoneyState(player);
          normalizeCombatState(player);
          // 保存所有玩家数据
          const savedNpcRelations = {};
          for (const npcName of Object.keys(npcPlayerState)) {
            if (npcPlayerState[npcName]?.[player.name]) {
              savedNpcRelations[npcName] = { ...npcPlayerState[npcName][player.name] };
            }
          }
          Object.assign(users[player.name], {
            // 基本属性
            exp: player.exp, level: player.level, coin: player.coin,
            silver: player.silver, gold: player.gold,
            jingli: player.jingli,
            maxJingli: player.maxJingli,
            guandanStats: player.guandanStats,
            hp: player.hp, mp: player.mp,
            maxHp: player.maxHp, maxMp: player.maxMp,
            // 晕倒状态
            fainted: player.fainted,
            faintTime: player.faintTime,
            // 睡觉状态
            sleeping: player.sleeping,
            sleepStartTime: player.sleepStartTime,
            // 技能和装备
            skills: player.skills, 
            inventory: player.inventory, 
            weapon: player.weapon, 
            armor: player.armor,
            // 社交和师门
            follows: player.follows,
            following: player.following,
            vendetta: player.vendetta,
            lastAttacker: player.lastAttacker,
            master: player.master,
            school: player.school,
            // 任务系统
            quest: player.quest,
            questProgress: player.questProgress,
            // 先天资质（关键！不要每次重新随机生成）
            先天: player.先天,
            // 后天属性
            气血: player.气血,
            内力: player.内力,
            外功攻击: player.外功攻击,
            内功攻击: player.内功攻击,
            防御: player.防御,
            身法: player.身法,
            命中: player.命中,
            闪避: player.闪避,
            暴击: player.暴击,
            drunk: player.drunk,
            lastDrinkAt: player.lastDrinkAt,
            lastDrinkDecayAt: player.lastDrinkDecayAt,
            drinkBuffs: player.drinkBuffs,
            maxMpBonus: player.maxMpBonus,
            maxHpBonus: player.maxHpBonus,
            lastMeditationAt: player.lastMeditationAt,
            meditating: player.meditating,
            meditationEndTime: player.meditationEndTime,
            // 门派声望
            门派声望: player.门派声望,
            pvpKills: player.pvpKills,
            deaths: player.deaths,
            dead: player.dead,
            deadTime: player.deadTime,
            // 成就
            achievements: player.achievements || [],
            // 三体线
            观测数据: player.观测数据,
            信号已解码: player.信号已解码,
            faction: player.faction,
            // 扬州赌场掼蛋
            guandan: player.guandan,
            npcRelations: savedNpcRelations
          });
          saveUsers();
        }
      }

      switch (cmd) {
        case 'look':
        case 'l':
          if (args) {
            const corpse = findCorpseInRoom(player.room, args);
            if (corpse) {
              ws.send(describeCorpse(corpse) + '>');
              break;
            }
            const roomNow = getRoom(player.room);
            const npcName = resolveNpcName(args, roomNow);
            if (npcName) {
              const meta = getNpcMeta(npcName);
              const drop = ensureNpcDrop(player.room, npcName);
              const npcProfile = getNpcCombatProfile(npcName);
              let npcMsg = `\n${formatNpcName(npcName)}，${meta.role}。\n`;
              npcMsg += `口头语: 「${meta.quote}」\n`;
              npcMsg += `看起来功力约莫在 ${npcProfile.tier} 阶，气息${npcProfile.tier >= 4 ? '深不可测' : npcProfile.tier >= 3 ? '颇为沉稳' : npcProfile.tier >= 2 ? '尚算扎实' : '平平无奇'}。\n`;
              if (!drop.taken) {
                const lootText = [];
                if (drop.money > 0) lootText.push(`${drop.money}铜钱`);
                if (drop.items.length > 0) lootText.push(drop.items.join('、'));
                if (lootText.length > 0) npcMsg += `看起来身上还带着: ${lootText.join('、')}\n`;
              }
              ws.send(npcMsg + '>');
              break;
            }
            const target = Object.values(players).find(p => p.name === args && p.room === player.room);
            if (target) {
              ws.send('\n' + getPlayerDescription(target) + '\n>');
            } else {
              ws.send('这里没有这个玩家、NPC或尸体。\n>');
            }
          } else {
            ws.send(formatOutputBrief(player, player.room));
          }
          break;
        
        case 'sleep':
        case '睡觉':
          if (!['客房', '少林僧房'].includes(player.room)) {
            ws.send('这不是你睡觉的地方。\n>');
            break;
          }
          if (player.sleeping) {
            ws.send('你已经在睡觉了。\n>');
            break;
          }
          player.sleeping = true;
          player.sleepStartTime = Date.now();
          ws.send('你往床上一倒，沉沉睡去......\n');
          setTimeout(() => {
            if (player && player.sleeping) {
              player.sleeping = false;
              player.hp = player.maxHp;
              player.jingli = player.maxJingli ?? 100;
              let wakeMsg;
              if (player.hp >= player.maxHp * 0.8) {
                wakeMsg = '一觉醒来，你感到神清气爽';
              } else if (player.hp >= player.maxHp * 0.5) {
                wakeMsg = '一觉醒来，你感觉身体恢复了不少';
              } else {
                wakeMsg = '一觉醒来，你感觉腰酸背痛';
              }
              ws.send(wakeMsg + '。\n【当前】HP: ' + player.hp + '/' + player.maxHp + '\n>');
              saveProgress();
            }
          }, 20000);
          break;

        case 'retreat':
        case '闭关':
          if (!['练功房', '华山练功房', '少林练功房', '思过崖', '方丈室'].includes(player.room)) {
            ws.send('这里心神纷杂，不是闭关的好地方。\n>');
            break;
          }
          if (player.retreating) {
            ws.send('你已经在闭关中了。\n>');
            break;
          }
          if ((player.drunk || 0) >= 20) {
            ws.send('你身上酒气未散，心神难凝，此刻不宜闭关。\n>');
            break;
          }
          if (player.sleeping) {
            ws.send('你还没醒，就别想着闭关了。\n>');
            break;
          }
          const retreatArg = Number(parts[1] || 1);
          if (!Number.isInteger(retreatArg) || retreatArg <= 0 || retreatArg > 10) {
            ws.send('用法: retreat [分钟]，范围 1-10 分钟，例如 retreat 3。\n>');
            break;
          }
          if (player.hp < Math.ceil(player.maxHp * 0.5)) {
            ws.send('你气血未复，至少要在五成以上才适合闭关。\n>');
            break;
          }
          const siteBonus = getCultivationSiteBonus(player.room);
          player.retreating = true;
          player.retreatStartTime = Date.now();
          player.retreatDurationMs = retreatArg * 60 * 1000;
          player.retreatRoom = player.room;
          ws.send(`你寻了一处僻静角落，封息敛念，开始闭关 ${retreatArg} 分钟。\n【闭关宝地】${siteBonus.desc}\n闭关期间无法行动，时间一到将自动出关。\n>`);
          break;

        case 'breakretreat':
        case '出关':
          if (!player.retreating) {
            ws.send('你此刻并未闭关。\n>');
            break;
          }
          const elapsed = Date.now() - Number(player.retreatStartTime || 0);
          const total = Math.max(1, Number(player.retreatDurationMs || 0));
          const progress = Math.max(0.1, Math.min(1, elapsed / total));
          const primaryInnerSkill = getPrimaryInnerSkill(player);
          const breakSiteBonus = getCultivationSiteBonus(player.retreatRoom || player.room);
          const baseExp = Math.max(8, Math.floor((total / 60000) * 18 * progress * breakSiteBonus.exp));
          const baseMpGain = Math.max(1, Math.floor((total / 60000) * 1.1 * progress * breakSiteBonus.mp));
          const baseHpGain = Math.max(1, Math.floor(baseMpGain * 0.45 * breakSiteBonus.hp));
          const oldMaxMp = player.maxMp;
          const oldMaxHp = player.maxHp;
          player.retreating = false;
          player.retreatStartTime = 0;
          player.retreatDurationMs = 0;
          player.retreatRoom = null;
          player.exp += baseExp;
          player.maxMpBonus = Math.max(0, Number(player.maxMpBonus || 0)) + baseMpGain;
          player.maxHpBonus = Math.max(0, Number(player.maxHpBonus || 0)) + baseHpGain;
          recalculateDerivedStats(player);
          player.hp = Math.max(1, Math.floor(player.maxHp * 0.55));
          player.mp = Math.max(0, Math.floor(player.maxMp * 0.6));
          const actualMaxMpGain = player.maxMp - oldMaxMp;
          const actualMaxHpGain = player.maxHp - oldMaxHp;
          ws.send(`你强行收束真气，提前破关而出。\n【代价】气息未稳，收益只有原闭关的一部分。\n【当前收获】经验+${baseExp}，MP上限+${actualMaxMpGain}，HP上限+${actualMaxHpGain}\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} 主修内功:${primaryInnerSkill.name}\n>`);
          broadcastRetreatBreakthrough(player, player.room, 'backlash');
          saveProgress();
          break;
        
        case 'hp':
        case 'status':
        case '状态':
          ws.send(formatOutput(player, player.room));
          break;

        case 'breakthrough':
        case '破境':
          const breakthroughInfo = canBreakthroughRealm(player);
          if (!breakthroughInfo.req) {
            ws.send('你当前修为尚浅，还未到需要专门破境的时候。\n>');
            break;
          }
          if (!breakthroughInfo.ok) {
            const roomNeedMsg = breakthroughInfo.req.requiredRoom ? `，地点${breakthroughInfo.req.requiredRoom}` : '';
            player.hp = Math.max(1, player.hp - Math.max(3, Math.floor(player.maxHp * 0.05)));
            player.mp = Math.max(0, player.mp - Math.max(5, Math.floor(player.maxMp * 0.08)));
            ws.send(`你尝试冲击${breakthroughInfo.req.realm}境界，却觉火候未足，真息回荡之下反受其震。\n需求: 经验${breakthroughInfo.req.minExp}，主修内功${breakthroughInfo.req.minMastery}级${roomNeedMsg}\n当前: 经验${player.exp}，${breakthroughInfo.primaryInnerSkill.name}${breakthroughInfo.primaryInnerSkill.level}级，所在${player.room}\n【反噬】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp}\n>`);
            saveProgress();
            break;
          }
          player.exp += Math.floor(breakthroughInfo.req.minExp * 0.08);
          ws.send(`你凝神聚气，终于成功稳住${breakthroughInfo.req.realm}境界的门槛，体内真息更见圆融。\n【境界】当前已可稳固于${getCultivationRealm(player)}\n>`);
          const roomMates = Object.values(players).filter(p => p.room === player.room && p.name !== player.name);
          for (const mate of roomMates) {
            if (onlinePlayers[mate.name]) onlinePlayers[mate.name].send(`【江湖】${player.name}盘膝良久，忽然衣袂无风自动，似是成功破境！\n>`);
          }
          saveProgress();
          break;

        case 'balance':
        case '平衡':
          normalizeCombatState(player);
          ws.send(getBalanceSummary(player) + '\n>');
          break;
        
        case 'go':
        case '走':
        case '观测':
        case '出海':
        case '船头':
        case '甲板':
        case '船舱':
        case '继续':
        case '航行':
        case '进港':
        case '仓库':
        case '地下':
        case '深入':
        case '电梯':
        case '观测':
        case '祭坛':
        case '桃花岛':
        case '返回':
        case '竹林':
        case '进入':
        case '东南':
        case '西北':
        case '东北':
        case '西南':
        case '进城':
        case '离城':
        case '东郊':
        case '凤栖':
          player.following = null;
          let goArgs = args || cmd;
          // 出海指令特殊处理：只有在水边才能出海
          if (cmd === '出海') {
            if (player.room === '扬州码头') {
              goArgs = '上船';
            } else if (player.room === '枫林渡口') {
              goArgs = '登船';
            } else {
              ws.send('你必须先前往扬州码头才能出海。\n>');
              break;
            }
          }
          const r = getRoom(player.room);
          // 支持直接输入房间名导航
          if (!r.exits[goArgs]) {
            // 尝试在所有出口中查找匹配（更宽松的匹配）
            for (const [dir, targetRoom] of Object.entries(r.exits)) {
              // 匹配出口方向关键词或目标房间名
              if (targetRoom.includes(goArgs) || dir === goArgs || goArgs.includes(dir) || dir.includes(goArgs)) {
                goArgs = dir;
                break;
              }
            }
          }
          if (r && r.exits[goArgs]) {
            broadcastRoomDeparture(player.name, player.room, 'player');
            player.room = r.exits[goArgs];
            saveProgress();
            broadcastRoomArrival(player, player.room);
            ws.send(formatOutputBrief(player, '你走进了' + player.room));
          } else {
            const exits = r ? Object.keys(r.exits).join(',') : '';
            ws.send('你找不到这个方向的路。可用: ' + exits);
          }
          break;

        case 'board':
        case '登船':
          if (player.room === '扬州码头') {
            broadcastRoomDeparture(player.name, player.room, 'player');
            player.room = '远洋客轮甲板';
            saveProgress();
            broadcastRoomArrival(player, player.room);
            ws.send('你登上了远洋客轮...\n\n' + formatOutputBrief(player, player.room));
          } else if (player.room === '枫林渡口') {
            broadcastRoomDeparture(player.name, player.room, 'player');
            player.room = '凤栖城码头';
            saveProgress();
            broadcastRoomArrival(player, player.room);
            ws.send('你登上渡船，前往凤栖城...\n\n' + formatOutputBrief(player, player.room));
          } else if (args === 'ship' && player.room === '扬州码头') {
            broadcastRoomDeparture(player.name, player.room, 'player');
            player.room = '远洋客轮甲板';
            saveProgress();
            broadcastRoomArrival(player, player.room);
            ws.send('你登上了远洋客轮...\n\n' + formatOutputBrief(player, player.room));
          } else {
            ws.send('这里没有船可以登。\n>');
          }
          break;
        
        case 'n':
        case 'north':
        case '北':
          if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; }
          player.following = null;
          if (movePlayer(player, '北')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向北走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send((player.lastMoveFailReason || ('北边没有路。可用: ' + exits)) + '\n>'); } break;
        case 's':
        case 'south':
        case '南':
          if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; }
          player.following = null;
          if (movePlayer(player, '南')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向南走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send((player.lastMoveFailReason || ('南边没有路。可用: ' + exits)) + '\n>'); } break;
        case 'e':
        case 'east':
        case '东':
          if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; }
          player.following = null;
          if (movePlayer(player, '东')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向东走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send((player.lastMoveFailReason || ('东边没有路。可用: ' + exits)) + '\n>'); } break;
        case 'w':
        case 'west':
        case '西':
          if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; }
          player.following = null;
          if (movePlayer(player, '西')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向西走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send((player.lastMoveFailReason || ('西边没有路。可用: ' + exits)) + '\n>'); } break;
        case 'u':
        case 'up':
        case '上': if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; } player.following = null; if (movePlayer(player, '上')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向上走去')); } else ws.send('上面没有路。'); break;
        case 'd':
        case 'down':
        case '下': if (player.meditating) { ws.send('你正在打坐运功，不能移动。\n>'); break; } player.following = null; if (movePlayer(player, '下')) { saveProgress(); broadcastRoomArrival(player, player.room); ws.send(formatOutputBrief(player, '你向下走去')); } else ws.send('下面没有路。'); break;

        case 'eat':
        case 'drink':
        case '使用':
        case '喝':
          if (!args) {
            ws.send('请输入物品名。\n>');
            break;
          }
          if (cmd === 'drink' || cmd === '喝') {
            const drink = drinkItems[args];
            if (!drink) {
              ws.send('这东西不是能直接喝的酒。\n>');
              break;
            }
            if (!player.inventory.includes(args)) {
              ws.send(`你背包里没有${args}。\n>`);
              break;
            }
            const now = Date.now();
            decayDrunkValue(player, now);
            const remainingDrinkCd = Math.max(0, Number(drink.cooldown || 0) - (now - Number(player.lastDrinkAt || 0)));
            if (remainingDrinkCd > 0) {
              ws.send(`你酒气翻涌，暂时不宜再饮。还需 ${(remainingDrinkCd / 1000).toFixed(1)} 秒。\n>`);
              break;
            }
            if ((player.drunk || 0) >= 100) {
              ws.send('你已经醉得不省人事，再灌下去怕是要出事。\n>');
              break;
            }
            const beforeStage = getDrunkStage(player);
            player.inventory = player.inventory.filter((item, index) => !(item === args && index === player.inventory.indexOf(args)));
            player.hp = Math.min(player.maxHp, player.hp + (drink.hp || 0));
            player.mp = Math.min(player.maxMp, player.mp + (drink.mp || 0));
            player.jingli = Math.min(player.maxJingli ?? 100, (player.jingli ?? 100) + (drink.jingli || 0));
            player.drunk = Math.min(120, Number(player.drunk || 0) + Number(drink.drunkValue || 0));
            player.lastDrinkAt = now;
            player.lastDrinkDecayAt = now;
            let extraMsg = '';
            if (drink.buff) {
              player.drinkBuffs = {
                source: args,
                atk: drink.buff.atk || 0,
                crit: drink.buff.crit || 0,
                hit: drink.buff.hit || 0,
                dodge: drink.buff.dodge || 0,
                expiresAt: now + (drink.buff.durationMs || 180000)
              };
              extraMsg += `\n【酒劲】一股烈意直冲胸臆，暂时获得额外战意。`;
            }
            if (drink.insightChance && Math.random() < drink.insightChance) {
              const expGain = Number(drink.expBonus || 3);
              player.exp += expGain;
              extraMsg += `\n✨【酒意灵光】你胸中忽生一线明悟，经验+${expGain}。`;
            }
            const drunkStage = getDrunkStage(player);
            if (player.drunk >= 100) {
              player.fainted = true;
              player.faintTime = now;
              extraMsg += '\n☠️【醉倒】你只觉天旋地转，眼前一黑，当场醉倒在地。';
              broadcastRoomAction(player, getPassOutWitnessText(player));
            }
            recalculateDerivedStats(player);
            saveProgress();
            broadcastRoomAction(player, getDrinkWitnessText(player, args, beforeStage, drunkStage));
            maybeBroadcastDrunkNpcReaction(player);
            maybeBroadcastDrinkEasterEgg(player, args);
            ws.send(`你仰头饮下${args}，${drink.selfFlavor || drink.desc}${extraMsg}\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} STA:${player.jingli}/${player.maxJingli} 酒意:${drunkStage.label}(${Math.max(0, Math.floor(player.drunk || 0))}/100)\n>`);
            break;
          }
          if (args === 'drug' || args === '金创药') {
            if (player.inventory.includes('金创药')) {
              const hp恢复 = Math.floor(player.maxHp * 0.1);
              player.hp = Math.min(player.maxHp, player.hp + hp恢复);
              player.inventory = player.inventory.filter(i => i !== '金创药');
              saveProgress();
              ws.send(`金创药使用成功，HP恢复${hp恢复}。\n【当前】HP: ${player.hp}/${player.maxHp}\n>`);
            } else {
              ws.send('你背包里没有金创药。\n>');
            }
          } else {
            ws.send('无法使用此物品。\n>');
          }
          break;

        case 'mount':
        case '装备':
          if (!args) {
            ws.send('请输入装备名称。\n>');
            break;
          }
          if (args === 'blade' || args === '大片刀') {
            if (player.inventory.includes('大片刀')) {
              player.weapon = '大片刀';
              saveProgress();
              ws.send('大片刀装备成功！攻击力+30\n>');
            } else {
              ws.send('你背包里没有大片刀。\n>');
            }
          } else if (args === '散弹枪') {
            if (player.inventory.includes('散弹枪')) {
              player.weapon = '散弹枪';
              saveProgress();
              ws.send('散弹枪装备成功！输入 shoot [玩家名] 射击。\n>');
            } else {
              ws.send('你背包里没有散弹枪。\n>');
            }
          } else {
            ws.send('无法装备此物品。\n>');
          }
          break;

        case 'shoot':
        case '射击':
          if (!args) {
            ws.send('请输入射击目标。\n>');
            break;
          }
          if (player.weapon !== '散弹枪') {
            ws.send('你没有装备散弹枪。\n>');
            break;
          }
          if (!player.weaponAmmo || player.weaponAmmo <= 0) {
            ws.send('散弹枪弹药已用尽！\n>');
            break;
          }
          const target = Object.values(players).find(p => p.name === args && p.room === player.room && p.name !== player.name);
          if (!target) {
            ws.send('这里没有这个玩家。\n>');
            break;
          }
          const dmg = 500;
          target.hp -= dmg;
          player.weaponAmmo -= 1;
          if (target.hp < 5) {
            target.fainted = true;
            target.faintTime = Date.now();
            target.hp = 1;
            ws.send('你瞄准' + target.name + '开了一枪！-' + dmg + 'HP\n' + target.name + '倒在地上，晕了过去。\n剩余弹药: ' + player.weaponAmmo + '\n>');
            if (onlinePlayers[target.name]) {
              onlinePlayers[target.name].send('你眼前一黑，没有了任何知觉......\n>');
            }
          } else {
            ws.send('你瞄准' + target.name + '开了一枪！-' + dmg + 'HP\n' + target.name + ' HP: ' + target.hp + '/' + target.maxHp + '\n剩余弹药: ' + player.weaponAmmo + '\n>');
            if (onlinePlayers[target.name]) {
              onlinePlayers[target.name].send('【警告】' + player.name + '用散弹枪射击了你！-' + dmg + 'HP\n【当前】HP: ' + target.hp + '/' + target.maxHp + '\n>');
            }
          }
          if (player.weaponAmmo <= 0) {
            player.weapon = null;
            player.inventory = player.inventory.filter(i => i !== '散弹枪');
            ws.send('散弹枪弹药已用尽，武器已销毁。\n>');
          }
          saveProgress();
          break;

        case 'skills':
        case 'performs':
          if (args && masters[args]) {
            if (!isSameMaster(args, player.master)) {
              ws.send('你只能查看自己师傅传授的武功。\n>');
              break;
            }
            const teacherInRoom = (getRoom(player.room)?.npcs || []).find(npcName => isSameMaster(npcName, args)) || args;
            const learnable = getLearnableSkillsForMaster(teacherInRoom);
            const lines = learnable.map(name => {
              const alias = skillEnglishNames[name] || '';
              return `${name}（${alias}） (${getMasterSkillCap(teacherInRoom, name)}级) - ${skillDb[name]?.desc || '武学'} [learn:${name}:${teacherInRoom}]`;
            });
            ws.send(`【${getMasterDisplayName(teacherInRoom)}】可传授武功:\n${lines.join('\n')}\n\n可输入 learn [武功名] from ${teacherInRoom} 当面学习\n>`);
            break;
          }
          let skillMsg = '\n【技能】\n';
          const conflictPenalty = getNeigongConflictPenalty(player);
          skillMsg += `修炼境界: ${getCultivationRealm(player)}\n`;
          skillMsg += `主修内功: ${getPrimaryInnerSkill(player).name}\n`;
          skillMsg += `学文识字: ${getSkillLevel(player, '学文识字')}级\n`;
          const breakthrough = canBreakthroughRealm(player);
          if (breakthrough.req) {
            skillMsg += `破境条件: ${breakthrough.req.realm} 需经验${breakthrough.req.minExp}、主修内功${breakthrough.req.minMastery}级`;
            if (breakthrough.req.requiredRoom) skillMsg += `、地点${breakthrough.req.requiredRoom}`;
            skillMsg += ` (${breakthrough.ok ? '已满足' : '未满足'})\n`;
          }
          if (conflictPenalty.percent > 0) {
            skillMsg += `内功冲突: -${conflictPenalty.percent}% (${conflictPenalty.desc})\n\n`;
          } else {
            skillMsg += `内功冲突: 无 (${conflictPenalty.desc})\n\n`;
          }
          for (const [name, sk] of Object.entries(player.skills)) {
            const nextNeed = getSkillLearnNeed(Math.max(1, Number(sk.level || 0) + 1));
            const alias = skillEnglishNames[name] || '';
            const teacher = getDefaultLearningTeacher(player, name);
            const learnLink = teacher ? ` [learn:${name}:${teacher}]` : '';
            skillMsg += `${name}（${alias}）: ${sk.level}级 (经验: ${sk.exp || 0}, 研习: ${sk.learnProgress || 0}/${nextNeed})${learnLink}\n`;
          }
          skillMsg += `\nSTA: ${player.jingli ?? 100}/${player.maxJingli ?? 100}\n`;
          const performs = Object.entries(schoolPerformDb[player.school] || {});
          if (performs.length) {
            skillMsg += '\n【可用绝招】\n';
            for (const [name, info] of performs) {
              const level = getSkillLevel(player, info.skill);
              const unlocked = level >= info.minLevel && player.exp >= info.minExp;
              skillMsg += `${name} | 依托:${info.skill} | 需求:${info.minLevel}级/${info.minExp}经验 | 消耗:${info.mpCost}MP | ${unlocked ? '可施展' : '未解锁'}\n`;
            }
            skillMsg += '\n输入 perform 绝招名 目标名 施展绝招\n';
          }
          skillMsg += '\n输入 learn [技能名] 学习新技能\n';
          skillMsg += '输入 skills [师父名] 查看该师父可传授武功\n';
          ws.send(skillMsg + '\n>');
          break;

        case 'learn':
          if (args) {
            const fromMatch = args.match(/^(.+?)\s+from\s+(.+)$/i);
            const rawSkill = fromMatch ? fromMatch[1].trim() : args.trim();
            const teacherArg = fromMatch ? fromMatch[2].trim() : null;
            const skillName = skillAliases[rawSkill] || rawSkill;
            if (!skillDb[skillName]) {
              ws.send('请输入正确的技能名。可用技能: ' + Object.keys(skillDb).join(', ') + '\n>');
              break;
            }
            const source = getLearningSource(player, skillName, teacherArg);
            const err = canLearnSkill(player, skillName, source);
            if (err) {
              ws.send(err + '\n>');
              break;
            }
            const result = applyLearnSkill(player, skillName, source);
            saveProgress();
            ws.send(result + '\n>');
          } else {
            ws.send('用法: learn [技能名] 或 learn [技能名] from [师父名]\n>');
          }
          break;

        case 'meditate':
        case '打坐信息':
          const meditationInfo = getMeditationProgress(player);
          if (meditationInfo.cap <= 0) {
            ws.send('你尚未练成基本内功，暂时还感知不到打坐积累。\n>');
            break;
          }
          const meditationCooldown = getMeditationCooldownMs(player);
          const meditationRemaining = Math.max(0, meditationCooldown - (Date.now() - Number(player.lastMeditationAt || 0)));
          ws.send(`【打坐进境】\n基本内功限制的MP加成上限: ${meditationInfo.cap}\n当前MP上限加成: ${meditationInfo.maxMpBonus}\n当前HP上限加成: ${meditationInfo.maxHpBonus}\n当前进度: ${meditationInfo.percent}%\n当前调息间隔: ${(meditationCooldown / 1000).toFixed(1)}秒\n剩余冷却: ${(meditationRemaining / 1000).toFixed(1)}秒\n提示: train [气血|max] 或 dazuo [气血|max] 可继续修炼。\n>`);
          break;

        case 'train':
        case 'dazuo':
          const isTrainRoom = ['练功房', '华山练功房', '少林练功房'].includes(player.room);
          if (isTrainRoom) {
            const now = Date.now();
            const cooldownMs = getMeditationCooldownMs(player);
            const remainingCooldown = Math.max(0, cooldownMs - (now - Number(player.lastMeditationAt || 0)));
            if (remainingCooldown > 0) {
              ws.send(`你刚运功收势，气息尚未平复，还需再等${(remainingCooldown / 1000).toFixed(1)}秒。\n>`);
              break;
            }
            const hpArg = (parts[1] || '').toLowerCase();
            if (player.hp < Math.ceil(player.maxHp * 0.1)) {
              ws.send('你气血已不足一成，强行打坐恐走火入魔，无法继续修炼。\n>');
              break;
            }
            const safeHpFloor = Math.ceil(player.maxHp * 0.1);
            const maxSpendableHp = Math.max(0, player.hp - safeHpFloor);
            if (maxSpendableHp <= 0) {
              ws.send('你现在的气血太低，至少要保留一成气血才能打坐。\n>');
              break;
            }
            let hpCost;
            if (hpArg === 'max' || hpArg === '最大') {
              hpCost = maxSpendableHp;
            } else {
              const hpCostRaw = Number(parts[1]);
              if (!Number.isInteger(hpCostRaw) || hpCostRaw <= 0) {
                ws.send('用法: train [消耗气血|max]，例如 train 50 或 train max。dazuo 与 train 同义。\n>');
                break;
              }
              hpCost = Math.min(hpCostRaw, maxSpendableHp);
            }
            const basicInnerSkillLevel = getSkillLevel(player, '基本内功');
            if (basicInnerSkillLevel <= 0) {
              ws.send('你尚未掌握基本内功，贸然打坐只会徒耗气血。\n>');
              break;
            }
            if ((player.drunk || 0) >= 50) {
              ws.send('你酒意上头，经脉浮荡，此刻不宜打坐运功。\n>');
              break;
            }
            const oldHp = player.hp;
            const oldMp = player.mp;
            const oldMaxMp = player.maxMp;
            const oldMaxHp = player.maxHp;
            const oldTitle = player.title;
            const primaryInnerSkill = getPrimaryInnerSkill(player);
            const meditationCap = getMeditationBonusCap(player);
            const currentBonuses = getMeditationBonuses(player);
            const remainingMpBonusCapacity = Math.max(0, meditationCap - currentBonuses.maxMpBonus);
            const progressRatio = meditationCap > 0 ? currentBonuses.maxMpBonus / meditationCap : 1;
            let styleMultiplier = 1;
            let hpToMpRecoverRate = 0.22;
            let hpBonusRate = 0.45;
            switch (primaryInnerSkill.name) {
              case '北冥神功':
                styleMultiplier = 1.12;
                hpToMpRecoverRate = 0.28;
                hpBonusRate = 0.38;
                break;
              case '易筋经':
                styleMultiplier = 0.92;
                hpToMpRecoverRate = 0.2;
                hpBonusRate = 0.6;
                break;
              case '紫霞神功':
                styleMultiplier = 1.05;
                hpToMpRecoverRate = 0.24;
                hpBonusRate = 0.42;
                break;
              case '九阳神功':
                styleMultiplier = 1.18;
                hpToMpRecoverRate = 0.3;
                hpBonusRate = 0.48;
                break;
              case '九阴真经':
                styleMultiplier = 1.02;
                hpToMpRecoverRate = 0.22;
                hpBonusRate = 0.52;
                break;
            }
            const diminishingFactor = Math.max(0.2, 1 - progressRatio * 0.75);
            const rawMpBonusGain = Math.floor((Math.sqrt(hpCost) * (1.6 + basicInnerSkillLevel * 0.08) + hpCost * 0.03) * diminishingFactor * styleMultiplier);
            let mpBonusGain = Math.min(
              remainingMpBonusCapacity,
              Math.max(1, rawMpBonusGain)
            );
            let hpBonusGain = Math.max(0, Math.floor(mpBonusGain * hpBonusRate));
            let expGain = Math.max(3, Math.floor(hpCost * 0.32) + Math.floor(basicInnerSkillLevel / 5));
            let mpRecover = Math.max(1, Math.floor(hpCost * hpToMpRecoverRate) + Math.floor(basicInnerSkillLevel * 0.35));

            player.hp = Math.max(0, player.hp - hpCost);
            const meditationEvent = rollMeditationEvent(player, hpCost, primaryInnerSkill.name);
            if (meditationEvent?.type === 'insight') {
              mpBonusGain = Math.min(remainingMpBonusCapacity, mpBonusGain + meditationEvent.bonusMp);
              hpBonusGain += meditationEvent.bonusHp;
              expGain += meditationEvent.bonusExp;
            }
            const conflictPenalty = getNeigongConflictPenalty(player);
            if (conflictPenalty.percent > 0) {
              mpBonusGain = Math.max(1, Math.floor(mpBonusGain * (1 - conflictPenalty.percent / 100)));
              hpBonusGain = Math.max(1, Math.floor(hpBonusGain * (1 - conflictPenalty.percent / 120)));
              expGain = Math.max(3, Math.floor(expGain * (1 - conflictPenalty.percent / 140)));
            }
            player.maxMpBonus = currentBonuses.maxMpBonus + mpBonusGain;
            player.maxHpBonus = currentBonuses.maxHpBonus + hpBonusGain;
            player.exp += expGain;

            const neigongSkill = ['基本内功', '紫霞神功', '易筋经', '北冥神功', '九阳神功', '九阴真经'].find(name => player.skills[name]);
            if (neigongSkill) {
              player.skills[neigongSkill].exp = (player.skills[neigongSkill].exp || 0) + Math.max(6, Math.floor(hpCost * 0.22));
              if (player.skills[neigongSkill].exp >= player.skills[neigongSkill].level * 28) {
                player.skills[neigongSkill].exp = 0;
                player.skills[neigongSkill].level += 1;
              }
            }

            recalculateDerivedStats(player);
            player.mp = Math.min(player.maxMp, oldMp + mpRecover + Math.floor(mpBonusGain * 0.5));
            if (meditationEvent?.type === 'backlash') {
              player.hp = Math.max(1, player.hp - meditationEvent.hpPenalty);
              player.mp = Math.max(0, player.mp - meditationEvent.mpPenalty);
            }
            player.title = getTitle(player.exp);

            const actualHpCost = oldHp - player.hp;
            const actualMpGain = player.mp - oldMp;
            const actualMaxMpGain = player.maxMp - oldMaxMp;
            const actualMaxHpGain = player.maxHp - oldMaxHp;
            const capReached = player.maxMpBonus >= meditationCap;
            const capMsg = capReached ? `\n【瓶颈】受基本内功${basicInnerSkillLevel}级所限，你的打坐收益已触及当前上限。` : `\n【进境】当前打坐上限 ${player.maxMpBonus}/${meditationCap}。`;
            const conflictMsg = conflictPenalty.percent > 0 ? `\n⚖️【冲突】${conflictPenalty.desc} 当前修炼收益折损 ${conflictPenalty.percent}%。` : '';
            const titleMsg = player.title !== oldTitle ? `\n🎉 恭喜！你的称号提升为【${player.title}】！` : '';
            const flavorMsg = getMeditationRoomFlavor(player.room, primaryInnerSkill.name);
            const eventMsg = meditationEvent?.type === 'insight'
              ? `\n✨【顿悟】${meditationEvent.message}`
              : meditationEvent?.type === 'backlash'
              ? `\n⚠️【走火】${meditationEvent.message}`
              : '';
            player.lastMeditationAt = now;
            player.meditating = true;
            player.meditationEndTime = now + Math.max(4000, Math.floor(cooldownMs * 0.75));

            saveProgress();
            ws.send(`${flavorMsg}${eventMsg}${conflictMsg}\n你盘膝打坐，搬运周天，以气血淬炼内息。此刻真气正在经脉间徐徐流转，未至功行圆满之前，你无法随意起身。\n气血-${actualHpCost}, MP+${actualMpGain}, MP上限+${actualMaxMpGain}, HP上限+${actualMaxHpGain}, 经验+${expGain}\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} 主修内功:${primaryInnerSkill.name} 境界:${getCultivationRealm(player)} 基本内功:${basicInnerSkillLevel}${capMsg}${titleMsg}\n>`);
          } else {
            let goMsg = '这里不是练功房，无法打坐修炼。\n';
            if (player.room === '客栈') goMsg += '提示: 客栈北边有练功房 (north)\n';
            else if (player.room === '华山派大厅') goMsg += '提示: 华山派大厅北边有华山练功房\n';
            else if (player.room === '少林寺大院') goMsg += '提示: 少林寺大院东边有罗汉堂，罗汉堂北边有少林练功房\n';
            ws.send(goMsg + '>');
          }
          break;

        case 'shop':
          const currentRoom = getRoom(player.room);
          if (!room || !room.shop) {
            ws.send('这里没有商店。\n>');
            break;
          }
          let shopMsg = `\n【${room.shop === 'weapon' ? '武器铺' : room.shop === 'armor' ? '防具铺' : '药店'}】\n`;
          if (room.shop === 'weapon') {
            for (const [name, w] of Object.entries(weapons)) {
              shopMsg += `${name}: ${w.damage}攻击, ${w.price}金\n`;
            }
            shopMsg += '\n输入 buy [武器名] 购买\n';
          } else if (room.shop === 'armor') {
            for (const [name, a] of Object.entries(armors)) {
              shopMsg += `${name}: ${a.defense}防御, ${a.price}金\n`;
            }
            shopMsg += '\n输入 buy [防具名] 购买\n';
          } else {
            shopMsg += '金创药: 20金 恢复50HP\n九转灵丹: 50金 恢复100HP\n内力丹: 30金 恢复30MP\n';
            shopMsg += '\n酒水请向客栈老板、老鸨等人物购买，输入 list 客栈老板 或 list 老鸨 查看。\n';
          }
          ws.send(shopMsg + '\n>');
          break;

        case 'treat':
        case '请酒':
          if (!args) {
            ws.send('用法: 请酒 玩家名\n>');
            break;
          }
          const treatResult = handleSharedDrink(player, args);
          if (treatResult === 'NO_TARGET') {
            ws.send('对方不在这里，没法同桌喝酒。\n>');
          } else if (treatResult === 'NO_MONEY') {
            ws.send('你囊中羞涩，连请一轮酒的钱都凑不出来。\n>');
          } else {
            saveProgress();
            ws.send(`你请${args}喝了一轮酒，花了20铜钱。\n>`);
          }
          break;

        case 't':
        case 'talk':
        case '对话':
          if (!args) {
            ws.send('请输入要对话的NPC名称。\n>');
            break;
          }
          const roomNow2 = getRoom(player.room);
          const roomNpcs = roomNow2?.npcs || [];
          const npcTalkName = resolveNpcName(args, roomNow2);
          if (!npcTalkName) {
            ws.send('这里没有这个NPC。\n>');
            break;
          }
          if (npcTalkName === '黑市商人') {
            ws.send('黑市商人警惕地看了看你，低声说道："想买点什么？输入 list 黑市商人 查看货物。"\n>');
          } else {
            noteNpcInteraction(npcTalkName, player, 'talk');
            const reply = await getNpcDialogue({
              npcName: npcTalkName,
              player,
              action: 'talk',
              userInput: args,
            });
            const help = getNpcSpecialHelp(npcTalkName);
            const helpText = help.length ? `\n可试指令: ${help.join(' | ')}` : '';
            const speechPrefix = getDrunkSpeechPrefix(player);
            const drunkHint = getDrunkStage(player).key === 'sober' ? '' : `\n${npcTalkName}闻到你身上淡淡酒气，不由多看了你两眼。`;
            ws.send(`${speechPrefix}和${formatNpcName(npcTalkName)}交谈了几句。\n${npcTalkName}说道：「${reply}」${drunkHint}${helpText}\n>`);
          }
          break;

        case 'ask':
          if (!args) {
            ws.send('用法: ask NPC about 话题\n>');
            break;
          }
          const askMatch = args.match(/^(.+?)\s+about\s+(.+)$/i);
          if (!askMatch) {
            ws.send('用法: ask NPC about 话题\n>');
            break;
          }
          const askNpc = resolveNpcName(askMatch[1].trim(), getRoom(player.room));
          if (!askNpc) {
            ws.send('这里没有这个NPC。\n>');
            break;
          }
          const askTopic = askMatch[2].trim();
          noteNpcInteraction(askNpc, player, 'ask', { topic: askTopic });
          ensureInvestigationProgress(player);
          if (askNpc === '老鸨' && /消息|密信|递消息/.test(askTopic) && player.questProgress.laobaoMessageQuest?.stage === 'idle') {
            ws.send('老鸨轻摇团扇，低声道：「你若真有心，不妨接下这桩“丽春院密信”。输入 quest accept 丽春院密信。」\n>');
            break;
          }
          if (askNpc === '六扇门捕头' && /码头|可疑|案|通缉/.test(askTopic) && player.questProgress.dockCaseQuest?.stage === 'idle') {
            ws.send('六扇门捕头看了你一眼，沉声道：「若你真想插手，就接下“码头疑案”。输入 quest accept 码头疑案。」\n>');
            break;
          }
          const askReply = await getNpcDialogue({
            npcName: askNpc,
            player,
            action: 'ask',
            topic: askTopic,
            userInput: args,
          });
          ws.send(`你向${formatNpcName(askNpc)}打听「${askTopic}」。\n${askNpc}摸了摸下巴，说道：「${askReply}」\n>`);
          break;

        case 'get':
        case '拾取':
          if (!args) {
            ws.send('用法: get NPC 或 get all from 尸体\n>');
            break;
          }
          const corpseMatch = args.match(/^all\s+from\s+(.+)$/i);
          if (corpseMatch) {
            const corpse = findCorpseInRoom(player.room, corpseMatch[1].trim());
            if (!corpse) {
              ws.send('这里没有这具尸体。\n>');
              break;
            }
            let lootMsg = `你俯身搜了搜${corpse.name}。\n`;
            if (corpse.coin) {
              player.coin += corpse.coin;
              lootMsg += `获得铜钱 ${corpse.coin}。\n`;
            }
            if (corpse.silver) {
              player.silver += corpse.silver;
              lootMsg += `获得白银 ${corpse.silver}。\n`;
            }
            if (corpse.gold) {
              player.gold += corpse.gold;
              lootMsg += `获得黄金 ${corpse.gold}。\n`;
            }
            if (corpse.items.length) {
              player.inventory.push(...corpse.items);
              lootMsg += `获得物品: ${corpse.items.join('、')}\n`;
            }
            if (!corpse.coin && !corpse.silver && !corpse.gold && !corpse.items.length) {
              lootMsg += '可惜这具尸体已经被搜空了。\n';
            }
            corpse.coin = 0;
            corpse.silver = 0;
            corpse.gold = 0;
            corpse.items = [];
            if (corpse.expiresAt - Date.now() > 15000) {
              corpse.expiresAt = Date.now() + 15000;
              setTimeout(() => cleanupCorpse(player.room, corpse.id), 15000);
            }
            saveProgress();
            ws.send(lootMsg + '>');
            break;
          }
          const getNpc = resolveNpcName(args, getRoom(player.room));
          if (!getNpc) {
            ws.send('这里没有这个NPC可供搜取。\n>');
            break;
          }
          const drop = ensureNpcDrop(player.room, getNpc);
          if (drop.taken) {
            ws.send(`${getNpc}身上已经被搜得干干净净了。\n>`);
            break;
          }
          let getMsg = `你在${getNpc}身上摸索了一番。\n`;
          if (drop.money > 0) {
            player.coin += drop.money;
            getMsg += `获得铜钱 ${drop.money}。\n`;
          }
          if (drop.items.length > 0) {
            for (const item of drop.items) player.inventory.push(item);
            getMsg += `获得物品: ${drop.items.join('、')}\n`;
          }
          if (drop.money <= 0 && drop.items.length === 0) {
            getMsg += '什么也没摸到。\n';
          }
          drop.taken = true;
          saveProgress();
          ws.send(getMsg + '>');
          break;

        case 'list':
          if (args === '黑市商人') {
            const blackMarketGoods = `
╔═══════════════════════════════════════╗
║        【黑市商人】货物清单            ║
╠═══════════════════════════════════════╣
║  1. 金创药    恢复HP 10%   100金币   ║
║     指令: eat drug                     ║
║  2. 大片刀    攻击力+30     150金币   ║
║     指令: mount blade                  ║
║  3. 散弹枪    攻击力500     5000金币  ║
║     指令: mount 散弹枪 + shoot        ║
║     (可发射3次，三次后消失)            ║
╚═══════════════════════════════════════╝
输入 buy [物品名] 购买\n>`;
            ws.send(blackMarketGoods);
          } else {
            const roomNow3 = getRoom(player.room);
            const listNpc = resolveNpcName(args, roomNow3);
            if (listNpc) {
              const goodsText = getNpcGoodsList(listNpc);
              if (goodsText) {
                ws.send(goodsText + '\n>');
              } else {
                ws.send(`${listNpc}眼下没有公开售卖的货物。\n>`);
              }
            } else {
              ws.send('未知的商店。\n>');
            }
          }
          break;

        case 'rumor':
        case '八卦':
          if (!args) {
            ws.send('用法: rumor NPC\n>');
            break;
          }
          const rumorNpc = resolveNpcName(args, getRoom(player.room));
          if (!rumorNpc) {
            ws.send('这里没有这个NPC。\n>');
            break;
          }
          ws.send(`你凑近${formatNpcName(rumorNpc)}，想听些风声。\n${getRumorText(rumorNpc)}\n>`);
          break;

        case 'inquire':
        case '打听':
          if (!args) {
            ws.send('用法: inquire NPC about 话题\n>');
            break;
          }
          const inquireMatch = args.match(/^(.+?)\s+about\s+(.+)$/i);
          if (!inquireMatch) {
            ws.send('用法: inquire NPC about 话题\n>');
            break;
          }
          const inquireNpc = resolveNpcName(inquireMatch[1].trim(), getRoom(player.room));
          if (!inquireNpc) {
            ws.send('这里没有这个NPC。\n>');
            break;
          }
          const inquireTopic = inquireMatch[2].trim();
          noteNpcInteraction(inquireNpc, player, 'inquire', { topic: inquireTopic, sensitive: /通缉|身份|把柄|秘密|黑市|杀|案/.test(inquireTopic) });
          ensureInvestigationProgress(player);
          const inquireReply = await getNpcDialogue({
            npcName: inquireNpc,
            player,
            action: 'inquire',
            topic: inquireTopic,
            userInput: args,
          });
          ws.send(`你向${formatNpcName(inquireNpc)}细细打听「${inquireTopic}」。\n${inquireNpc}说道：「${inquireReply}」\n>`);
          break;

        case 'buy':
          const room2 = getRoom(player.room);
          if (!args) {
            ws.send('请输入物品名。\n>');
            break;
          }

          const npcVendorMatch = findVendorForItem(player, args);
          if (npcVendorMatch) {
            const { npcName, item } = npcVendorMatch;
            const itemWeight = weapons[item.name]?.weight || armors[item.name]?.weight || 1;
            const currentWeight = calcCurrentWeight(player);
            if (currentWeight + itemWeight > player.maxWeight) {
              ws.send('负重不足！无法携带更多物品。\n>');
              break;
            }
            if (!canAffordNpcItem(player, item)) {
              ws.send(`${npcName}翻了个白眼：「钱不够，就别耽误我做生意。」\n>`);
              break;
            }
            chargeNpcItem(player, item);
            player.inventory.push(item.name);
            saveProgress();
            let extraLine = '';
            if (item.name === '扬州传闻' || item.name === '江湖密报') {
              extraLine = `\n${getRumorText(npcName, item.name)}`;
            } else if (item.name === '客房牌') {
              extraLine = '\n客栈老板把房牌往柜台上一拍：「拿好，楼上空房还热着。」';
            } else if (item.name === '简易地图') {
              extraLine = '\n镖头摊开地图点了点：「这几条路能走，红笔那段最近少去。」';
            }
            ws.send(`${npcName}笑眯眯地把${item.name}递给你：「承惠${item.price}${getCurrencyLabel(item.currency)}，下回有消息还来照顾我生意。」${extraLine}\n>`);
            break;
          }

          if (!room2 || !room2.shop) {
            ws.send('这里没人卖这个。\n>');
            break;
          }
          
          // 计算当前负重
          var currentWeight = calcCurrentWeight(player);
          
          if (room2.shop === 'weapon' && weapons[args]) {
            const itemWeight = weapons[args].weight || 0;
            if (currentWeight + itemWeight > player.maxWeight) {
              ws.send('负重不足！无法携带更多物品。\n>');
              break;
            }
            if (player.coin >= weapons[args].price) {
              player.coin -= weapons[args].price;
              player.weapon = args;
              if (!player.inventory.includes(args)) player.inventory.push(args);
              saveProgress();
              ws.send(`购买成功！\${args} 已装备。\n>`);
            } else {
              ws.send('铜钱不足！\n>');
            }
          } else if (room2.shop === 'armor' && armors[args]) {
            const itemWeight = armors[args].weight || 0;
            if (currentWeight + itemWeight > player.maxWeight) {
              ws.send('负重不足！无法携带更多物品。\n>');
              break;
            }
            if (player.coin >= armors[args].price) {
              player.coin -= armors[args].price;
              player.armor = args;
              if (!player.inventory.includes(args)) player.inventory.push(args);
              saveProgress();
              ws.send(`购买成功！\${args} 已装备。\n>`);
            } else {
              ws.send('铜钱不足！\n>');
            }
          } else if (room2.shop === 'medicine') {
            if (args === '金创药' && player.coin >= 20) {
              player.coin -= 20;
              player.hp = Math.min(player.maxHp, player.hp + 50);
              saveProgress();
              ws.send('金创药使用成功，HP恢复50。\n>');
            } else if (args === '九转灵丹' && player.coin >= 50) {
              player.coin -= 50;
              player.hp = Math.min(player.maxHp, player.hp + 100);
              saveProgress();
              ws.send('九转灵丹使用成功，HP恢复100。\n>');
            } else if (args === '内力丹' && player.coin >= 30) {
              player.coin -= 30;
              player.mp = Math.min(player.maxMp, player.mp + 30);
              saveProgress();
              ws.send('内力丹使用成功，MP恢复30。\n>');
            } else if (drinkItems[args] && player.coin >= drinkItems[args].price) {
              const item = drinkItems[args];
              const itemWeight = item.weight || 0;
              if (currentWeight + itemWeight > player.maxWeight) {
                ws.send('负重不足！无法携带更多物品。\n>');
                break;
              }
              player.coin -= item.price;
              player.inventory.push(args);
              saveProgress();
              ws.send(`购买成功！${args} 已放入背包。输入 drink ${args} 饮用。\n>`);
            } else {
              ws.send('金币不足或物品不存在。\n>');
            }
          } else if (args === '金创药' && player.room === '旧码头区' && player.coin >= 100) {
            player.coin -= 100;
            player.inventory.push('金创药');
            saveProgress();
            ws.send('购买成功！金创药已放入背包。使用 eat drug 恢复HP。\n>');
          } else if (args === '大片刀' && player.room === '旧码头区' && player.coin >= 150) {
            player.coin -= 150;
            player.weapon = '大片刀';
            if (!player.inventory.includes('大片刀')) player.inventory.push('大片刀');
            saveProgress();
            ws.send('购买成功！大片刀已装备。攻击力+30\n>');
          } else if (args === '散弹枪' && player.room === '旧码头区' && player.coin >= 5000) {
            player.coin -= 5000;
            player.weapon = '散弹枪';
            player.weaponAmmo = 3;
            if (!player.inventory.includes('散弹枪')) player.inventory.push('散弹枪');
            saveProgress();
            ws.send('购买成功！散弹枪已装备。输入 shoot [玩家名] 射击。可发射3次。\n>');
          } else if (['金创药', '大片刀', '散弹枪'].includes(args) && player.room !== '旧码头区') {
            ws.send('这里买不到这种商品。去旧码头区找黑市商人。\n>');
          } else {
            ws.send('没有这种物品。\n>');
          }
          break;

        case 'read':
        case '阅读':
          if (!args) {
            ws.send('用法: read [秘籍名/残卷名/壁画名]\n>');
            break;
          }
          const readableItem = player.inventory.find(item => item === args) || args;
          const literacyNeed = getManualLiteracyRequirement(readableItem);
          const literacyLevel = getSkillLevel(player, '学文识字');
          if (literacyNeed <= 0) {
            ws.send(`【${readableItem}】上并无可供参悟的文字。\n>`);
            break;
          }
          if (literacyLevel < literacyNeed) {
            ws.send(`你展开【${readableItem}】，只觉字迹艰深古拙，难以尽识。\n需求: 学文识字 ${literacyNeed} 级\n当前: ${literacyLevel} 级\n>`);
            break;
          }
          let readFlavor = '纸上字句渐渐分明，你对其中隐含的武学义理多了几分把握。';
          if (readableItem.includes('残卷')) readFlavor = '残卷缺页断行，你只能从只言片语中勉强拼出些许线索。';
          else if (readableItem.includes('壁画')) readFlavor = '壁上纹理与图形交错，你一边辨字，一边揣摩其中藏着的招意。';
          else if (readableItem.includes('真经') || readableItem.includes('秘籍')) readFlavor = '经页上的字句层层递进，你越读越觉其中别有洞天。';
          const readingEvent = rollReadingEvent(player, readableItem);
          let eventMsg = '';
          if (readingEvent?.type === 'misread') {
            player.jingli = Math.max(0, (player.jingli ?? player.maxJingli) - 5);
            eventMsg = `\n⚠️【误读】${readingEvent.message}`;
          } else if (readingEvent?.type === 'insight') {
            player.exp += 5;
            eventMsg = `\n✨【领悟】${readingEvent.message}`;
          } else if (readingEvent?.type === 'fragment') {
            const fragment = getManualFragments(readableItem);
            if (fragment) {
              player.manualFragments = player.manualFragments || {};
              player.manualFragments[readableItem] = Math.min(fragment.needed, Number(player.manualFragments[readableItem] || 0) + 1);
              eventMsg = `\n🧩【残页线索】${readingEvent.message} (${player.manualFragments[readableItem]}/${fragment.needed})`;
            }
          }
          ws.send(`你静下心来细读【${readableItem}】。\n${readFlavor}${eventMsg}\n【识读】学文识字 ${literacyLevel} 级，可顺利参悟此物。\n>`);
          saveProgress();
          break;

        case 'combine':
        case '拼合':
          if (!args) {
            ws.send('用法: combine [残卷名]，例如 combine 九阴真经残卷\n>');
            break;
          }
          const fragmentInfo = getManualFragments(args);
          if (!fragmentInfo) {
            ws.send('这件东西并不是可拼合的残卷。\n>');
            break;
          }
          const currentCount = Number(player.manualFragments?.[args] || 0);
          if (currentCount < fragmentInfo.needed) {
            ws.send(`你手中关于【${args}】的线索还不够。当前 ${currentCount}/${fragmentInfo.needed}。\n>`);
            break;
          }
          player.manualFragments[args] = 0;
          if (!player.inventory.includes(fragmentInfo.target)) player.inventory.push(fragmentInfo.target);
          saveProgress();
          ws.send(`你将多次所得的残页线索反复拼合，终于整理出一份较完整的【${fragmentInfo.target}】！\n>`);
          break;

        case 'i':
        case 'inventory':
          // 计算当前负重
          var weight = 0;
          player.inventory.forEach(item => {
            if (weapons[item] && weapons[item].weight) weight += weapons[item].weight;
            else if (armors[item] && armors[item].weight) weight += armors[item].weight;
          });
          // 如果有武器在手上
          if (player.weapon && weapons[player.weapon] && weapons[player.weapon].weight) {
            weight += weapons[player.weapon].weight;
          }
          // 如果有护甲在身上
          if (player.armor && armors[player.armor] && armors[player.armor].weight) {
            weight += armors[player.armor].weight;
          }
          
          let invMsg = '\n【包裹】\n';
          if (player.inventory.length === 0) {
            invMsg += '背包是空的\n';
          } else {
            invMsg += player.inventory.join(', ') + '\n';
          }
          ensureMoneyState(player);
          invMsg += '\n【负重】' + weight + '/' + player.maxWeight + '\n';
          invMsg += `【资产】${getMoneySummary(player)}\n`;
          ws.send(invMsg + '\n>');
          break;

        case 'guandan':
        case '掼蛋':
          ensureMoneyState(player);
          if (player.room !== '赌场') {
            ws.send('这里只能闻到市井烟火，没有正经牌桌。去扬州城赌场再说。\n>');
            break;
          }
          if (!args || args === 'help' || args === '规则') {
            ws.send(`【扬州赌场·简化掼蛋】
可用桌级:
- guandan 铜 100      (100-1000铜钱)
- guandan 银 1        (1-20银)
- guandan 金 1        (1-5金)

局内指令:
- guandan play 序号
- guandan pass
- guandan hand
- guandan hint
- guandan auto
- guandan quit

当前资产: ${getMoneySummary(player)}
>`);
            break;
          }
          if (args === 'list' || args === '桌子') {
            ws.send(`【扬州赌场牌桌】
铜钱小桌: 100-1000铜钱, 抽水5%, 难度普通
银两中桌: 1-20银, 抽水8%, 难度进阶
黄金大桌: 1-5金, 抽水10%, 难度高手
当前资产: ${getMoneySummary(player)}
>`);
            break;
          }
          if (args === 'rank' || args === '排行' || args === '榜') {
            const allUsers = Object.entries(users).map(([name, u]) => ({
              name,
              wins: u.guandanStats?.wins || 0,
              games: u.guandanStats?.games || 0,
              streak: u.guandanStats?.streak || 0,
              bestStreak: u.guandanStats?.bestStreak || 0,
              profitCopper: u.guandanStats?.profitCopper || 0,
            }));
            const byProfit = [...allUsers].sort((a, b) => b.profitCopper - a.profitCopper).slice(0, 10);
            let rankMsg = '【扬州赌场·掼蛋榜】\n盈利榜 Top10\n';
            byProfit.forEach((u, i) => {
              rankMsg += `${i + 1}. ${u.name} 盈利:${u.profitCopper}铜 胜场:${u.wins}/${u.games} 最佳连胜:${u.bestStreak}\n`;
            });
            rankMsg += `\n你的战绩: ${player.guandanStats.wins}胜/${player.guandanStats.games}局, 当前连胜:${player.guandanStats.streak}, 最佳连胜:${player.guandanStats.bestStreak}, 盈利:${player.guandanStats.profitCopper}铜\n>`;
            ws.send(rankMsg);
            break;
          }
          if (args === 'hand' || args === '牌' || args === '状态') {
            if (!player.guandan) ws.send('你现在不在掼蛋局中。\n>');
            else ws.send(renderGuandanTable(player.guandan, player.name));
            break;
          }
          if (args === 'hint' || args === '提示') {
            if (!player.guandan) {
              ws.send('你现在不在掼蛋局中。\n>');
            } else {
              const options = getPlayerGuandanOptions(player.guandan, player.name);
              if (!options.length) ws.send('这手牌没法压牌，建议直接 guandan pass。\n>');
              else ws.send(`荷官压低声音提醒你，推荐先出: ${formatPlay(options[0])}\n>`);
            }
            break;
          }
          if (args === 'auto' || args === '托管') {
            if (!player.guandan) {
              ws.send('你现在不在掼蛋局中。\n>');
              break;
            }
            const game = player.guandan;
            if (game.seats[game.turnIndex] !== player.name) {
              ws.send('还没轮到你出牌。\n>');
              break;
            }
            const options = getPlayerGuandanOptions(game, player.name);
            if (!options.length) {
              game.passCount += 1;
              game.turnIndex = (game.turnIndex + 1) % game.seats.length;
              while (game.ranking.includes(game.seats[game.turnIndex]) && game.ranking.length < 4) game.turnIndex = (game.turnIndex + 1) % game.seats.length;
              const out = '你把茶碗一放，示意这手不要。\n' + advanceGuandan(game, player);
              saveProgress();
              ws.send(out);
            } else {
              const chosen = options[0];
              const nextHand = removeCardsFromHand(game.hands[player.name], chosen.cards);
              game.hands[player.name] = nextHand;
              game.currentPlay = chosen;
              game.currentOwner = player.name;
              game.passCount = 0;
              let out = `你懒得细想，顺手打出 ${formatPlay(chosen)}。\n`;
              if (game.hands[player.name].length === 0 && !game.ranking.includes(player.name)) {
                game.ranking.push(player.name);
                out += '🎉 你率先出完了手牌。\n';
              }
              game.turnIndex = (game.turnIndex + 1) % game.seats.length;
              while (game.ranking.includes(game.seats[game.turnIndex]) && game.ranking.length < 4) game.turnIndex = (game.turnIndex + 1) % game.seats.length;
              const finishMsg = maybeFinishGuandanRound(player, game);
              if (finishMsg) out += finishMsg;
              else out += advanceGuandan(game, player);
              saveProgress();
              ws.send(out);
            }
            break;
          }
          if (args === 'quit' || args === '离桌') {
            if (!player.guandan) {
              ws.send('你本来就没在牌桌上。\n>');
            } else {
              player.guandan = null;
              saveProgress();
              ws.send(`你起身离开牌桌，底注不退。\n当前资产: ${getMoneySummary(player)}\n>`);
            }
            break;
          }
          if (args === 'pass' || args === '不要') {
            if (!player.guandan) {
              ws.send('你还没开局。\n>');
              break;
            }
            const game = player.guandan;
            if (game.seats[game.turnIndex] !== player.name) {
              ws.send('还没轮到你出牌。\n>');
              break;
            }
            if (!game.currentPlay) {
              ws.send('现在是新一轮，你不能过牌，得先出一手。\n>');
              break;
            }
            game.passCount += 1;
            game.turnIndex = (game.turnIndex + 1) % game.seats.length;
            while (game.ranking.includes(game.seats[game.turnIndex]) && game.ranking.length < 4) game.turnIndex = (game.turnIndex + 1) % game.seats.length;
            const out = `你摆了摆手，选择不要。\n` + advanceGuandan(game, player);
            saveProgress();
            ws.send(out);
            break;
          }
          if (args.startsWith('play ')) {
            if (!player.guandan) {
              ws.send('你还没开局。\n>');
              break;
            }
            const game = player.guandan;
            if (game.seats[game.turnIndex] !== player.name) {
              ws.send('还没轮到你出牌。\n>');
              break;
            }
            const idx = Number(args.substring(5).trim()) - 1;
            const options = getPlayerGuandanOptions(game, player.name);
            if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
              ws.send('无效序号，请重新看牌。\n>' );
              break;
            }
            const chosen = options[idx];
            const nextHand = removeCardsFromHand(game.hands[player.name], chosen.cards);
            if (!nextHand) {
              ws.send('系统发现你的手牌状态异常，这手牌打不出去。\n>');
              break;
            }
            game.hands[player.name] = nextHand;
            game.currentPlay = chosen;
            game.currentOwner = player.name;
            game.passCount = 0;
            let out = `你打出 ${formatPlay(chosen)}。\n`;
            if (game.hands[player.name].length === 0 && !game.ranking.includes(player.name)) {
              game.ranking.push(player.name);
              out += '🎉 你率先出完了手牌。\n';
            }
            game.turnIndex = (game.turnIndex + 1) % game.seats.length;
            while (game.ranking.includes(game.seats[game.turnIndex]) && game.ranking.length < 4) game.turnIndex = (game.turnIndex + 1) % game.seats.length;
            const finishMsg = maybeFinishGuandanRound(player, game);
            if (finishMsg) out += finishMsg;
            else out += advanceGuandan(game, player);
            saveProgress();
            ws.send(out);
            break;
          }
          if (player.guandan) {
            ws.send('你已经在牌桌上了，输入 guandan hand 查看局面。\n>');
            break;
          }
          const parts2 = args.split(/\s+/);
          const currency = parts2[0];
          const stake = Number(parts2[1]);
          const tier = getGuandanTierInfo(currency);
          if (!tier || !Number.isFinite(stake)) {
            ws.send('开局格式不对。示例: guandan 铜 100 / guandan 银 1 / guandan 金 1\n>');
            break;
          }
          if (stake < tier.min || stake > tier.max) {
            ws.send(`${tier.label} 底注范围是 ${tier.min}-${tier.max}${currency}。\n>`);
            break;
          }
          if (!canAffordStake(player, currency, stake)) {
            ws.send(`你身上钱不够。当前资产: ${getMoneySummary(player)}\n>`);
            break;
          }
          spendStake(player, currency, stake);
          player.guandan = buildGuandanState(player, currency, stake);
          saveProgress();
          ws.send(`荷官一扬手，${tier.label} 已开局，三名牌客入座。\n` + renderGuandanTable(player.guandan, player.name));
          break;

        case 'fight':
        case 'kill':
        case 'perform':
          if ((cmd === 'fight' || cmd === 'kill' || cmd === 'perform') && args) {
            const performMatch = cmd === 'perform' ? args.match(/^(.+?)\s+(?:to\s+)?(.+)$/i) : null;
            const targetName = cmd === 'perform' ? (performMatch ? performMatch[2].trim() : '') : args;
            const subject = resolveCombatSubject(player, targetName);
            if (subject?.kind === 'player') {
              const target = subject.target;
              normalizeCombatState(player);
              normalizeCombatState(target);
              let performData = null;
              let performName = null;
              if (cmd === 'perform') {
                if (!performMatch) {
                  ws.send('用法: perform 绝招名 目标名\n>');
                  break;
                }
                const found = getPerformByName(player, performMatch[1].trim());
                if (!found) {
                  ws.send('你不会这门绝招，或尚未拜入对应门派。\n>');
                  break;
                }
                [performName, performData] = found;
                const level = getSkillLevel(player, performData.skill);
                if (level < performData.minLevel || player.exp < performData.minExp) {
                  ws.send(`你的${performData.skill}火候未到，还使不出【${performName}】。\n>`);
                  break;
                }
                if (player.mp < performData.mpCost) {
                  ws.send('你的内力不足，强行运招只会伤及自身。\n>');
                  break;
                }
                player.mp -= performData.mpCost;
              }
              if (cmd === 'kill') {
                addVendetta(player, target.name);
                addVendetta(target, player.name);
              }
              const result = runPlayerVsPlayerCombat(player, target, { performData, performName });
              ws.send(result.log);
              if (onlinePlayers[target.name]) onlinePlayers[target.name].send(result.log);
              if (result.result === 'defender_dead') {
                handlePlayerDeath(target, player, onlinePlayers[target.name]);
                player.exp += 40;
                player.coin += 30;
                player.title = getTitle(player.exp);
                saveProgress();
                ws.send(`\n🏆 你击杀了${target.name}，夺得30铜钱，经验+40。\n>`);
              } else if (result.result === 'attacker_dead') {
                handlePlayerDeath(player, target, ws);
                saveProgress();
                if (onlinePlayers[target.name]) onlinePlayers[target.name].send(`\n🏆 ${target.name}击杀了你。\n>`);
              } else {
                if (player.hp <= 10) setFaintState(player);
                if (target.hp <= 10) setFaintState(target);
                saveProgress();
              }
              break;
            }
            if (subject?.kind === 'npc') {
              let performData = null;
              let performName = null;
              if (cmd === 'perform') {
                if (!performMatch) {
                  ws.send('用法: perform 绝招名 目标名\n>');
                  break;
                }
                const found = getPerformByName(player, performMatch[1].trim());
                if (!found) {
                  ws.send('你不会这门绝招，或尚未拜入对应门派。\n>');
                  break;
                }
                [performName, performData] = found;
                const level = getSkillLevel(player, performData.skill);
                if (level < performData.minLevel || player.exp < performData.minExp) {
                  ws.send(`你的${performData.skill}火候未到，还使不出【${performName}】。\n>`);
                  break;
                }
                if (player.mp < performData.mpCost) {
                  ws.send('你的内力不足，强行运招只会伤及自身。\n>');
                  break;
                }
                player.mp -= performData.mpCost;
              }
              const result = runPlayerVsNpcCombat(player, subject.target, player.room, { performData, performName });
              if (result.result === 'npc_dead') {
                const npcProfile = getNpcCombatProfile(subject.target);
                createNpcCorpse(player.room, subject.target);
                const goldGain = npcProfile.coin;
                const expGain = npcProfile.exp;
                player.coin += goldGain;
                player.exp += expGain;
                const oldTitle = player.title;
                player.title = getTitle(player.exp);
                const titleMsg = player.title !== oldTitle ? `\n🎉 恭喜！你的称号提升为【${player.title}】！` : '';
                saveProgress();
                ws.send(result.log + `
╔══════════════════════════════════════╗
║           🏆 战斗胜利  🏆              ║
╠══════════════════════════════════════╣
║  ${subject.target}横尸当场，尸体留在原地        ║
║  获得铜钱: ${goldGain}                        ║
║  获得经验: ${expGain}                        ║
╚══════════════════════════════════════╝${titleMsg}
>`);
              } else if (result.result === 'player_dead') {
                handlePlayerDeath(player, null, ws);
                saveProgress();
                ws.send(result.log + '\n>');
              } else {
                if (result.result === 'player_faint') setFaintState(player);
                saveProgress();
                ws.send(result.log + '\n>');
              }
              break;
            }
          }
          
          const room3 = getRoom(player.room);
          if (room3 && room3.npcs.length > 0) {
            const enemy = room3.npcs[Math.floor(Math.random() * room3.npcs.length)];
            const result = runPlayerVsNpcCombat(player, enemy, player.room, {});
            if (result.result === 'npc_dead') {
              const npcProfile = getNpcCombatProfile(enemy);
              createNpcCorpse(player.room, enemy);
              const goldGain = npcProfile.coin;
              const expGain = npcProfile.exp;
              player.coin += goldGain;
              player.exp += expGain;
              const oldTitle = player.title;
              player.title = getTitle(player.exp);
              const titleMsg = player.title !== oldTitle ? `\n🎉 恭喜！你的称号提升为【${player.title}】！` : '';
              saveProgress();
              ws.send(result.log + `
╔══════════════════════════════════════╗
║           🏆 战斗胜利  🏆              ║
╠══════════════════════════════════════╣
║  ${enemy}横尸当场，尸体留在原地        ║
║  获得铜钱: ${goldGain}                        ║
║  获得经验: ${expGain}                        ║
╚══════════════════════════════════════╝${titleMsg}
>`);
            } else if (result.result === 'player_dead') {
              handlePlayerDeath(player, null, ws);
              saveProgress();
              ws.send(result.log + '\n>');
            } else {
              if (result.result === 'player_faint') setFaintState(player);
              saveProgress();
              ws.send(result.log + '\n>');
            }
          } else {
            let fightHint = '这里没有敌人可以战斗。\n';
            if (player.room === '练功房' || player.room === '客栈') {
              fightHint += '提示: 扬州街北、扬州街中、扬州街南、赌场、华山派、少林寺等地有敌人\n';
            } else if (!room3 || room3.npcs.length === 0) {
              fightHint += '提示: 客栈大厅、扬州街北、扬州街中、扬州街南、赌场等地有敌人\n';
            }
            ws.send(fightHint + '>');
          }
          break;

        case 'map':
          if (!args) ws.send(mapFull);
          else if (args === '扬州' || args === '扬州城') ws.send(mapYangzhou);
          else if (args === '华山' || args === '华山派') ws.send(mapHuashan);
          else if (args === '少林' || args === '少林寺') ws.send(mapShaolin);
          else if (args === '出海') ws.send(mapSea);
          else if (args === '都市' || args === '新港城') ws.send(mapCity);
          else if (args === '凤栖' || args === '凤栖城') ws.send(mapFengqi);
          else ws.send('未知的区域，可用: 扬州、华山、少林、出海、都市、凤栖\n');
          break;

        case 'who':
        case 'players':
        case 'online':
          let whoMsg = '\n【在线玩家】\n';
          const onlineList = db.listOnlinePlayers();
          if (onlineList.length === 0) {
            whoMsg += '当前没有其他玩家在线\n';
          } else {
            for (const online of onlineList) {
              if (online.user_name !== player.name) {
                const title = users[online.user_name]?.title || '江湖人士';
                whoMsg += `【${online.user_name}】${title} 在${online.room || '未知地点'}\n`;
              }
            }
            whoMsg += `共 ${onlineList.length} 人在线\n`;
          }
          ws.send(whoMsg + '\n>');
          break;

        case 'where':
        case '在哪':
        case '位置':
          if (!args) {
            ws.send('用法: where 名称\n>');
            break;
          }
          const onlineTarget = db.listOnlinePlayers().find(p => p.user_name === args);
          if (onlineTarget) {
            ws.send(`${args}正在${onlineTarget.room || '未知地点'}。\n>`);
            break;
          }
          const npcRoom = getNpcCurrentRoom(args);
          if (npcRoom) {
            ws.send(`${args}正在${npcRoom}。\n>`);
            break;
          }
          const npcAliasMatch = Object.entries(npcCatalog).find(([name, meta]) => args === meta.alias);
          if (npcAliasMatch) {
            const npcRoomByAlias = getNpcCurrentRoom(npcAliasMatch[0]);
            if (npcRoomByAlias) {
              ws.send(`${npcAliasMatch[0]}正在${npcRoomByAlias}。\n>`);
              break;
            }
          }
          const userMatch = users[args];
          if (userMatch?.room) {
            ws.send(`${args}正在${userMatch.room}。\n>`);
            break;
          }
          ws.send('查不到这个人或NPC的位置。\n>');
          break;

        // 英雄榜系统
        case 'rank':
        case '榜单':
        case '英雄榜':
          const userKeys = Object.keys(users);
          if (userKeys.length === 0) {
            ws.send('暂无玩家数据\n>');
            break;
          }
          
          const rankType = args || '综合';
          
          // 构建玩家数据列表
          const playerList = [];
          for (const name of userKeys) {
            const u = users[name];
            if (u && typeof u === 'object') {
              playerList.push({
                name: name,
                exp: u.exp || 0,
                gold: u.gold || 0,
                wuLi: (u.外功攻击 || 0) + (u.内功攻击 || 0) + (u.防御 || 0),
                achievement: (u.achievements || []).length
              });
            }
          }
          
          let msg = '';
          if (rankType === 'exp' || rankType === '经验') {
            playerList.sort((a, b) => b.exp - a.exp);
            msg = '【江湖历练榜】Top10\n==================\n';
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              msg += `${i+1}. ${playerList[i].name}: ${playerList[i].exp}经验\n`;
            }
          } else if (rankType === 'gold' || rankType === '金钱' || rankType === '财富') {
            playerList.sort((a, b) => b.gold - a.gold);
            msg = '【江湖财富榜】Top10\n==================\n';
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              msg += `${i+1}. ${playerList[i].name}: ${playerList[i].gold}金币\n`;
            }
          } else if (rankType === 'power' || rankType === '武力' || rankType === '武力榜') {
            playerList.sort((a, b) => b.wuLi - a.wuLi);
            msg = '【江湖武力榜】Top10\n==================\n';
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              msg += `${i+1}. ${playerList[i].name}: 武力${playerList[i].wuLi}\n`;
            }
          } else if (rankType === 'quest' || rankType === '任务' || rankType === '功勋') {
            playerList.sort((a, b) => b.achievement - a.achievement);
            msg = '【江湖功勋榜】Top10\n==================\n';
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              msg += `${i+1}. ${playerList[i].name}: ${playerList[i].achievement}成就\n`;
            }
          } else if (rankType === 'me' || rankType === '我的') {
            // 查找当前玩家排名
            const myExpRank = playerList.sort((a, b) => b.exp - a.exp).findIndex(p => p.name === player.name) + 1;
            const myGoldRank = playerList.sort((a, b) => b.gold - a.gold).findIndex(p => p.name === player.name) + 1;
            const myWuLiRank = playerList.sort((a, b) => b.wuLi - a.wuLi).findIndex(p => p.name === player.name) + 1;
            msg = `【你的排名】
历练榜: 第${myExpRank}名
财富榜: 第${myGoldRank}名
武力榜: 第${myWuLiRank}名
`;
          } else if (rankType === 'detail' || rankType === '详情' || rankType === '明细') {
            // 综合榜详细数据 - 重新读取最新用户数据
            const latestUsers = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            playerList.length = 0;
            for (const name of Object.keys(latestUsers)) {
              const u = latestUsers[name];
              if (u && typeof u === 'object') {
                playerList.push({
                  name: name,
                  exp: u.exp || 0,
                  gold: u.gold || 0,
                  wuLi: (u.外功攻击 || 0) + (u.内功攻击 || 0) + (u.防御 || 0),
                  achievement: (u.achievements || []).length
                });
              }
            }
            playerList.sort((a, b) => (b.exp + b.gold * 0.1 + b.achievement * 50 + b.wuLi * 2) - (a.exp + a.gold * 0.1 + a.achievement * 50 + a.wuLi * 2));
            msg = '【江湖名人堂】详细数据\n========================\n';
            const u = latestUsers[player.name] || {};
            const myData = {
              exp: u.exp || 0,
              gold: u.gold || 0,
              wuLi: (u.外功攻击 || 0) + (u.内功攻击 || 0) + (u.防御 || 0),
              achievement: (u.achievements || []).length
            };
            const myScore = myData.exp + myData.gold * 0.1 + myData.achievement * 50 + myData.wuLi * 2;
            msg += `\n【你的详细数据】
经验: ${myData.exp}
金币: ${myData.gold}
武力: ${myData.wuLi}
成就: ${myData.achievement}
综合得分: ${myScore.toFixed(1)}
`;
            msg += '\n【Top10详细】\n';
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              const p = playerList[i];
              const score = p.exp + p.gold * 0.1 + p.achievement * 50 + p.wuLi * 2;
              msg += `${i+1}. ${p.name}: 经验${p.exp} 金币${p.gold} 武力${p.wuLi} 成就${p.achievement} = ${score.toFixed(1)}\n`;
            }
          } else {
            // 综合榜
            playerList.sort((a, b) => (b.exp + b.gold * 0.1 + b.achievement * 50 + b.wuLi * 2) - (a.exp + a.gold * 0.1 + a.achievement * 50 + a.wuLi * 2));
            msg = '【江湖名人堂】Top10\n==================\n';
            const titles = ['武林盟主', '江湖传奇', '一代宗师', '顶尖高手', '江湖侠客', '后起之秀', '初入江湖', '无名小卒', '江湖新人', '初出茅庐'];
            for (let i = 0; i < Math.min(10, playerList.length); i++) {
              const title = titles[i] || '江湖人士';
              msg += `${i+1}. ${playerList[i].name} [${title}]\n`;
            }
            msg += '\n输入 rank exp/gold/power/quest/me 查看详情\n';
          }
          
          ws.send(msg + '\n>');
          break;

        case 'follow':
        case '关注':
          if (!args || args === player.name || !users[args]) {
            ws.send('请输入正确的玩家名字。\n>');
            break;
          }
          if (!player.follows) player.follows = [];
          if (player.follows.includes(args)) {
            ws.send(`你已经在关注【\${args}】了。\n>`);
          } else {
            player.follows.push(args);
            if (!users[player.name].follows) users[player.name].follows = [];
            users[player.name].follows.push(args);
            saveUsers();
            ws.send(`你已关注【\${args}】！对方上线时会通知你。\n>`);
          }
          break;

        case 'unfollow':
        case '取消关注':
          if (!args || !player.follows || !player.follows.includes(args)) {
            ws.send(`你没有关注【\${args}】。\n>`);
          } else {
            player.follows = player.follows.filter(f => f !== args);
            users[player.name].follows = users[player.name].follows.filter(f => f !== args);
            saveUsers();
            ws.send(`已取消关注【\${args}】。\n>`);
          }
          break;

        // 私聊/公告功能
        case 'tell':
        case '私信':
          // 用法: @ 对方名字 消息
          if (!args) {
            ws.send('用法: tell 对方名字 消息\n>');
            break;
          }
          const tellParts = args.split(' ');
          const tellTarget = tellParts[0];
          const tellMsg = tellParts.slice(1).join(' ');
          if (!onlinePlayers[tellTarget]) {
            ws.send(`【${tellTarget}】不在线。\n>`);
          } else if (tellTarget === player.name) {
            ws.send('不能对自己说话。\n>');
          } else {
            const finalTellMsg = transformDrunkSpeech(player, tellMsg);
            onlinePlayers[tellTarget].send(`【私信】${player.name}对你说: ${finalTellMsg}\n>`);
            ws.send(`【私信】你对【${tellTarget}】说: ${finalTellMsg}\n>`);
          }
          break;

        case 'meme':
        case '匿名公告':
          // 耗费精力30和金币50
          if (!args) {
            ws.send('用法: meme 公告内容（耗费30精力+50金币）\n>');
            break;
          }
          if (player.气血 < 30 || player.coin < 50) {
            ws.send('精力不足30或金币不足50，无法发布公告。\n>');
            break;
          }
          player.气血 -= 30;
          player.coin -= 50;
          // 发送给所有在线玩家
          for (const [name, client] of Object.entries(onlinePlayers)) {
            client.send(`【匿名公告】\${args}\n─────────────────────\n`);
          }
          break;

        case 'say':
        case '讲话':
        case '说':
          if (!args) {
            ws.send('用法: say 你想说的话\n>');
            break;
          }
          const finalSayMsg = transformDrunkSpeech(player, args);
          broadcastRoomSpeech(player, '【闲聊】', finalSayMsg);
          ws.send(`你说道: ${finalSayMsg}\n>`);
          break;

        // @xxx 私聊功能
        case '@':
          // 用法: @对方名字 消息
          if (!args) {
            ws.send('用法: @对方名字 消息\n>');
            break;
          }
          const atParts = args.split(' ');
          const atTarget = atParts[0];
          const atMsg = atParts.slice(1).join(' ');
          if (!onlinePlayers[atTarget]) {
            ws.send(`【${atTarget}】不在线。\n>`);
          } else if (atTarget === player.name) {
            ws.send('不能对自己说话。\n>');
          } else {
            const finalAtMsg = transformDrunkSpeech(player, atMsg);
            onlinePlayers[atTarget].send(`【私信】${player.name}对你说: ${finalAtMsg}\n>`);
            ws.send(`【私信】你对【${atTarget}】说: ${finalAtMsg}\n>`);
          }
          break;

        case '@all':
        case '全体公告':
          // 耗费精力50和金币100
          if (!args) {
            ws.send('用法: @all 公告内容（耗费50精力+100金币）\n>');
            break;
          }
          if (player.气血 < 50 || player.coin < 100) {
            ws.send('精力不足50或金币不足100，无法发布全体公告。\n>');
            break;
          }
          player.气血 -= 50;
          player.coin -= 100;
          const finalAllMsg = transformDrunkSpeech(player, args);
          for (const [name, client] of Object.entries(onlinePlayers)) {
            client.send(`【全体公告】【${player.name}】${finalAllMsg}\n══════════════════════════════\n`);
          }
          break;

        case 'status':
        case '状态':
          normalizeCombatState(player);
          let statusMsg = `
╔══════════════════════════════════════╗
║     【${player.name}】${player.title}              ║
╠══════════════════════════════════════╣
║ 门派: ${player.school || '无'} 师父: ${player.master || '无'}        ║
╠══════════════════════════════════════╣
║ 【先天资质】(影响成长)                     ║
║  根骨: ${player.先天.根骨}  影响HP上限、防御        ║
║  悟性: ${player.先天.悟性}  影响技能学习、经验     ║
║  经脉: ${player.先天.经脉}  影响内力上限、MP        ║
║  福缘: ${player.先天.福缘}  影响暴击、奇遇          ║
╠══════════════════════════════════════╣
║ 【后天属性】(战斗属性)                     ║
║ HP: ${player.hp}/${player.maxHp}  MP: ${player.mp}/${player.maxMp}  STA: ${player.jingli ?? 100}/${player.maxJingli ?? 100} ║
║ 武功等级: ${getWugongLevel(player)}  内功等级: ${getNeigongLevel(player)}           ║
║ 外功攻击: ${player.外功攻击}  内功攻击: ${player.内功攻击}          ║
║ 防御: ${player.防御}  身法: ${player.身法}                    ║
╠══════════════════════════════════════╣
║ 【战斗衍生】                                ║
║ 命中: ${player.命中}%  闪避: ${player.闪避}%  暴击: ${player.暴击}%     ║
║ 酒意: ${getDrunkStage(player).label} (${Math.max(0, Math.floor(player.drunk || 0))}/100)                 ║
║ 击杀: ${player.pvpKills || 0}  死亡: ${player.deaths || 0}                ║
╠══════════════════════════════════════╣
║ 经验: ${player.exp}                                  ║
╚══════════════════════════════════════╝
`;
          statusMsg += `资产: ${getMoneySummary(player)}\n`;
          if (player.weapon) statusMsg += `武器: ${player.weapon}(攻击+${weapons[player.weapon].damage})\n`;
          if (player.armor) statusMsg += `防具: ${player.armor}(防御+${armors[player.armor].defense})\n`;
          let skillList = Object.keys(player.skills).join(', ');
          statusMsg += `技能: ${skillList || '无'}\n`;
          ws.send(statusMsg + '\n>');
          break;

        case 'follow':
          if (!args) {
            ws.send('用法: follow 玩家名\n>');
            break;
          }
          if (args === player.name) {
            ws.send('你总不能跟着自己跑。\n>');
            break;
          }
          const followTarget = players[args];
          if (!followTarget || followTarget.room !== player.room) {
            ws.send('对方不在这里，无法跟随。\n>');
            break;
          }
          player.following = followTarget.name;
          saveProgress();
          ws.send(`你决定紧跟${followTarget.name}，除非自行移动，否则会一直跟着他。\n>`);
          break;

        case 'unfollow':
          player.following = null;
          saveProgress();
          ws.send('你停下脚步，不再跟随任何人。\n>');
          break;

        case 'follows':
        case '关注列表':
          let followMsg = '\n【关注列表】\n';
          const flist = player.follows || [];
          if (flist.length === 0) {
            followMsg += '你还没有关注任何玩家。\n';
          } else {
            for (const fname of flist) {
              const isOnline = players[fname] ? '🟢在线' : '⚪离线';
              followMsg += `【${fname}】${isOnline}\n`;
            }
          }
          if (player.following) followMsg += `\n当前跟随: ${player.following}\n`;
          ws.send(followMsg + '\n>');
          break;

        case 'rebuild':
        case '废功':
          if (!args) {
            ws.send('用法: 废功 [内功名]，例如 废功 九阴真经。\n>');
            break;
          }
          if (!['九阳神功', '九阴真经', '北冥神功', '紫霞神功', '易筋经', '基本内功'].includes(args)) {
            ws.send('只能废去内功类修为。\n>');
            break;
          }
          if (!player.skills[args] || getSkillLevel(player, args) <= 0) {
            ws.send(`你并未修成【${args}】，谈不上废功。\n>`);
            break;
          }
          const lostLevel = getSkillLevel(player, args);
          player.skills[args].level = 0;
          player.skills[args].exp = 0;
          player.skills[args].learnProgress = 0;
          player.exp = Math.max(0, player.exp - lostLevel * 10);
          recalculateDerivedStats(player);
          saveProgress();
          ws.send(`你狠下心自废【${args}】${lostLevel}级修为，只觉经脉空落，功力顿失一截。\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp}\n>`);
          break;

        case 'betray':
        case '叛师':
          if (!player.master) {
            ws.send('你本就无师无门，谈不上叛师。\n>');
            break;
          }
          const oldMaster = player.master;
          const oldSchool = player.school;
          player.master = null;
          player.school = null;
          player.exp = Math.max(0, player.exp - 50);
          player.betrayUntil = Date.now() + 72 * 3600000;
          saveProgress();
          ws.send(`你决意离开【${oldSchool}】，与师父【${oldMaster}】恩断义绝。三日之内，江湖各派多半不会轻易再收你。\n>`);
          break;

        case 'baishi':
        case '拜师':
          if (!args) {
            ws.send('请输入师父名字。输入 "拜师 师父名" 拜师。\n>');
            break;
          }
          if (player.master) {
            ws.send(`你已有师父【${player.master}】，不能拜师。\n>`);
            break;
          }
          if (player.betrayUntil && Date.now() < Number(player.betrayUntil)) {
            const remainHours = Math.ceil((Number(player.betrayUntil) - Date.now()) / 3600000);
            ws.send(`你叛师余波未平，江湖中人尚有耳闻。至少还需 ${remainHours} 小时，别派才可能重新收你。\n>`);
            break;
          }
          if (!masters[args]) {
            ws.send('没有这位师父。\n>');
            break;
          }
          const master = masters[args];
          const here = getRoom(player.room);
          if (here && here.npcs.includes(args)) {
            if (player.exp >= master.requiredExp) {
              player.master = args;
              player.school = master.school;
              users[player.name].master = args;
              users[player.name].school = master.school;
              saveProgress();
              ws.send(`你正式拜【\${args}】为师！加入【${master.school}】！\n>`, saveProgress());
            } else {
              ws.send(`【\${args}】说：你经验不足(${master.requiredExp}点)，再来找我吧。\n>`);
            }
          } else {
            ws.send(`这里找不到【\${args}】。当前房间NPC: ${here ? here.npcs.join(', ') : '无'}
【提示】听闻\${args}常在${masters[args] ? masters[args].location : '某处'}。输入 find 查看更多线索。\n>`);
          }
          break;

        case 'find':
        case '寻找师父':
        case '寻找':
          // 显示所有可拜的师父
          ws.send(`【可拜师承】
华山派:
  - 岳不群 (yuebuqun): 紫霞神功, 需要100经验
  - 风清扬 (fengqingyang): 孤独九剑, 需要500经验

少林寺:
  - 方丈 (fangzhang): 易筋经, 需要100经验  
  - 玄慈 (xuanci): 易筋经, 需要100经验
  - 扫地僧 (saodisen): 北冥神功, 需要500经验

桃花岛:
  - 黄药师 (huangyaoshi): 落英神掌, 需要80经验

凤栖城(陆小凤传奇):
  - 陆小凤 (luxiaofeng): 灵犀指, 需要120经验
  - 西门吹雪 (ximenchuixue): 天外飞仙, 需要300经验

【拜师方法】
1. 前往对应地点: 
   - 华山派大厅(岳不群)
   - 思过崖(风清扬)
   - 方丈室(方丈/玄慈)
   - 藏经阁(扫地僧)
   - 桃花岛(黄药师): 扬州郊外->东->竹林->东南->桃花阵入口->东->桃花岛外->进入
   - 凤栖城(陆小凤): 扬州郊外->西->青石官道->西->枫林渡口->登船->凤栖城码头
2. 输入: 拜师 [师父名] 或 拜师 [拼音]
3. 拜师后输入: 传功 学习技能
`);
          break;

        case 'shimen':
        case '师门':
          if (!player.master) {
            ws.send('你还没有拜师。\n>');
          } else {
            const m = masters[player.master];
            ws.send(`【师门信息】
师父: ${player.master}
门派: ${player.school}
传授技能: ${m ? m.skill : '未知'}
> `);
          }
          break;

        case 'chuangong':
        case '传功':
          if (!player.master) {
            ws.send('你还没有师父，无法传功。\n>');
            break;
          }
          const cm = masters[player.master];
          if (cm && cm.skill) {
            if (player.skills[cm.skill]) {
              ws.send(`你已经学会了【${cm.skill}】。\n>`);
            } else {
              player.skills[cm.skill] = { level: 1, exp: 0 };
              saveProgress();
              ws.send(`【${player.master}】传授你【${cm.skill}】！\n>`, saveProgress());
            }
          } else {
            ws.send('你的师父没有可传授的技能。\n>');
          }
          break;

        case 'shifu':
        case '师父':
          if (!player.master) {
            ws.send('你还没有拜师。\n>');
          } else {
            const sf = masters[player.master];
            const teachList = getLearnableSkillsForMaster(player.master)
              .map(name => `${name}(${getMasterSkillCap(player.master, name)}级)`)
              .join('、');
            ws.send(`【师父信息】
师父: ${player.master}
门派: ${player.school}
传授技能: ${sf ? sf.skill : '未知'}
武学境界: ${teachList || '未知'}
说明: 输入 "skills ${player.master}" 查看详情，输入 "learn 武功名 from ${player.master}" 学习
`);
          }
          break;

        case 'quest':
        case '任务':
        case 'mission':
          ensureInvestigationProgress(player);
          if (args === 'accept 码头疑案') {
            player.quest = '码头疑案';
            player.questProgress.dockCaseQuest = { stage: 'started', clues: {}, solved: false };
            saveProgress();
            ws.send('【任务开始: 码头疑案】\n六扇门捕头要你暗中盯紧扬州码头、客栈、扬州小巷里的可疑动静。\n多去走动，多问多看，攒够线索后可向六扇门捕头回报。\n>');
            break;
          }
          if (args === 'accept 丽春院密信') {
            player.quest = '丽春院密信';
            player.questProgress.laobaoMessageQuest = { stage: 'started', clues: {}, solved: false };
            saveProgress();
            ws.send('【任务开始: 丽春院密信】\n老鸨怀疑有人借丽春院递消息。去丽春院、扬州码头、客栈多观察，拼出真正的递信人。\n之后可向老鸨回报。\n>');
            break;
          }
          if (args === 'clues' || args === '线索') {
            const dockClues = Object.values(player.questProgress.dockCaseQuest?.clues || {});
            const laobaoClues = Object.values(player.questProgress.laobaoMessageQuest?.clues || {});
            let clueMsg = '【当前线索】\n';
            clueMsg += `码头疑案: ${dockClues.length ? '\n- ' + dockClues.join('\n- ') : '暂无'}\n\n`;
            clueMsg += `丽春院密信: ${laobaoClues.length ? '\n- ' + laobaoClues.join('\n- ') : '暂无'}\n>`;
            ws.send(clueMsg);
            break;
          }
          if (args && args.startsWith('solve 码头疑案 ')) {
            const answer = args.substring('solve 码头疑案 '.length).trim();
            const clues = player.questProgress.dockCaseQuest?.clues || {};
            if (Object.keys(clues).length < 2) {
              ws.send('你掌握的线索还不够，至少再去两个地方看看。\n>');
              break;
            }
            if (answer === '情报贩子') {
              player.questProgress.dockCaseQuest.solved = true;
              player.questProgress.dockCaseQuest.stage = 'done';
              player.exp += 60;
              player.coin += 40;
              noteNpcInteraction('六扇门捕头', player, 'gift');
              saveProgress();
              ws.send('【任务完成: 码头疑案】\n你将矛头指向了情报贩子。六扇门捕头没有立刻下结论，却明显高看了你一眼。\n奖励: 经验+60 铜钱+40\n今后你向六扇门捕头打听案情时，他会更认真对待。\n>');
            } else {
              noteNpcInteraction('六扇门捕头', player, 'inquire', { topic: '误判案情', sensitive: true });
              saveProgress();
              ws.send(`【判断有误】\n你将嫌疑指向【${answer}】，六扇门捕头却皱了皱眉。\n他没有当场驳你，只冷冷说了一句：“线索还没拼明白，别急着下断语。”\n>`);
            }
            break;
          }
          if (args && args.startsWith('solve 丽春院密信 ')) {
            const answer = args.substring('solve 丽春院密信 '.length).trim();
            const clues = player.questProgress.laobaoMessageQuest?.clues || {};
            if (Object.keys(clues).length < 2) {
              ws.send('你眼下还只是听风就是雨，再多找两处线索再来。\n>');
              break;
            }
            if (answer === '客栈老板') {
              player.questProgress.laobaoMessageQuest.solved = true;
              player.questProgress.laobaoMessageQuest.stage = 'done';
              player.exp += 50;
              player.coin += 35;
              noteNpcInteraction('老鸨', player, 'gift');
              saveProgress();
              ws.send('【任务完成: 丽春院密信】\n老鸨听完你的判断，只是意味深长地笑了笑，显然把你记在心上了。\n奖励: 经验+50 铜钱+35\n今后老鸨对你说真话的概率会更高。\n>');
            } else {
              noteNpcInteraction('老鸨', player, 'inquire', { topic: '误判递信人', sensitive: true });
              saveProgress();
              ws.send(`【判断有误】\n老鸨听你报出【${answer}】，只用手帕掩嘴笑了笑：“客官这回看错人啦，不过也不算全无眼力。”\n>`);
            }
            break;
          }
          // 处理 quest accept xxx
          if (args && args.startsWith('accept ')) {
            const questName = args.substring(7);
            if (questName === '三体降临') {
              if (player.exp < 50) { ws.send('需要50点经验才能接受此任务。\n>'); break; }
              player.quest = '三体降临';
              player.questProgress = { step: 1, desc: '在粒子实验室观测异常数据', stage: 'start' };
              ws.send(`【任务开始: 三体降临】\n你接受了宇宙危机任务！\n输入 quest 继续任务\n>`);
            } else if (questName === '远洋迷雾') {
              if (player.exp < 30) { ws.send('需要30点经验才能接受此任务。\n>'); break; }
              player.quest = '远洋迷雾';
              player.questProgress = { step: 1, desc: '穿越风暴海域', stage: 'start' };
              ws.send(`【任务开始: 远洋迷雾】\n你登上了远洋客轮...\n输入 quest 继续任务\n>`);
            } else if (questName === 'ETO潜伏') {
              if (player.exp < 80) { ws.send('需要80点经验才能接受此任务。\n>'); break; }
              player.quest = 'ETO潜伏';
              player.questProgress = { step: 1, desc: '调查废弃仓库', stage: 'start' };
              ws.send(`【任务开始: ETO潜伏】\n你接受了潜伏任务！\n在旧码头区发现了一个可疑的废弃仓库，前去调查...\n输入 quest 继续任务\n>`);
            } else if (questName === '深空监听') {
              if (player.exp < 100) { ws.send('需要100点经验才能接受此任务。\n>'); break; }
              player.quest = '深空监听';
              player.questProgress = { step: 1, desc: '前往深空通讯站', stage: 'start' };
              ws.send(`【任务开始: 深空监听】\n你接受了监听任务！\n进入地下指挥中心，前往深空通讯站监听外星信号...\n输入 quest 继续任务\n>`);
            } else if (questName === '桃花岛') {
              if (player.exp < 60) { ws.send('需要60点经验才能接受此任务。\n>'); break; }
              player.quest = '桃花岛';
              player.questProgress = { step: 1, desc: '前往桃花岛', stage: 'start' };
              ws.send(`【任务开始: 桃花岛】\n你听说了桃花岛主黄药师的大名，前去拜访...\n输入 quest 继续任务\n>`);
            } else if (questName === '凤栖疑云') {
              if (player.exp < 100) { ws.send('需要100点经验才能接受此任务。\n>'); break; }
              player.quest = '凤栖疑云';
              player.questProgress = { step: 1, desc: '前往凤栖城', stage: 'start' };
              ws.send(`【任务开始: 凤栖疑云】\n你听说了凤栖城发生的一系列神秘事件，前去调查...\n输入 quest 继续任务\n>`);
            } else if (questName === '青衣楼阴谋') {
              if (player.exp < 150) { ws.send('需要150点经验才能接受此任务。\n>'); break; }
              player.quest = '青衣楼阴谋';
              player.questProgress = { step: 1, desc: '调查青衣楼', stage: 'start' };
              ws.send(`【任务开始: 青衣楼阴谋】\n你发现了江湖第一杀手组织青衣楼的秘密据点，前去调查...\n输入 quest 继续任务\n>`);
            } else if (questName === '紫禁之战') {
              if (player.exp < 200) { ws.send('需要200点经验才能接受此任务。\n>'); break; }
              player.quest = '紫禁之战';
              player.questProgress = { step: 1, desc: '前往紫禁之巅', stage: 'start' };
              ws.send(`【任务开始: 紫禁之战】\n西门吹雪与叶孤城将在紫禁之巅决战！你必须前往观战...\n输入 quest 继续任务\n>`);
            } else {
              ws.send('没有这个任务。\n>');
            }
            break;
          }
          
          if (player.quest) {
            // 检查任务是否完成
            if (player.quest === '远洋迷雾' && player.questProgress.stage === 'decode') {
              // 任务完成
              const rewardExp = 50;
              const rewardGold = 20;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 远洋迷雾】🎉

你成功解码了神秘信号，获得了来自未知文明的警告！

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "初识危机"

继续探索临海新港城，揭开更多秘密...
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('初识危机')) {
                player.achievements.push('初识危机');
              }
              saveProgress();
              break;
            }
            if (player.quest === '三体降临' && player.room === '临海新港城·中央科研区') {
              const rewardExp = 100;
              const rewardGold = 50;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 三体降临】🎉

你在中央科研区见到了神秘人，得知了更多关于"三体"文明的信息...

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "危机入门"

警告: 地球文明正面临前所未有的挑战...
输入 briefing 查看当前危机简报
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('危机入门')) {
                player.achievements.push('危机入门');
              }
              saveProgress();
              break;
            }
            // ETO潜伏任务完成
            if (player.quest === 'ETO潜伏' && player.room === 'ETO秘密基地') {
              const rewardExp = 150;
              const rewardGold = 80;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: ETO潜伏】🎉

你在ETO秘密基地发现了惊人的秘密！

原来三体文明已经锁定了地球的位置，
ETO组织正在为"他们"的到来做准备...

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "ETO知情者"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('ETO知情者')) {
                player.achievements.push('ETO知情者');
              }
              saveProgress();
              break;
            }
            // 深空监听任务完成
            if (player.quest === '深空监听' && player.room === '天文台主控室') {
              const rewardExp = 200;
              const rewardGold = 100;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 深空监听】🎉

你成功接收到了三体文明的信号！

"你们是害虫。"
"清除计划启动倒计时: 100年"

这是来自三体舰队的最后通牒！

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "面壁者"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('面壁者')) {
                player.achievements.push('面壁者');
              }
              saveProgress();
              break;
            }
            // 桃花岛任务完成
            if (player.quest === '桃花岛' && player.room === '桃花岛') {
              const rewardExp = 120;
              const rewardGold = 60;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 桃花岛】🎉

黄药师对你的资质非常满意，
决定传授你桃花岛武学！

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币
+ 习得"落英神掌"！

你获得了成就: "桃花岛门客"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('桃花岛门客')) {
                player.achievements.push('桃花岛门客');
              }
              saveProgress();
              break;
            }
            // 凤栖疑云任务完成
            if (player.quest === '凤栖疑云' && player.room === '珠光宝气阁') {
              const rewardExp = 180;
              const rewardGold = 80;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 凤栖疑云】🎉

你在珠光宝气阁调查发现，这里与青衣楼有密切关联！

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "凤栖知情者"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('凤栖知情者')) {
                player.achievements.push('凤栖知情者');
              }
              saveProgress();
              break;
            }
            // 青衣楼阴谋任务完成
            if (player.quest === '青衣楼阴谋' && player.room === '青衣楼密室') {
              const rewardExp = 250;
              const rewardGold = 120;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 青衣楼阴谋】🎉

你在青衣楼密室发现了霍休的惊天阴谋！

原来青衣楼幕后主使正是霍休，
他勾结外敌，意图颠覆江湖！

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币

你获得了成就: "青衣楼克星"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('青衣楼克星')) {
                player.achievements.push('青衣楼克星');
              }
              saveProgress();
              break;
            }
            // 紫禁之战任务完成
            if (player.quest === '紫禁之战' && player.room === '紫禁之巅') {
              const rewardExp = 300;
              const rewardGold = 150;
              player.exp += rewardExp;
              player.coin += rewardGold;
              ws.send(`【任务完成: 紫禁之战】🎉

你见证了西门吹雪与叶孤城的世纪决战！

最终，西门吹雪剑更胜一筹，
叶孤城陨落紫禁之巅。

【奖励】
+${rewardExp} 经验
+${rewardGold} 金币
+ 习得"天外飞仙"！

你获得了成就: "紫禁见证者"
`);
              player.quest = null;
              player.questProgress = {};
              player.achievements = player.achievements || [];
              if (!player.achievements.includes('紫禁见证者')) {
                player.achievements.push('紫禁见证者');
              }
              saveProgress();
              break;
            }
            ws.send(`【当前任务】${player.quest}\n进度: ${JSON.stringify(player.questProgress)}\n>`);
          } else {
            if (player.room === '粒子实验室' || player.room === '天文台' || player.room === '临海新港城·中央科研区') {
              ws.send(`【任务系统】\n可接任务:\n- 三体降临 (需50经验)\n输入 "quest accept 三体降临" 接受任务\n>`);
            } else if (player.room === '远洋客轮甲板' || player.room === '客轮船头' || player.room === '风暴海域') {
              ws.send(`【任务系统】\n可接任务:\n- 远洋迷雾 (需30经验)\n输入 "quest accept 远洋迷雾" 接受任务\n>`);
            } else if (player.room === '六扇门分署' || player.room === '六扇门捕头') {
              ws.send(`【任务系统】\n可接任务:\n- 凤栖疑云 (需100经验)\n- 青衣楼阴谋 (需150经验)\n输入 "quest accept 凤栖疑云" 或 "quest accept 青衣楼阴谋" 接受任务\n>`);
            } else if (player.room === '紫禁之巅' || player.room === '皇宫殿顶') {
              ws.send(`【任务系统】\n可接任务:\n- 紫禁之战 (需200经验)\n输入 "quest accept 紫禁之战" 接受任务\n>`);
            } else if (player.room === '桃花岛' || player.room === '桃花阵入口' || player.room === '桃花岛外') {
              ws.send(`【任务系统】\n可接任务:\n- 桃花岛 (需60经验)\n输入 "quest accept 桃花岛" 接受任务\n>`);
            } else {
              ws.send(`【任务系统】\n你还没有任务。\n特定地点可接任务:
- 六扇门分署: 凤栖疑云、青衣楼阴谋\n- 粒子实验室/天文台: 三体降临\n- 客轮甲板: 远洋迷雾\n>`);
          }
          }
          break;

        // 自动重连
        case '/reconnect':
          if (args) {
            const parts = args.split(' ');
            const reconnectName = parts[0];
            const reconnectToken = parts[1];
            const sessionRow = db.getSessionByToken(reconnectToken);
            const storedUser = db.getUser(reconnectName);
            if (reconnectName && reconnectToken && sessionRow && storedUser && sessionRow.user_name === reconnectName && sessionRow.status === 'active' && sessionRow.server_version === APP_VERSION) {
              db.touchSession(reconnectToken, ws.clientVersion || null);
              // 恢复会话
              player = restorePlayerFromStoredData(reconnectName, storedUser);
              normalizeCombatState(player);
              syncVendettaMap(player);
              players[reconnectName] = player;
              onlinePlayers[reconnectName] = ws;
              state = 'playing';
              markPlayerOnline(player, ws);
              // 生成新token
              const newToken = Math.random().toString(36).substring(2);
              users[reconnectName].sessionToken = newToken;
              saveProgress();
              // 完整欢迎消息
              const onlineCount = Object.keys(onlinePlayers).length;
              const uptime = getUptime();
              const welcomeMsg2 = '\n╔════════════════════════════════════╗\n' +
'║   欢迎' + reconnectName + '登陆武侠世界！         ║\n' +
'║   当前在线玩家: ' + onlineCount + '人               ║\n' +
'║   江湖儿女江湖老，烟雨楼台烟雨深   ║\n' +
'║   廿载凡尘磨傲骨，一片冰心在玉壶   ║\n' +
'║   世界已经运行了' + uptime.days + '天' + uptime.hours + '小时' + uptime.minutes + '分钟    ║\n' +
'╚════════════════════════════════════╝\n';
              ws.send(welcomeMsg2);
              ws.send(formatOutput(player, '欢迎回来，' + reconnectName + '！'));
              ws.send('【江湖秘术】' + reconnectName + '又回到了这个世界~');
              break;
            } else {
              ws.send('登录已过期，请重新登录。\n>');
              break;
            }
          }
          break;

        // 三体线新指令
        case 'scan':
        case 'scan sky':
        case '观测':
          if (player.room === '远洋客轮甲板' || player.room === '客轮船头' || player.room === '临海新港城·中央科研区' || player.room === '粒子实验室') {
            ws.send(`【观测天空】
你抬头观测天空...
突然，你注意到一道异常的电磁信号从深空传来！
这似乎是一个有规律的信号...不，像是某种倒计时！

获得观测数据！
输入 decode signal 解码信号
`);
            player.观测数据 = true;
            saveProgress();
          } else {
            ws.send('这里无法观测天空。\n>');
          }
          break;

        case 'decode':
        case 'decode signal':
        case '解码':
          if (player.观测数据) {
            ws.send(`【解码信号】
你开始分析那段异常信号...

"你们的行为将被观测。"
"不可回复。"

这是来自地外文明的警告！你感到一阵寒意...

突然！你的手机收到一条神秘短信：
"我知道你解码了什么。想知道更多？来临海新港城·中央科研区找我。"

任务更新: 前往临海新港城·中央科研区
输入 go 北 返回甲板
`);
            player.信号已解码 = true;
            player.questProgress = { step: 2, desc: '已解码信号，前往中央科研区', stage: 'decode' };
            player.已触发新港城剧情 = true;
            saveProgress();
          } else {
            ws.send('你没有观测数据，需要先 scan sky。\n>');
          }
          break;

        case 'briefing':
        case '简报':
          ws.send(`【危机简报 - 地球防务部】

近期，全球多个天文台收到相同的神秘信号。
经分析，这些信号来自半人马座方向。

已确认: 存在地外文明
威胁等级: 未确定

阵营选项:
1. 地球防务派 - 联合全球抵抗
2. 降临派 - 迎接外星文明
3. 生存派 - 只求自保

输入 faction join [阵营名] 加入
`);
          break;

        case 'faction':
          if (args && args.startsWith('join ')) {
            const faction = args.substring(5);
            if (faction === '地球防务派' || faction === '降临派' || faction === '生存派') {
              player.faction = faction;
              ws.send(`【加入阵营】你加入了${faction}！\n你将收到该阵营的最新情报。\n>`);
            } else {
              ws.send('无效阵营。可选: 地球防务派、降临派、生存派\n>');
            }
          } else {
            ws.send('用法: faction join [阵营名]\n可选: 地球防务派、降临派、生存派\n>');
          }
          break;

        // 趣味心跳指令
        case '/weather':
        case '/poem':
        case '/quote':
        case '/trivia':
          const tips = [
            '【江湖轶事】据说在扬州城的丽春院，常有高手出没...',
            '【江湖轶事】华山之巅常年积雪，只有真正的剑客才能登顶。',
            '【江湖轶事】凤栖城的珠光宝气阁幕后老板霍休，富甲天下。',
            '【古诗】人生得意须尽欢，莫使金樽空对月。——李白《将进酒》',
            '【古诗】醉后不知天在水，满船清梦压星河。——唐温如《题龙阳县青草湖》',
            '【古诗】桃李春风一杯酒，江湖夜雨十年灯。——黄庭坚《寄黄几复》',
            '【古诗】天下风云出我辈，一入江湖岁月催。——金庸《江湖行》',
            '【古诗】银鞍照白马，飒沓如流星。——李白《侠客行》',
            '【古诗】十步杀一人，千里不留行。——李白《侠客行》',
            '【古诗】事了拂衣去，深藏身与名。——李白《侠客行》',
            '【古诗】赵客缦胡缨，吴钩霜雪明。——李白《侠客行》',
            '【古诗】纵死侠骨香，不惭世上英。——李白《侠客行》',
            '【文学】武侠者，武为先，侠为骨。武侠精神，讲究的是路见不平，拔刀相助。',
            '【文学】江湖，是中国人的浪漫。每个人心中都有一个江湖。',
            '【文学】金庸先生笔下：侠之大者，为国为民。',
            '【文学】古龙先生笔下：人在江湖，身不由己。',
            '【天气】江湖传言：今日宜出门闯荡，不宜窝在客栈睡觉！',
            '【天气】观察天象：紫微星明亮，主大吉！',
            '【天气】夜观星象：客星犯主，江湖将有大事发生！',
            '【闲聊】江湖路远，保重身体~',
            '【闲聊】打坐练功可恢复气血内力，别忘了定期 train 一下！',
            '【闲聊】听说最近江湖不太平，出门小心为上。',
            '【闲聊】江湖儿女，当快意恩仇！',
            '【武学】修炼内功可提升内力上限，外功可提升攻击力。',
            '【武学】拜师学艺是提升实力的捷径，记得多找名师！',
          ];
          const randomTip = tips[Math.floor(Math.random() * tips.length)];
          ws.send(`\n${randomTip}\n`);
          break;

        case 'datacheck':
        case '数据检查':
          const jsonExists = fs.existsSync(usersFile);
          let jsonCount = 0;
          try {
            if (jsonExists) {
              const raw = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
              jsonCount = raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
            }
          } catch (e) {}
          const sqliteCount = db.getAllUsers().length;
          ws.send(`【数据检查】\n工作目录: ${process.cwd()}\nusers.json: ${require('path').resolve(usersFile)}\nmud.db: ${require('path').resolve('./mud.db')}\nusers.json 用户数: ${jsonCount}\nSQLite 用户数: ${sqliteCount}\n若线上老玩家丢失，请优先检查部署目录和旧数据文件是否延续。\n>`);
          break;

        case 'help':
          ws.send(`【指令帮助】
look/l - 查看房间
go/走 [方向] - 移动
n/s/e/w 或 north/south/east/west - 移动
u/d - 上/下楼梯
status/状态 - 查看状态
skills - 查看技能
learn [技能] - 学习技能
train [气血|max] / dazuo [气血|max] - 打坐修炼(消耗HP，提升MP上限并带动HP上限)
meditate / 打坐信息 - 查看当前打坐进度与上限
retreat [分钟] / 闭关 [分钟] - 闭关修炼(1-10分钟)
breakretreat / 出关 - 提前强行出关
breakthrough / 破境 - 尝试突破当前境界门槛
read [秘籍] / 阅读 [秘籍] - 阅读秘籍、残卷、壁画
combine [残卷] / 拼合 [残卷] - 拼合残页线索
废功 [内功] - 自废某门内功修为
叛师 - 退出当前师门
shop - 查看商店
buy [物品] - 购买
inventory/i - 查看包裹
drink/喝 [酒名] - 饮酒
say/说 [内容] - 与同房间的人说话
treat/请酒 [玩家名] - 请同房间玩家喝一轮酒
fight - 战斗
guandan - 扬州赌场简化掼蛋
  guandan hint/auto 可获得提示或自动打一手
map - 查看地图 (可用: 扬州/华山/少林/出海/都市/凤栖)
who/players - 在线玩家
follow/关注 [玩家] - 关注玩家
follows - 关注列表
拜师 [师父] - 拜师
寻找师父/find - 寻找附近的名师
师门/师父 - 查看师父信息
传功 - 师父传授技能
quest - 查看任务进度
find [NPC] - 寻找NPC线索
hint - 获取弱提示(卡关时使用)
datacheck - 检查 users.json / mud.db 用户数
ask NPC about 话题 - 向NPC打听消息
get NPC - 搜取NPC身上的铜钱和道具
help - 帮助
> `);
          break;

        default:
          if (!input || input.trim() === '') {
            // 空输入不返回错误，静默处理（可能是心跳）
            break;
          }
          ws.send('未知指令，输入help查看帮助。\n>');
      }
    }
  });
});

function movePlayer(player, direction) {
  const fumble = getDrunkMovementFumble(player);
  if (fumble) {
    player.lastMoveFailReason = fumble;
    return false;
  }
  player.lastMoveFailReason = '';
  const room = getRoom(player.room);
  if (room && room.exits[direction]) {
    const oldRoom = player.room;
    broadcastRoomDeparture(player.name, oldRoom, 'player');
    player.room = room.exits[direction];
    return true;
  }
  return false;
}

setInterval(() => {
  try {
    maybeTickSmartNpcs();
  } catch (error) {
    console.warn('[NPC巡游] 执行失败:', error.message);
  }
}, 60 * 1000);

app.get('/api/npc/llm-config', (req, res) => {
  res.json({
    enabled: true,
    privateConfigPath: PRIVATE_CONFIG_PATH,
    exampleConfigPath: EXAMPLE_CONFIG_PATH,
    providers: ['openai-compatible'],
    note: '请在私有配置文件中填写API信息，config/*.json 已忽略提交。'
  });
});

const wsHeartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.missedPongs = (ws.missedPongs || 0) + 1;
      if (ws.missedPongs >= WS_HEARTBEAT_MISS_LIMIT) {
        console.log(`[WebSocket心跳] 连续 ${ws.missedPongs} 次未收到 pong，主动终止连接`);
        ws.terminate();
        return;
      }
    } else {
      ws.missedPongs = 0;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch (err) {
      console.log(`[WebSocket心跳错误] ${err.message}`);
      ws.terminate();
    }
  });
}, WS_HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(wsHeartbeatTimer);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`武侠MUD已启动: http://localhost:${PORT}`);
  console.log(`[WebSocket心跳] 已启用，间隔 ${WS_HEARTBEAT_INTERVAL_MS}ms，容忍 ${WS_HEARTBEAT_MISS_LIMIT} 次丢失 pong`);
});
