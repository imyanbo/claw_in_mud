const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

let step = 0;

ws.on('open', () => {
  console.log('=== 连接成功 ===');
});

ws.on('message', (data) => {
  const msg = data.toString();
  
  step++;
  
  if (step === 1) {
    ws.send('1'); // login
  } else if (step === 2) {
    ws.send('testuser');
  } else if (step === 3) {
    ws.send('123456');
  } else if (msg.includes('欢迎回来')) {
    console.log('=== 登录成功 ===');
    console.log('-> 发送: s 去扬州城');
    ws.send('s');
  } else if (msg.includes('扬州城')) {
    console.log('-> 发送: shop 查看商店');
    ws.send('shop');
  } else if (msg.includes('武器铺')) {
    console.log('-> 发送: buy 铁剑');
    ws.send('buy 铁剑');
  } else if (msg.includes('购买成功')) {
    console.log('-> 发送: w 去华山派');
    ws.send('w');
  } else if (msg.includes('华山派')) {
    console.log('-> 发送: fight 战斗');
    ws.send('fight');
  } else if (msg.includes('战斗') || msg.includes('战斗胜利') || msg.includes('你被打败')) {
    console.log('=== 战斗结果 ===');
    console.log(msg.split('\\n').slice(-5).join('\\n'));
    console.log('-> 发送: map 扬州');
    ws.send('map 扬州');
  } else if (msg.includes('扬州城区域')) {
    console.log('=== 地图测试成功 ===');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (e) => {
  console.log('Error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 20000);
