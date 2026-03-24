const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('./mud.db');

// Helper to serialize JSON fields
const serialize = (obj) => JSON.stringify(obj || {});
const deserialize = (str) => str ? JSON.parse(str) : {};

// Initialize database if needed
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password TEXT,
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
      sessionToken TEXT,
      先天 TEXT,
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
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Load user from database
function getUser(name) {
  const row = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!row) return null;
  
  return {
    ...row,
    skills: deserialize(row.skills),
    inventory: deserialize(row.inventory),
    follows: deserialize(row.follows),
    questProgress: deserialize(row.questProgress),
    achievements: deserialize(row.achievements),
    先天: deserialize(row.先天)
  };
}

// Get all users (for checking existence)
function getAllUsers() {
  const rows = db.prepare('SELECT name, password FROM users').all();
  return rows;
}

// Save or update user
function saveUser(user) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO users (
      name, password, exp, level, gold, hp, mp, maxHp, maxMp, room,
      skills, inventory, weapon, armor, title, follows, master, school,
      quest, questProgress, achievements, sessionToken, 先天,
      气血, 内力, 外功攻击, 内功攻击, 防御, 身法, 命中, 闪避, 暴击, 门派声望, updatedAt
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
  `);
  
  stmt.run(
    user.name, user.password, user.exp || 0, user.level || 1, user.gold || 50,
    user.hp, user.mp, user.maxHp, user.maxMp, user.room || '客栈',
    serialize(user.skills), serialize(user.inventory), user.weapon, user.armor,
    user.title || '初入江湖', serialize(user.follows), user.master, user.school,
    user.quest, serialize(user.questProgress), serialize(user.achievements),
    user.sessionToken, serialize(user.先天),
    user.气血 || 100, user.内力 || 50, user.外功攻击 || 10, user.内功攻击 || 0,
    user.防御 || 5, user.身法 || 10, user.命中 || 80, user.闪避 || 10, 
    user.暴击 || 5, user.门派声望 || 0
  );
}

// Get user by session token
function getUserByToken(token) {
  const row = db.prepare('SELECT * FROM users WHERE sessionToken = ?').get(token);
  if (!row) return null;
  return {
    ...row,
    skills: deserialize(row.skills),
    inventory: deserialize(row.inventory),
    follows: deserialize(row.follows),
    questProgress: deserialize(row.questProgress),
    achievements: deserialize(row.achievements),
    先天: deserialize(row.先天)
  };
}

module.exports = {
  db,
  initDatabase,
  getUser,
  getAllUsers,
  saveUser,
  getUserByToken
};
