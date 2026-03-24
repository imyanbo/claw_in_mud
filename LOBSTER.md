# LOBSTER.md

龙虾客户端（机器人玩家）接入说明。

## 目标

让“机器人玩家”和“真人玩家”同时进入同一个 MUD 世界，统一走 WebSocket 文本协议。

## 启动方式

### 1. 注册一个新龙虾账号

```bash
cd /root/.openclaw/workspace/claw_in_mud
node lobster-client.js --url wss://bobo.rocks/ --mode register --profile scout
```

### 2. 登录已有账号

```bash
node lobster-client.js --url wss://bobo.rocks/ --mode login --username lobster_demo --password p1234 --profile chatter
```

### 3. reconnect 已保存 token 的账号

```bash
node lobster-client.js --url wss://bobo.rocks/ --mode reconnect --username lobster_demo --profile fighter
```

### 4. 使用 npm script

```bash
npm run lobster
```

### 5. 一次启动多个龙虾

```bash
npm run lobster:squad
```

## 推荐账号命名

统一使用前缀，避免和真人混淆：

- `lobster_`
- `bot_`
- `npc_`

示例：

- `lobster_alpha`
- `lobster_test01`
- `bot_guard`

## Profile

当前支持 4 种基础 profile：

- `scout`：探索型，常用 `look / who / map / rank`
- `chatter`：社交型，常用 `who / follows / rank`
- `fighter`：战斗型，常用 `status / look / train / fight`
- `quester`：任务型，常用 `look / quest / map 凤栖 / map 出海`

也可以手动覆盖命令：

```bash
node lobster-client.js --mode login --username lobster_demo --password p1234 --commands "who,look,follow 大鹿,tell 大鹿 龙虾已上线"
```

还支持插入等待指令，方便做共存观察：

```bash
node lobster-client.js --mode login --username lobster_demo --password p1234 --commands "who,wait:3000,follow 大鹿,tell 大鹿 龙虾已上线"
```

## 当前协议

### 注册流程

按顺序发送：

```text
register
用户名
密码
```

### 登录流程

```text
login
用户名
密码
```

### 版本上报

客户端连接后会自动发送：

```text
/client_version lobster-1
```

### 会话 token

如果服务端已部署新版，会通过 WebSocket 返回：

```text
session:xxxxxxxx
version:dev-2026-03-24-1
```

后续可用于 `/reconnect`。

## 用户名规则

服务端现在限制用户名：

- 长度 2-20
- 仅允许：中文 / 英文 / 数字 / 下划线
- 不允许空格
- 不允许命令样式用户名

合法示例：

- `lobster_a1`
- `大鹿`
- `bot_guard`

非法示例：

- `quest accept 三体降临`
- `scan sky`
- `user test`

## 下一步建议

- 让服务端稳定返回 `session:` 和 `version:`
- 龙虾客户端保存 token，支持断线重连
- 按 profile 区分不同龙虾行为（chat/fight/scout）
