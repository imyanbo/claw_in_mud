const WebSocket = require('ws');

const username = 't' + Math.floor(Math.random() * 1000000);
const password = '123456';
const ws = new WebSocket('ws://127.0.0.1:3000');

const steps = [
  ['1. 登录', '2'],
  ['请输入用户名', username],
  ['请设置密码', password],
  ['注册成功', 'w'],
  ['扬州主街北段', 'n'],
  ['六扇门捕头', 'inquire 六扇门捕头 about 码头'],
  ['码头疑案', 'quest accept 码头疑案'],
  ['【任务开始: 码头疑案】', 's'],
  ['扬州主街北段', 's'],
  ['扬州主街正中', 's'],
  ['扬州主街南段', 's'],
  ['最好主动搜一搜', 'search'],
  ['【码头疑案】', 'n'],
  ['扬州主街南段', 'n'],
  ['扬州主街正中', 'n'],
  ['扬州主街北段', 'w'],
  ['小巷里气氛有些古怪', 'search'],
  ['【码头疑案】', 'e'],
  ['东边便是灯火通明的丽春院', 'e'],
  ['丽春院', 'w'],
  ['小巷里气氛有些古怪', 'w'],
  ['扬州主街北段', 's'],
  ['扬州主街正中', 's'],
  ['扬州主街南段', 's'],
  ['情报贩子', 'inquire 情报贩子 about 码头'],
  ['换手递信', 'quest solve 码头疑案 情报贩子'],
  ['【任务完成: 码头疑案】', 'n'],
  ['扬州主街南段', 'n'],
  ['扬州主街正中', 'n'],
  ['扬州主街北段', 'w'],
  ['扬州城内一条略显阴湿的窄巷', 'e'],
  ['丽春院', 'ask 老鸨 about 密信'],
  ['丽春院密信', 'quest accept 丽春院密信'],
  ['真凭实据', 'search'],
  ['【丽春院密信】', 'w'],
  ['扬州城内一条略显阴湿的窄巷', 'e'],
  ['扬州主街北段', 's'],
  ['扬州主街正中', 's'],
  ['扬州主街南段', 's'],
  ['看出破绽', 'search'],
  ['【丽春院密信】', 'n'],
  ['扬州主街南段', 'n'],
  ['扬州主街正中', 'n'],
  ['扬州主街北段', 'e'],
  ['逼出反应', 'search'],
  ['【丽春院密信】', 'w'],
  ['扬州主街北段', 'w'],
  ['扬州城内一条略显阴湿的窄巷', 'e'],
  ['丽春院', 'quest solve 丽春院密信 客栈老板'],
  ['【任务完成: 丽春院密信】', 'w'],
  ['扬州城内一条略显阴湿的窄巷', 'ask 老鸨 about 城西怪影'],
  ['城西怪影', 'quest accept 城西怪影'],
  ['怪得很', 'search'],
  ['【城西怪影】', 'n'],
  ['井栏，木头上有一道反复摩擦留下的深痕', 's'],
  ['城西荒地', 'w'],
  ['破庙里供的不是佛', 'quest solve 城西怪影 黑衣怪客'],
  ['【任务完成: 城西怪影】', null]
];

let i = 0;
let last = '';

function fail(reason) {
  console.error('SMOKETEST_FAIL', reason);
  console.error('STEP', i, steps[i] ? steps[i][0] : 'DONE');
  console.error('LAST', last);
  process.exit(1);
}

ws.on('open', () => {
  console.log('WS_OPEN');
});

ws.on('message', (data) => {
  const msg = data.toString();
  last = msg.replace(/\n/g, '\\n').slice(0, 900);
  console.log('MSG>', last);
  if (i < steps.length && msg.includes(steps[i][0])) {
    const [needle, cmd] = steps[i];
    console.log('HIT>', i, needle);
    i += 1;
    if (cmd) {
      console.log('CMD>', cmd);
      setTimeout(() => {
        console.log('SEND>', cmd);
        ws.send(cmd);
      }, 100);
      return;
    }
    console.log('SMOKETEST_OK');
    process.exit(0);
  }
});

ws.on('error', (e) => fail(e.message));
setTimeout(() => fail('timeout'), 120000);
