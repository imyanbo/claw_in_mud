# LLM NPC 接入说明

本次为 mud-game 增加了一个可选的大模型 NPC 接口层，默认关闭。

## 已完成

- 新增 `llm-npc.js`，统一处理 NPC 大模型调用
- 新增私有配置示例 `config/llm-npc.config.example.json`
- `config/*.json` 已加入 `.gitignore`，不会上传 Git
- 新增接口 `GET /api/npc/llm-config` 用于查看配置路径
- 老鸨已作为首个大模型 NPC 样板接入
- 老鸨支持：
  - talk / 对话
  - ask NPC about 话题
  - inquire NPC about 话题
  - rumor NPC
  - list 老鸨
  - buy 女儿红 / buy 竹叶青
  - 扬州城范围内闲逛移动
  - 卖酒、讲八卦、保留隐藏高手设定

- 新增扬州重点 NPC 模板蓝图（当前先落在代码里）
  - 老鸨
  - 客栈老板
  - 情报贩子
  - 六扇门捕头
  - 镖头

## 当前已补全的重点 NPC

### 客栈老板
- 能力: 住宿、热酒、过路信息
- 指令:
  - `talk 客栈老板`
  - `list 客栈老板`
  - `buy 客房牌`
  - `buy 热酒`
  - `rumor 客栈老板`
  - `inquire 客栈老板 about 住店`

### 情报贩子
- 能力: 卖八卦、卖密报、灰色情报交互
- 指令:
  - `talk 情报贩子`
  - `list 情报贩子`
  - `buy 扬州传闻`
  - `buy 江湖密报`
  - `rumor 情报贩子`
  - `inquire 情报贩子 about 可疑人物`

### 六扇门捕头
- 能力: 官府线索、治安传闻、通缉相关问答
- 指令:
  - `talk 六扇门捕头`
  - `rumor 六扇门捕头`
  - `inquire 六扇门捕头 about 通缉`

### 镖头
- 能力: 行路建议、押镖路线、补给售卖
- 指令:
  - `talk 镖头`
  - `list 镖头`
  - `buy 行路干粮`
  - `buy 简易地图`
  - `rumor 镖头`
  - `inquire 镖头 about 东郊驿道`

## 私有配置

复制示例文件：

```bash
mkdir -p config
cp config/llm-npc.config.example.json config/llm-npc.config.json
```

然后填写你自己的 API：

```json
{
  "enabled": true,
  "timeoutMs": 12000,
  "provider": {
    "type": "openai-compatible",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "YOUR_KEY",
    "model": "gpt-4o-mini"
  },
  "npcDefaults": {
    "maxTokens": 220,
    "temperature": 0.9
  }
}
```

## 当前设计

### 1. 可配置 provider
当前先支持 OpenAI-compatible 接口，后续很容易扩展到：
- OpenAI
- DeepSeek
- Moonshot
- SiliconFlow
- 本地 vLLM / Ollama 网关

### 2. NPC 数据驱动
NPC 配置现已拆分到独立文件 `npc-data.js`，`server.js` 只保留玩法和交互逻辑。

当前配置结构包括：
- 基础 alias / role / loot / quote
- llm 人设
- knowledge
- combatProfile
- dailyRoutine
- movement.allowedRooms
- vendor.items
- `smartNpcBlueprints`

这样后续继续扩展扬州重点 NPC，会比继续堆在 `server.js` 里轻松很多。

### 3. 失败自动回退
如果：
- 没配 API
- 配置关闭
- 超时
- 请求失败

则会自动回退到原有静态台词，不会影响游戏可玩性。

## 建议下一步

如果你要把“扬州城重点 NPC”系统化，我建议继续拆成：

1. `config/npc-prompts/` 独立人设文件
2. 按城市或势力继续拆分 `npc-data.js`
3. 增加 `buy from NPC` / `rumor` / `inquire` 等更细命令
4. 增加 NPC 记忆缓存，避免每句都重新生成
5. 给重点 NPC 增加关系网和城内事件订阅

这样就能从“会说话的 NPC”，升级成“有生活感的江湖角色系统”。
