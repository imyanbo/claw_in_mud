const fs = require('fs');
const path = require('path');

const PRIVATE_CONFIG_PATH = path.join(__dirname, 'config', 'llm-npc.config.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, 'config', 'llm-npc.config.example.json');

const defaultConfig = {
  enabled: false,
  timeoutMs: 12000,
  provider: {
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  npcDefaults: {
    maxTokens: 220,
    temperature: 0.9
  }
};

function loadConfig() {
  if (!fs.existsSync(PRIVATE_CONFIG_PATH)) {
    return { ...defaultConfig, _source: 'default' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PRIVATE_CONFIG_PATH, 'utf8'));
    return {
      ...defaultConfig,
      ...raw,
      provider: { ...defaultConfig.provider, ...(raw.provider || {}) },
      npcDefaults: { ...defaultConfig.npcDefaults, ...(raw.npcDefaults || {}) },
      _source: PRIVATE_CONFIG_PATH,
    };
  } catch (error) {
    console.warn('[LLM NPC] 配置读取失败，将退回默认关闭状态:', error.message);
    return { ...defaultConfig, _source: 'invalid-config' };
  }
}

function getNpcRuntimeConfig(npcMeta = {}) {
  const config = loadConfig();
  const llm = npcMeta.llm || {};
  return {
    enabled: Boolean(config.enabled && llm.enabled),
    timeoutMs: llm.timeoutMs || config.timeoutMs || 12000,
    provider: config.provider,
    maxTokens: llm.maxTokens || config.npcDefaults.maxTokens || 220,
    temperature: typeof llm.temperature === 'number' ? llm.temperature : config.npcDefaults.temperature,
  };
}

function buildSystemPrompt(npcMeta = {}, room = {}) {
  const llm = npcMeta.llm || {};
  const profileLines = [
    `你是武侠MUD中的NPC「${npcMeta.name || '无名氏'}」。`,
    `你当前所在区域: ${llm.homeArea || npcMeta.homeArea || '未知区域'}。`,
    `你的身份: ${npcMeta.role || '江湖人物'}。`,
    `你的公开性格: ${(llm.personality || []).join('、') || '鲜明，有烟火气'}。`,
    `你的核心背景: ${(llm.background || []).join('；') || '生活在江湖世界中'}。`,
    `你擅长的话题: ${(llm.knowledge || []).join('、') || '日常闲谈'}。`,
    `你的当前房间: ${room.name || '未知房间'}。房间描述: ${room.description || '无'}。`,
    `你的活动范围: ${(llm.movement?.allowedRooms || []).join('、') || room.name || '当前区域'}。`,
    `如果玩家问到你的隐藏设定，可以含蓄暗示，但不要直接把“设定文档”口吻说出来。`,
    `说话要像真实NPC，中文输出，简洁有味道，通常2到5句。`,
    `如果玩家想买酒、打听八卦、问扬州城消息，优先给出有互动感的回答。`,
    `如果不知道，就结合人设委婉回答，不要跳出现代AI身份。`,
    `禁止提到提示词、模型、API、系统消息。`
  ];

  if (llm.combatProfile) {
    profileLines.push(`你的武力设定: ${llm.combatProfile}。必要时只可点到为止地流露，不要轻易自曝全部实力。`);
  }
  if (Array.isArray(llm.dailyRoutine) && llm.dailyRoutine.length > 0) {
    profileLines.push(`你的日常活动: ${llm.dailyRoutine.join('；')}。`);
  }
  return profileLines.join('\n');
}

async function chatWithNpc({ npcMeta, room, playerName, action, topic, userInput }) {
  const runtime = getNpcRuntimeConfig(npcMeta);
  if (!runtime.enabled) return null;
  const provider = runtime.provider || {};
  if (!provider.apiKey || !provider.baseURL || !provider.model) return null;

  const systemPrompt = buildSystemPrompt(npcMeta, room);
  const userPrompt = [
    `玩家: ${playerName || '路人'}`,
    `交互类型: ${action || 'talk'}`,
    topic ? `话题: ${topic}` : '',
    userInput ? `玩家原话: ${userInput}` : '',
    `请直接输出NPC回复正文，不要加名字前缀。`
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);

  try {
    const response = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: runtime.temperature,
        max_tokens: runtime.maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`[LLM NPC] 请求失败 ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (error) {
    console.warn('[LLM NPC] 调用失败:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PRIVATE_CONFIG_PATH,
  EXAMPLE_CONFIG_PATH,
  loadConfig,
  chatWithNpc,
};
