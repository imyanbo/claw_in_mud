const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database(__dirname + '/mud.db');

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const APP_VERSION = process.env.APP_VERSION || 'dev-2026-04-18-2';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const ONLINE_TTL_MS = Number(process.env.ONLINE_TTL_MS || 90 * 1000);

const serialize = (obj, fallback = {}) => JSON.stringify(obj ?? fallback);
const deserialize = (str, fallback) => {
  if (str == null || str === '') return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};

function nowIso() {
  return new Date().toISOString();
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      exp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      gold INTEGER DEFAULT 50,
      hp INTEGER,
      mp INTEGER,
      maxHp INTEGER,
      maxMp INTEGER,
      room TEXT DEFAULT '客栈',
      skills TEXT DEFAULT '{}',
      inventory TEXT DEFAULT '[]',
      weapon TEXT,
      armor TEXT,
      title TEXT DEFAULT '初入江湖',
      follows TEXT DEFAULT '[]',
      master TEXT,
      school TEXT,
      quest TEXT,
      questProgress TEXT DEFAULT '{}',
      achievements TEXT DEFAULT '[]',
      先天 TEXT DEFAULT '{}',
      气血 INTEGER,
      内力 INTEGER,
      外功攻击 INTEGER,
      内功攻击 INTEGER,
      防御 INTEGER,
      身法 INTEGER,
      命中 INTEGER,
      闪避 INTEGER,
      暴击 INTEGER,
      门派声望 INTEGER DEFAULT 0,
      观测数据 INTEGER DEFAULT 0,
      信号已解码 INTEGER DEFAULT 0,
      已触发新港城剧情 INTEGER DEFAULT 0,
      faction TEXT,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      client_version TEXT,
      server_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      reconnect_nonce TEXT,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_name) REFERENCES users(name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_name ON sessions(user_name);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS online_presence (
      user_name TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      room TEXT,
      client_type TEXT,
      FOREIGN KEY (user_name) REFERENCES users(name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_online_presence_instance_id ON online_presence(instance_id);
    CREATE INDEX IF NOT EXISTS idx_online_presence_last_seen_at ON online_presence(last_seen_at);
  `);
}

function rowToUser(row) {
  if (!row) return null;
  return {
    ...row,
    skills: deserialize(row.skills, {}),
    inventory: deserialize(row.inventory, []),
    follows: deserialize(row.follows, []),
    questProgress: deserialize(row.questProgress, {}),
    achievements: deserialize(row.achievements, []),
    先天: deserialize(row.先天, {}),
    观测数据: !!row.观测数据,
    信号已解码: !!row.信号已解码,
    已触发新港城剧情: !!row.已触发新港城剧情
  };
}

function getUser(name) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE name = ?').get(name));
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all().map(rowToUser);
}

function saveUser(user) {
  const stmt = db.prepare(`
    INSERT INTO users (
      name, password, exp, level, gold, hp, mp, maxHp, maxMp, room,
      skills, inventory, weapon, armor, title, follows, master, school,
      quest, questProgress, achievements, 先天,
      气血, 内力, 外功攻击, 内功攻击, 防御, 身法, 命中, 闪避, 暴击, 门派声望,
      观测数据, 信号已解码, 已触发新港城剧情, faction, updatedAt
    ) VALUES (
      @name, @password, @exp, @level, @gold, @hp, @mp, @maxHp, @maxMp, @room,
      @skills, @inventory, @weapon, @armor, @title, @follows, @master, @school,
      @quest, @questProgress, @achievements, @先天,
      @气血, @内力, @外功攻击, @内功攻击, @防御, @身法, @命中, @闪避, @暴击, @门派声望,
      @观测数据, @信号已解码, @已触发新港城剧情, @faction, @updatedAt
    )
    ON CONFLICT(name) DO UPDATE SET
      password=excluded.password,
      exp=excluded.exp,
      level=excluded.level,
      gold=excluded.gold,
      hp=excluded.hp,
      mp=excluded.mp,
      maxHp=excluded.maxHp,
      maxMp=excluded.maxMp,
      room=excluded.room,
      skills=excluded.skills,
      inventory=excluded.inventory,
      weapon=excluded.weapon,
      armor=excluded.armor,
      title=excluded.title,
      follows=excluded.follows,
      master=excluded.master,
      school=excluded.school,
      quest=excluded.quest,
      questProgress=excluded.questProgress,
      achievements=excluded.achievements,
      先天=excluded.先天,
      气血=excluded.气血,
      内力=excluded.内力,
      外功攻击=excluded.外功攻击,
      内功攻击=excluded.内功攻击,
      防御=excluded.防御,
      身法=excluded.身法,
      命中=excluded.命中,
      闪避=excluded.闪避,
      暴击=excluded.暴击,
      门派声望=excluded.门派声望,
      观测数据=excluded.观测数据,
      信号已解码=excluded.信号已解码,
      已触发新港城剧情=excluded.已触发新港城剧情,
      faction=excluded.faction,
      updatedAt=excluded.updatedAt
  `);

  stmt.run({
    name: user.name,
    password: user.password,
    exp: user.exp || 0,
    level: user.level || 1,
    gold: user.gold || 50,
    hp: user.hp ?? user.maxHp ?? 100,
    mp: user.mp ?? user.maxMp ?? 50,
    maxHp: user.maxHp ?? 100,
    maxMp: user.maxMp ?? 50,
    room: user.room || '客栈',
    skills: serialize(user.skills, {}),
    inventory: serialize(user.inventory, []),
    weapon: user.weapon || null,
    armor: user.armor || null,
    title: user.title || '初入江湖',
    follows: serialize(user.follows, []),
    master: user.master || null,
    school: user.school || null,
    quest: user.quest || null,
    questProgress: serialize(user.questProgress, {}),
    achievements: serialize(user.achievements, []),
    先天: serialize(user.先天, {}),
    气血: user.气血 ?? user.maxHp ?? 100,
    内力: user.内力 ?? user.maxMp ?? 50,
    外功攻击: user.外功攻击 ?? 10,
    内功攻击: user.内功攻击 ?? 0,
    防御: user.防御 ?? 5,
    身法: user.身法 ?? 10,
    命中: user.命中 ?? 80,
    闪避: user.闪避 ?? 10,
    暴击: user.暴击 ?? 5,
    门派声望: user.门派声望 ?? 0,
    观测数据: user.观测数据 ? 1 : 0,
    信号已解码: user.信号已解码 ? 1 : 0,
    已触发新港城剧情: user.已触发新港城剧情 ? 1 : 0,
    faction: user.faction || null,
    updatedAt: nowIso()
  });
}

function migrateFromJsonUsers(jsonUsers) {
  if (!jsonUsers || typeof jsonUsers !== 'object') return 0;
  let imported = 0;
  for (const [name, user] of Object.entries(jsonUsers)) {
    if (getUser(name)) continue;
    saveUser({ ...user, name });
    imported += 1;
  }
  return imported;
}

function createSession(userName, meta = {}) {
  revokeSessionsForUser(userName);
  const token = generateToken();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const sessionId = crypto.randomUUID();
  const reconnectNonce = crypto.randomBytes(8).toString('hex');

  db.prepare(`
    INSERT INTO sessions (
      session_id, user_name, token_hash, client_version, server_version, status,
      created_at, last_seen_at, expires_at, reconnect_nonce, ip, user_agent
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    userName,
    hashToken(token),
    meta.clientVersion || null,
    APP_VERSION,
    createdAt,
    createdAt,
    expiresAt,
    reconnectNonce,
    meta.ip || null,
    meta.userAgent || null
  );

  return {
    token,
    sessionId,
    reconnectNonce,
    serverVersion: APP_VERSION,
    expiresAt
  };
}

function getSessionByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
}

function getUserByToken(token) {
  const session = getSessionByToken(token);
  if (!session) return null;
  if (session.status !== 'active') return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE sessions SET status = 'expired' WHERE session_id = ?").run(session.session_id);
    return null;
  }
  return getUser(session.user_name);
}

function touchSession(token, clientVersion) {
  const session = getSessionByToken(token);
  if (!session) return null;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`
    UPDATE sessions
    SET last_seen_at = ?, expires_at = ?, client_version = COALESCE(?, client_version)
    WHERE session_id = ?
  `).run(now, expiresAt, clientVersion || null, session.session_id);
  return { ...session, last_seen_at: now, expires_at: expiresAt, client_version: clientVersion || session.client_version };
}

function revokeSessionsForUser(userName) {
  db.prepare("UPDATE sessions SET status = 'revoked' WHERE user_name = ? AND status = 'active'").run(userName);
}

function invalidateAllSessionsForVersionMismatch() {
  db.prepare("UPDATE sessions SET status = 'version_mismatch' WHERE server_version <> ? AND status = 'active'").run(APP_VERSION);
}

function cleanupOnlinePresence() {
  const cutoff = new Date(Date.now() - ONLINE_TTL_MS).toISOString();
  db.prepare('DELETE FROM online_presence WHERE last_seen_at < ?').run(cutoff);
}

function upsertOnlinePresence({ userName, instanceId, room, clientType }) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO online_presence (user_name, instance_id, connected_at, last_seen_at, room, client_type)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_name) DO UPDATE SET
      instance_id=excluded.instance_id,
      last_seen_at=excluded.last_seen_at,
      room=excluded.room,
      client_type=excluded.client_type
  `).run(userName, instanceId, now, now, room || null, clientType || null);
}

function touchOnlinePresence(userName, room) {
  db.prepare('UPDATE online_presence SET last_seen_at = ?, room = COALESCE(?, room) WHERE user_name = ?')
    .run(nowIso(), room || null, userName);
}

function removeOnlinePresence(userName) {
  db.prepare('DELETE FROM online_presence WHERE user_name = ?').run(userName);
}

function listOnlinePlayers() {
  cleanupOnlinePresence();
  return db.prepare('SELECT * FROM online_presence ORDER BY connected_at ASC').all();
}

module.exports = {
  db,
  APP_VERSION,
  SESSION_TTL_MS,
  initDatabase,
  getUser,
  getAllUsers,
  saveUser,
  getUserByToken,
  migrateFromJsonUsers,
  createSession,
  getSessionByToken,
  touchSession,
  revokeSessionsForUser,
  invalidateAllSessionsForVersionMismatch,
  cleanupOnlinePresence,
  upsertOnlinePresence,
  touchOnlinePresence,
  removeOnlinePresence,
  listOnlinePlayers,
  ONLINE_TTL_MS
};