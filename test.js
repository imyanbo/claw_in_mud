const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

let step = 0;

ws.on('open', () => {
  console.log('=== 连接成功 ===');
});

ws.on('message', (data) => {
  const msg = data.toString();
  console.log(msg);
  
  step++;
  
  if (step === 1) {
    console.log('-> 发送: 2 (注册)');
    ws.send('2');
  } else if (step === 2) {
    console.log('-> 发送: testuser (用户名)');
    ws.send('testuser');
  } else if (step === 3) {
    console.log('-> 发送: 123456 (密码)');
    ws.send('123456');
  } else if (msg.includes('江湖欢迎你')) {
    console.log('-> 发送: map');
    ws.send('map');
  } else if (msg.includes('江湖全图')) {
    console.log('-> 发送: look');
    ws.send('look');
  } else if (msg.includes('大厅')) {
    console.log('-> 发送: n');
    ws.send('n');
  } else if (msg.includes('扬州城')) {
    console.log('-> 发送: shop');
    ws.send('shop');
  } else if (msg.includes('武器铺')) {
    console.log('-> 发送: buy 木剑');
    ws.send('buy 木剑');
  } else if (msg.includes('购买成功')) {
    console.log('-> 发送: skills');
    ws.send('skills');
  } else if (msg.includes('技能')) {
    console.log('-> 发送: train');
    ws.send('train');
  } else if (msg.includes('练功')) {
    console.log('-> 发送: fight');
    ws.send('fight');
  } else if (msg.includes('战斗') || msg.includes('战斗胜利')) {
    console.log('=== 测试完成 ===');
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
}, 15000);
