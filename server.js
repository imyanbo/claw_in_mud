const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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

const APP_VERSION = db.APP_VERSION;

app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({
    frontendVersion: APP_VERSION,
    serverVersion: APP_VERSION,
    minClientVersion: APP_VERSION
  });
});

app.use(express.static('public', {
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

const importedCount = db.migrateFromJsonUsers(users);
if (importedCount > 0) {
  console.log(`Migrated ${importedCount} users from users.json into SQLite`);
}

users = Object.fromEntries(db.getAllUsers().map((user) => [user.name, user]));

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
  ws.send(`session:${session.token}`);
  ws.send(`version:${APP_VERSION}`);
  return session;
}

function restorePlayerFromStoredData(name, storedData) {
  const p = createPlayer(name);
  Object.assign(p, storedData);
  if (storedData.先天) {
    p.先天 = storedData.先天;
    p.maxHp = 100 + storedData.先天.根骨 * 10;
    p.maxMp = 50 + storedData.先天.经脉 * 5;
    p.外功攻击 = 10 + storedData.先天.根骨 * 2;
    p.防御 = 5 + Math.floor(storedData.先天.根骨 / 2);
    p.身法 = 10 + storedData.先天.悟性;
    p.命中 = 80 + storedData.先天.悟性 * 2;
    p.闪避 = 10 + Math.floor(storedData.先天.经脉 / 2);
    p.暴击 = 5 + Math.floor(storedData.先天.福缘 / 2);
    p.气血 = p.maxHp;
    p.内力 = p.maxMp;
  }
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
  '木剑': { damage: 5, price: 10, desc: '一把普通的木剑' },
  '铁剑': { damage: 15, price: 50, desc: '精铁打造的剑' },
  '长剑': { damage: 25, price: 100, desc: '锋利的长剑' },
  '屠龙刀': { damage: 80, price: 2000, desc: '武林至尊，宝刀屠龙' },
  '倚天剑': { damage: 75, price: 1800, desc: '倚天不出，谁与争锋' },
  '君子剑': { damage: 45, price: 800, desc: '华山派镇派之宝' },
  '淑女剑': { damage: 40, price: 700, desc: '华山派雌剑' }
};

const armors = {
  '布衣': { defense: 3, price: 10, desc: '普通的布衣' },
  '皮甲': { defense: 8, price: 30, desc: '皮革制成的护甲' },
  '铁甲': { defense: 15, price: 80, desc: '铁片编织的铠甲' },
  '金丝甲': { defense: 30, price: 500, desc: '刀枪不入的金丝甲' },
  '软猬甲': { defense: 35, price: 800, desc: '桃花岛至宝' }
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
  '无形剑': { type: '主动', damage: 45, desc: '青衣楼杀手的隐秘剑术' }
};

// 技能别名映射
const skillAliases = {
  "luohanquan": "罗汉拳", "太祖长拳": "太祖长拳", "伏虎拳": "伏虎拳",
  "yijinjing": "易筋经", "jiuyang": "九阳神功", "jiuyin": "九阴真经",
  "beiming": "北冥神功", "zixia": "紫霞神功", "xlongzhang": "降龙十八掌",
  "liumai": "六脉神剑", "dugu": "孤独九剑", "taiji": "太极拳",
  "luoyingshen掌": "落英神掌", "luoying": "落英神掌", "tanzhi": "弹指神通",
  "yuxiao": "玉箫剑法", "bihai": "碧海潮生曲", "wuxing": "五行八卦掌"
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

// 扬州城区域 (鹿鼎记)
const rooms = {
  '丽春院': {
    description: '扬州城内最著名的青楼，灯火通明，丝竹之声不绝。这里是韦小宝小时候长大的地方。',
    exits: { '东': '扬州街', '西': '扬州小巷' },
    npcs: ['老鸨', '春花', '秋月'],
    shop: null
  },
  '扬州街': {
    description: '扬州城最繁华的街道，两旁店铺林立，小商贩的吆喝声此起彼伏。往东可以远远望见一座新城的灯火。',
    exits: { '东': '东郊驿道', '赌场': '赌场', '西': '丽春院', '南': '扬州码头', '北': '扬州城门' },
    npcs: ['小贩', '行人', '官兵'],
    shop: null
  },
  '东郊驿道': {
    description: '扬州城东郊的驿道，向东延伸至凤栖古道。',
    exits: { '西': '扬州街', '东': '凤栖古道' },
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
    description: '扬州城内最大的赌场，乌烟瘴气，骰子声、叫喝声此起彼伏。',
    exits: { '西': '扬州街' },
    npcs: ['赌徒', '庄家'],
    shop: null
  },
  '扬州码头': {
    description: '运河边的码头，船只来来往往，货物堆积如山。远处停着一艘远洋客轮。',
    exits: { '北': '扬州街', '东': '运河', '上船': '远洋客轮甲板', '客轮': '远洋客轮甲板' },
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
    description: '一条偏僻的小巷，两边是低矮的民房。',
    exits: { '东': '丽春院', '北': '扬州城门' },
    npcs: ['流浪猫'],
    shop: null
  },
  '扬州城门': {
    description: '扬州城的北门，城门高大坚固，官兵把守严密。',
    exits: { '南': '扬州街', '北': '扬州郊外', '西': '扬州小巷' },
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
    exits: { '南': '扬州街' },
    npcs: ['铁匠'],
    shop: 'weapon'
  },
  '防具铺': {
    description: '防具铺里挂着各种护甲，角落里还有一件软猬甲。',
    exits: { '南': '扬州街' },
    npcs: ['裁缝'],
    shop: 'armor'
  },
  '药店': {
    description: '药店内弥漫着药香，柜台后摆满了各种药材。',
    exits: { '南': '扬州街' },
    npcs: ['药师'],
    shop: 'medicine'
  },
  '客栈': {
    description: '江湖客栈大厅，门口挂着两盏大红灯笼，柜台上摆着酒坛。',
    exits: { '南': '扬州街', '北': '练功房', '上': '客房' },
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
    npcs: ['扫地僧', 'saodisen', 'monk', '藏经阁长老'],
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
    exits: { '南': '少林寺大院' },
    npcs: ['方丈', 'fangzhang', 'xuanci', '玄慈'],
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
    exits: { '东': '罗汉堂' },
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
const skills = {
  '基本内功': { level: 1, exp: 0 },
  '基本拳法': { level: 1, exp: 0 },
  '基本轻功': { level: 1, exp: 0 }
};

const mapFull = `
====================【江湖全图】====================
      【少林寺】←←←←←←  【华山派】
         |                      |
   【少林寺山路】          【华山山脚】
         |                      |
    【扬州郊外】----------【扬州城】←←→【凤栖城】
                            |              |
                        【客栈】         【】
                            |
                        【扬州码头】
                              |
                      【远洋客轮甲板】→【新港外湾】→【临海新港城】

指令: map 扬州 | map 少林 | map 华山 | map 出海 | map 凤栖  查看区域地图
`;

const mapYangzhou = `
====================【扬州城区域】(鹿鼎记)====================
                    【扬州城门】
                        |
    【扬州小巷】←→【扬州街】←→【赌场】
                        |
    【丽春院】←←    |
        |         【扬州码头】←→【运河】
        |
    【客栈】(练功房/客房)
        |
【武器铺】【防具铺】【药店】
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
              【扬州街】

区域介绍:
• 迎风客栈: 江湖中人落脚之处（中心枢纽）
• 听雨楼: 情报交易场所
• 四海镖局: 护镖任务
• 六扇门分署: 官府任务

前往方式: 扬州街 -> 东 -> 凤栖城
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
  
  return {
    name,
    room: '客栈',
    hp: maxHp, maxHp: maxHp,
    mp: maxMp, maxMp: maxMp,
    exp: 0, level: 1,
    gold: 50,
    skills: JSON.parse(JSON.stringify(skills)),
    inventory: [],
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
  };
}

const onlinePlayers = {};

function getRoom(roomName) {
  return rooms[roomName] || null;
}

function getTitle(exp) {
  for (let i = titles.length - 1; i >= 0; i--) {
    if (exp >= titles[i].exp) return titles[i].title;
  }
  return titles[0].title;
}

function formatOutput(player, message) {
  let output = `\n=== ${message} ===\n\n`;
  const room = getRoom(player.room);
  if (room) {
    output += room.description + '\n';
    output += `\n出口: ${Object.keys(room.exits).join('、')}\n`;
    if (room.npcs.length > 0) {
      output += `你看到: ${room.npcs.join('、')}\n`;
    }
    if (room.shop) {
      output += `\n【店铺】输入 shop 查看商品\n`;
    }
  }
  let weaponDmg = player.weapon ? weapons[player.weapon].damage : 0;
  let armorDef = player.armor ? armors[player.armor].defense : 0;
  output += `\n【${player.name}】${player.title}\n`;
  output += `根骨:${player.先天.根骨} 悟性:${player.先天.悟性} 经脉:${player.先天.经脉} 福缘:${player.先天.福缘}\n`;
  output += `HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp}\n`;
  output += `攻击:${player.外功攻击} 防御:${player.防御} 身法:${player.身法}\n`;
  output += `经验:${player.exp} 金币:${player.gold}\n`;
  if (player.weapon || player.armor) {
    output += `装备: ${player.weapon || '无'}(攻+${weaponDmg}) ${player.armor || '无'}(防+${armorDef})\n`;
  }
  output += '\n>';
  return output;
}

wss.on('connection', (ws) => {
  let player = null;
  let state = 'welcome';
  let tempName = '';

  ws.send('\n🏯 欢迎来到【武侠世界】MUD！\n\n请选择:\n1. 登录 (login)\n2. 注册 (register)\n> ');

  ws.on('error', (err) => {
    console.log(`[WebSocket错误] ${err.message}`);
  });

  ws.on('close', () => {
    if (player && players[player.name]) {
      console.log(`[玩家断开] ${player.name}`);
      if (users[player.name]) {
        Object.assign(users[player.name], {
          exp: player.exp, level: player.level, gold: player.gold,
          skills: player.skills, hp: player.hp, mp: player.mp,
          inventory: player.inventory, weapon: player.weapon, armor: player.armor,
          follows: player.follows, master: player.master, school: player.school
        });
        saveUsers();
      }
      delete players[player.name];
      if (onlinePlayers[player.name]) delete onlinePlayers[player.name];
    }
  });

  ws.on('message', (data) => {
    const input = data.toString().trim();

    if (input.startsWith('/client_version ')) {
      ws.clientVersion = input.substring('/client_version '.length).trim();
      return;
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
        // 先创建玩家（包含随机属性）
        player = createPlayer(tempName);
        // 再从保存的数据中覆盖（确保先天资质等不丢失）
        const savedData = users[tempName];
        Object.assign(player, savedData);
        
        // 如果之前有保存先天资质，使用保存的（不重新随机）
        if (savedData.先天) {
          player.先天 = savedData.先天;
          // 重新计算后天属性
          player.maxHp = 100 + savedData.先天.根骨 * 10;
          player.maxMp = 50 + savedData.先天.经脉 * 5;
          player.外功攻击 = 10 + savedData.先天.根骨 * 2;
          player.防御 = 5 + Math.floor(savedData.先天.根骨 / 2);
          player.身法 = 10 + savedData.先天.悟性;
          player.命中 = 80 + savedData.先天.悟性 * 2;
          player.闪避 = 10 + Math.floor(savedData.先天.经脉 / 2);
          player.暴击 = 5 + Math.floor(savedData.先天.福缘 / 2);
          player.气血 = player.maxHp;
          player.内力 = player.maxMp;
        }
        
        player.title = getTitle(player.exp);
        players[tempName] = player;
        onlinePlayers[tempName] = ws;
        state = 'playing';
        
        reloadUsersFromDb();
        users[tempName] = db.getUser(tempName) || users[tempName];

        // 欢迎消息 + 在线人数 + 运行时间
        const onlineCount = Object.keys(onlinePlayers).length;
        const uptime = getUptime();
        const welcomeMsg = '\n╔════════════════════════════════════╗\n' +
'║   欢迎' + tempName + '登陆武侠世界！         ║\n' +
'║   当前在线玩家: ' + onlineCount + '人               ║\n' +
'║   江湖儿女江湖老，一片冰心在玉壶       ║\n' +
'║   世界已经运行了' + uptime.days + '天' + uptime.hours + '小时' + uptime.minutes + '分钟    ║\n' +
'╚════════════════════════════════════╝\n';
        ws.send(welcomeMsg);
        ws.send(formatOutput(player, '欢迎回来，' + tempName + '！'));
        
        const session = issueSession(tempName, ws);
        ws.send('【江湖秘术】' + tempName + '又回到了这个世界~ session:' + session.token);
        
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
        password: input, exp: 0, level: 1, gold: 50,
        skills: JSON.parse(JSON.stringify(skills)),
        hp: 100, mp: 50,
        inventory: [], weapon: null, armor: null, 
        follows: [], master: null, school: null,
        // 保存先天资质
        先天: newPlayer.先天,
        气血: newPlayer.气血,
        内力: newPlayer.内力,
        外功攻击: newPlayer.外功攻击,
        内功攻击: 0,
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
        questProgress: {}
      };
      saveUsers();
      reloadUsersFromDb();
      player = newPlayer;
      players[tempName] = player;
      onlinePlayers[tempName] = ws;
      state = 'playing';
      console.log(`[注册] ${tempName} 注册成功`);
      // 注册欢迎消息 + 在线人数
      const onlineCount = Object.keys(onlinePlayers).length;
      ws.send(`╔════════════════════════════════════╗
║   欢迎${tempName}登陆武侠世界！         ║
║   当前在线玩家: ${onlineCount}人               ║
╚════════════════════════════════════╝
`);
      const session = issueSession(tempName, ws);
      ws.send('【江湖秘术】' + tempName + '又回到了这个世界~ session:' + session.token);
      ws.send(formatOutput(player, '注册成功！江湖欢迎你'));
      return;
    }

    if (state === 'playing') {
      const parts = input.split(' ');
      const cmd = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');

      function saveProgress() {
        if (users[player.name]) {
          // 保存所有玩家数据
          Object.assign(users[player.name], {
            // 基本属性
            exp: player.exp, level: player.level, gold: player.gold,
            hp: player.hp, mp: player.mp,
            maxHp: player.maxHp, maxMp: player.maxMp,
            // 技能和装备
            skills: player.skills, 
            inventory: player.inventory, 
            weapon: player.weapon, 
            armor: player.armor,
            // 社交和师门
            follows: player.follows,
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
            // 门派声望
            门派声望: player.门派声望,
            // 成就
            achievements: player.achievements || [],
            // 三体线
            观测数据: player.观测数据,
            信号已解码: player.信号已解码,
            faction: player.faction
          });
          saveUsers();
        }
      }

      switch (cmd) {
        case 'look':
        case 'l':
          ws.send(formatOutput(player, player.room));
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
            player.room = r.exits[goArgs];
            saveProgress();
            ws.send(formatOutput(player, '你走进了' + player.room));
          } else {
            const exits = r ? Object.keys(r.exits).join(',') : '';
            ws.send('你找不到这个方向的路。可用: ' + exits);
          }
          break;

        case 'board':
        case '登船':
          if (player.room === '扬州码头') {
            player.room = '远洋客轮甲板';
            saveProgress();
            ws.send('你登上了远洋客轮...\n\n' + formatOutput(player, player.room));
          } else if (player.room === '枫林渡口') {
            player.room = '凤栖城码头';
            saveProgress();
            ws.send('你登上渡船，前往凤栖城...\n\n' + formatOutput(player, player.room));
          } else if (args === 'ship' && player.room === '扬州码头') {
            player.room = '远洋客轮甲板';
            saveProgress();
            ws.send('你登上了远洋客轮...\n\n' + formatOutput(player, player.room));
          } else {
            ws.send('这里没有船可以登。\n>');
          }
          break;
        
        case 'n':
        case 'north':
        case '北':
          if (movePlayer(player, '北')) { saveProgress(); ws.send(formatOutput(player, '你向北走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send('北边没有路。可用: ' + exits); } break;
        case 's':
        case 'south':
        case '南':
          if (movePlayer(player, '南')) { saveProgress(); ws.send(formatOutput(player, '你向南走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send('南边没有路。可用: ' + exits); } break;
        case 'e':
        case 'east':
        case '东':
          if (movePlayer(player, '东')) { saveProgress(); ws.send(formatOutput(player, '你向东走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send('东边没有路。可用: ' + exits); } break;
        case 'w':
        case 'west':
        case '西':
          if (movePlayer(player, '西')) { saveProgress(); ws.send(formatOutput(player, '你向西走去')); } else { const r = getRoom(player.room); const exits = r ? Object.keys(r.exits).join(',') : ''; ws.send('西边没有路。可用: ' + exits); } break;
        case 'u': if (movePlayer(player, '上')) { saveProgress(); ws.send(formatOutput(player, '你向上走去')); } else ws.send('上面没有路。'); break;
        case 'd': if (movePlayer(player, '下')) { saveProgress(); ws.send(formatOutput(player, '你向下走去')); } else ws.send('下面没有路。'); break;

        case 'skills':
          // 查看指定师父的技能
          if (args && masters[args]) {
            const m = masters[args];
            ws.send(`【${args}】可传授技能: ${m.skill} - ${skillDb[m.skill] ? skillDb[m.skill].desc : '绝技'}\n>`);
            break;
          }
          let skillMsg = '\n【技能】\n';
          for (const [name, sk] of Object.entries(player.skills)) {
            skillMsg += `${name}: ${sk.level}级 (经验: ${sk.exp})\n`;
          }
          skillMsg += '\n输入 learn [技能名] 学习新技能\n';
          ws.send(skillMsg + '\n>');
          break;

        case 'learn':
          if (args && (skillDb[args] || skillAliases[args])) {
            const skillName = skillAliases[args] || args;
            if (player.skills[skillName]) {
              ws.send('你已学会此技能。\n>');
            } else if (player.exp >= 50) {
              // 检查门派技能限制
              let needMaster = "";
              if (["易筋经", "北冥神功"].includes(skillName) && (!player.master || !["方丈", "玄慈", "扫地僧", "xuanci", "fangzhang", "saodisen"].includes(player.master))) {
                needMaster = "少林寺";
              } else if (["紫霞神功", "孤独九剑"].includes(skillName) && (!player.master || !["岳不群", "风清扬", "yuebuqun", "fengqingyang"].includes(player.master))) {
                needMaster = "华山派";
              }
              if (needMaster) {
                ws.send(`这是${needMaster}绝技，需要拜入${needMaster}门下才能学习。输入 "find" 查看拜师地点。\n>`);
                break;
              }
              player.skills[skillName] = { level: 1, exp: 0 };
              player.exp -= 50;
              saveProgress();
              ws.send(`恭喜学会【${args}】！消耗50经验。\n>`);
            } else {
              ws.send('经验不足，需要50点经验。\n>');
            }
          } else {
            ws.send('请输入正确的技能名。可用技能: ' + Object.keys(skillDb).join(', ') + '\n>');
          }
          break;

        case 'train':
          const isTrainRoom = ['练功房', '华山练功房', '少林练功房'].includes(player.room);
          if (isTrainRoom) {
            const expGain = 10 + Math.floor(Math.random() * 5);
            const hpGain = 10;
            const mpGain = 20;
            const oldHp = player.hp;
            const oldMp = player.mp;
            player.hp = Math.min(player.maxHp, player.hp + hpGain);
            player.mp = Math.min(player.maxMp, player.mp + mpGain);
            player.exp += expGain;
            const oldTitle = player.title;
            player.title = getTitle(player.exp);
            const actualHpGain = player.hp - oldHp;
            const actualMpGain = player.mp - oldMp;
            let titleMsg = player.title !== oldTitle ? `\n🎉 恭喜！你的称号提升为【${player.title}】！` : '';
            saveProgress();
            ws.send(`你在练功房打坐片刻，感觉内力有所增长！\nHP+${actualHpGain}, MP+${actualMpGain}, 经验+${expGain}\n【当前】HP:${player.hp}/${player.maxHp} MP:${player.mp}/${player.maxMp} 经验:${player.exp}${titleMsg}\n>`);
          } else {
            let goMsg = '这里不是练功房，无法修炼。\n';
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
          }
          ws.send(shopMsg + '\n>');
          break;

        case 'buy':
          const room2 = getRoom(player.room);
          if (!room2 || !room2.shop || !args) {
            ws.send('请输入物品名。\n>');
            break;
          }
          if (room2.shop === 'weapon' && weapons[args]) {
            if (player.gold >= weapons[args].price) {
              player.gold -= weapons[args].price;
              player.weapon = args;
              if (!player.inventory.includes(args)) player.inventory.push(args);
              saveProgress();
              ws.send(`购买成功！${args} 已装备。\n>`);
            } else {
              ws.send('金币不足！\n>');
            }
          } else if (room2.shop === 'armor' && armors[args]) {
            if (player.gold >= armors[args].price) {
              player.gold -= armors[args].price;
              player.armor = args;
              if (!player.inventory.includes(args)) player.inventory.push(args);
              saveProgress();
              ws.send(`购买成功！${args} 已装备。\n>`);
            } else {
              ws.send('金币不足！\n>');
            }
          } else if (room2.shop === 'medicine') {
            if (args === '金创药' && player.gold >= 20) {
              player.gold -= 20;
              player.hp = Math.min(player.maxHp, player.hp + 50);
              saveProgress();
              ws.send('金创药使用成功，HP恢复50。\n>');
            } else if (args === '九转灵丹' && player.gold >= 50) {
              player.gold -= 50;
              player.hp = Math.min(player.maxHp, player.hp + 100);
              saveProgress();
              ws.send('九转灵丹使用成功，HP恢复100。\n>');
            } else if (args === '内力丹' && player.gold >= 30) {
              player.gold -= 30;
              player.mp = Math.min(player.maxMp, player.mp + 30);
              saveProgress();
              ws.send('内力丹使用成功，MP恢复30。\n>');
            } else {
              ws.send('金币不足或物品不存在。\n>');
            }
          } else {
            ws.send('没有这种物品。\n>');
          }
          break;

        case 'i':
        case 'inventory':
          let invMsg = '\n【包裹】\n';
          invMsg += player.inventory.length === 0 ? '背包是空的\n' : player.inventory.join(', ') + '\n';
          ws.send(invMsg + '\n>');
          break;

        case 'fight':
          const room3 = getRoom(player.room);
          if (room3 && room3.npcs.length > 0) {
            const enemy = room3.npcs[Math.floor(Math.random() * room3.npcs.length)];
            const enemyHp = 50 + Math.floor(Math.random() * 30);
            const enemyMaxHp = enemyHp;
            const playerAtk = 10 + (player.weapon ? weapons[player.weapon].damage : 0);
            
            // 金庸风格战斗描述
            const attackPhrases = [
              '大喝一声', '身形疾进', '招式凌厉', '掌风呼呼', '剑光闪闪',
              '真气激荡', '功力运足', '身形晃动', '攻势如潮', '招式精妙'
            ];
            const enemyAttackPhrases = [
              '反手一击', '攻势凌厉', '招架不住', '掌力雄浑', '招式毒辣',
              '迎面攻来', '功力深厚', '变招迅速', '真气弥漫', '内力惊人'
            ];
            
            let combatLog = `
╔══════════════════════════════════════╗
║           ⚔️  江湖恶斗  ⚔️           ║
╚══════════════════════════════════════╝

【${enemy}】HP: ${enemyHp}/${enemyMaxHp}
【${player.name}】HP: ${player.hp}/${player.maxHp} MP: ${player.mp}/${player.maxMp}

───────────────────────────────────────
`;
            let eHp = enemyHp;
            let round = 1;
            let battleWinner = null;
            
            while (eHp > 0 && player.hp > 0) {
              const dmg = Math.max(1, playerAtk + Math.floor(Math.random() * 10) - 5);
              eHp -= dmg;
              const phrase = attackPhrases[Math.floor(Math.random() * attackPhrases.length)];
              combatLog += `第${round}招 │ ${player.name} ${phrase}，击中${enemy}！-${dmg}HP\n`;
              
              if (eHp <= 0) {
                battleWinner = 'player';
                break;
              }
              
              const eDmg = Math.max(1, 15 - (player.armor ? armors[player.armor].defense / 2 : 0));
              player.hp -= eDmg;
              const ePhrase = enemyAttackPhrases[Math.floor(Math.random() * enemyAttackPhrases.length)];
              combatLog += `第${round}招 │ ${enemy} ${ePhrase}，击中${player.name}！-${eDmg}HP\n`;
              
              // 显示双方实时状态
              combatLog += `        │ ${player.name} HP:${Math.max(0, player.hp)}/${player.maxHp}  ${enemy} HP:${Math.max(0, eHp)}/${enemyMaxHp}\n`;
              combatLog += `───────────────────────────────────────\n`;
              round++;
            }
            
            if (player.hp > 0) {
              const goldGain = 10 + Math.floor(Math.random() * 20);
              const expGain = 20 + Math.floor(Math.random() * 15);
              player.gold += goldGain;
              player.exp += expGain;
              const oldTitle = player.title;
              player.title = getTitle(player.exp);
              let titleMsg = player.title !== oldTitle ? `\n🎉 恭喜！你的称号提升为【${player.title}】！` : '';
              combatLog += `
╔══════════════════════════════════════╗
║           🏆 战斗胜利  🏆              ║
╠══════════════════════════════════════╣
║  获得金币: ${goldGain}                        ║
║  获得经验: ${expGain}                        ║
║  当前经验: ${player.exp}                     ║
╚══════════════════════════════════════╝${titleMsg}
`;
              saveProgress();
            } else {
              combatLog += `
╔══════════════════════════════════════╗
║           💀 战斗落败  💀              ║
╠══════════════════════════════════════╣
║  你身负重伤，仓皇离去...            ║
║  损失金币: 10                       ║
╚══════════════════════════════════════╝
`;
              player.gold = Math.max(0, player.gold - 10);
              player.hp = Math.floor(player.maxHp / 2);
              saveProgress();
            }
            ws.send(combatLog + '\n>');
          } else {
            let fightHint = '这里没有敌人可以战斗。\n';
            if (player.room === '练功房' || player.room === '客栈') {
              fightHint += '提示: 扬州街、赌场、华山派、少林寺等地有敌人\n';
            } else if (!room3 || room3.npcs.length === 0) {
              fightHint += '提示: 客栈大厅、扬州街、赌场等地有敌人\n';
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
          const onlineList = Object.keys(players);
          if (onlineList.length === 0) {
            whoMsg += '当前没有其他玩家在线\n';
          } else {
            for (const name of onlineList) {
              if (name !== player.name) {
                whoMsg += `【${name}】${players[name].title} 在${players[name].room}\n`;
              }
            }
            whoMsg += `共 ${onlineList.length} 人在线\n`;
          }
          ws.send(whoMsg + '\n>');
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
            ws.send(`你已经在关注【${args}】了。\n>`);
          } else {
            player.follows.push(args);
            if (!users[player.name].follows) users[player.name].follows = [];
            users[player.name].follows.push(args);
            saveUsers();
            ws.send(`你已关注【${args}】！对方上线时会通知你。\n>`);
          }
          break;

        case 'unfollow':
        case '取消关注':
          if (!args || !player.follows || !player.follows.includes(args)) {
            ws.send(`你没有关注【${args}】。\n>`);
          } else {
            player.follows = player.follows.filter(f => f !== args);
            users[player.name].follows = users[player.name].follows.filter(f => f !== args);
            saveUsers();
            ws.send(`已取消关注【${args}】。\n>`);
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
            onlinePlayers[tellTarget].send(`【私信】${player.name}对你说: ${tellMsg}\n>`);
            ws.send(`【私信】你对【${tellTarget}】说: ${tellMsg}\n>`);
          }
          break;

        case 'meme':
        case '匿名公告':
          // 耗费精力30和金币50
          if (!args) {
            ws.send('用法: meme 公告内容（耗费30精力+50金币）\n>');
            break;
          }
          if (player.气血 < 30 || player.gold < 50) {
            ws.send('精力不足30或金币不足50，无法发布公告。\n>');
            break;
          }
          player.气血 -= 30;
          player.gold -= 50;
          // 发送给所有在线玩家
          for (const [name, client] of Object.entries(onlinePlayers)) {
            client.send(`【匿名公告】${args}\n─────────────────────\n`);
          }
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
            onlinePlayers[atTarget].send(`【私信】${player.name}对你说: ${atMsg}\n>`);
            ws.send(`【私信】你对【${atTarget}】说: ${atMsg}\n>`);
          }
          break;

        case '@all':
        case '全体公告':
          // 耗费精力50和金币100
          if (!args) {
            ws.send('用法: @all 公告内容（耗费50精力+100金币）\n>');
            break;
          }
          if (player.气血 < 50 || player.gold < 100) {
            ws.send('精力不足50或金币不足100，无法发布全体公告。\n>');
            break;
          }
          player.气血 -= 50;
          player.gold -= 100;
          for (const [name, client] of Object.entries(onlinePlayers)) {
            client.send(`【全体公告】【${player.name}】${args}\n══════════════════════════════\n`);
          }
          break;

        case 'status':
        case '状态':
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
║ 气血: ${player.hp}/${player.maxHp}                          ║
║ 内力: ${player.mp}/${player.maxMp}                          ║
║ 外功攻击: ${player.外功攻击}                            ║
║ 防御: ${player.防御}                                ║
║ 身法: ${player.身法}                                ║
╠══════════════════════════════════════╣
║ 【战斗衍生】                                ║
║ 命中: ${player.命中}%  闪避: ${player.闪避}%  暴击: ${player.暴击}%     ║
╠══════════════════════════════════════╣
║ 经验: ${player.exp}  金币: ${player.gold}                      ║
╚══════════════════════════════════════╝
`;
          if (player.weapon) statusMsg += `武器: ${player.weapon}(攻击+${weapons[player.weapon].damage})\n`;
          if (player.armor) statusMsg += `防具: ${player.armor}(防御+${armors[player.armor].defense})\n`;
          let skillList = Object.keys(player.skills).join(', ');
          statusMsg += `技能: ${skillList || '无'}\n`;
          ws.send(statusMsg + '\n>');
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
          ws.send(followMsg + '\n>');
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
              ws.send(`你正式拜【${args}】为师！加入【${master.school}】！\n>`, saveProgress());
            } else {
              ws.send(`【${args}】说：你经验不足(${master.requiredExp}点)，再来找我吧。\n>`);
            }
          } else {
            ws.send(`这里找不到【${args}】。当前房间NPC: ${here ? here.npcs.join(', ') : '无'}
【提示】听闻${args}常在${masters[args] ? masters[args].location : '某处'}。输入 find 查看更多线索。\n>`);
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
            ws.send(`【师父信息】
师父: ${player.master}
门派: ${player.school}
传授技能: ${sf ? sf.skill : '未知'}
说明: 输入 "传功" 向师父学习技能
`);
          }
          break;

        case 'quest':
        case '任务':
        case 'mission':
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              player.gold += rewardGold;
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
              players[reconnectName] = player;
              onlinePlayers[reconnectName] = ws;
              state = 'playing';
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
'║   江湖儿女江湖老，一片冰心在玉壶       ║\n' +
'║   世界已经运行了' + uptime.days + '天' + uptime.hours + '小时' + uptime.minutes + '分钟    ║\n' +
'╚════════════════════════════════════╝\n';
              ws.send(welcomeMsg2);
              ws.send(formatOutput(player, '欢迎回来，' + reconnectName + '！'));
              ws.send('【江湖秘术】' + reconnectName + '又回到了这个世界~ session:' + session.token);
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

        case 'help':
          ws.send(`【指令帮助】
look/l - 查看房间
go/走 [方向] - 移动
n/s/e/w 或 north/south/east/west - 移动
u/d - 上/下楼梯
status/状态 - 查看状态
skills - 查看技能
learn [技能] - 学习技能
train - 练功(恢复HP/MP)
shop - 查看商店
buy [物品] - 购买
inventory/i - 查看包裹
fight - 战斗
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
  const room = getRoom(player.room);
  if (room && room.exits[direction]) {
    player.room = room.exits[direction];
    return true;
  }
  return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`武侠MUD已启动: http://localhost:${PORT}`);
});
