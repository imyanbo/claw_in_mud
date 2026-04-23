const onlinePlayers = {};

const npcCatalog = {
  '老鸨': {
    alias: 'laobao',
    quote: '姑娘们都得吃饭，银子到了再谈情分。',
    money: 80,
    loot: ['胭脂', '女儿红'],
    role: '丽春院老鸨',
    homeArea: '扬州城',
    vendor: {
      category: '酒水',
      items: [
        { name: '女儿红', price: 35, currency: 'coin', desc: '香气绵长，入口柔和。' },
        { name: '米酒', price: 16, currency: 'coin', desc: '温和顺口，最适合慢慢浅酌。' },
        { name: '竹叶青', price: 62, currency: 'coin', desc: '清芬透鼻，回味却透着一丝冷烈。' },
        { name: '烧刀子', price: 52, currency: 'coin', desc: '烈得呛喉，喝下去最显豪气。' },
        { name: '猴儿酒', price: 98, currency: 'coin', desc: '山中异酿，颇有灵气。' }
      ]
    },
    llm: {
      enabled: true,
      homeArea: '扬州城',
      personality: ['热心', '见钱眼开', '胆小怕事', '底色有正义感'],
      background: [
        '生活在扬州城',
        '经营丽春院，负责招呼客人、介绍生意、卖酒',
        '熟悉扬州城三教九流的消息',
        '平生最爱收集各种八卦'
      ],
      knowledge: ['扬州城八卦', '丽春院生意', '酒水买卖', '江湖风声', '城中人物动向'],
      combatProfile: '隐藏的武功高手，综合武力可列NPC前十，但平时深藏不露',
      dailyRoutine: [
        '大多数时间在丽春院招呼客人',
        '偶尔会去扬州街、扬州码头、客栈打听消息',
        '夜深后会回丽春院盘账'
      ],
      movement: {
        allowedRooms: ['丽春院', '扬州街', '扬州码头', '客栈', '扬州小巷'],
        idleMoveChance: 0.18
      },
      temperature: 0.95,
      maxTokens: 240
    }
  },
  '春花': { alias: 'chunhua', quote: '客官，可别光顾着看热闹呀。', money: 18, loot: ['香囊'], role: '丽春院红倌' },
  '秋月': { alias: 'qiuyue', quote: '今夜月色正好，何必舞刀弄剑。', money: 20, loot: ['绣帕'], role: '丽春院红倌' },
  '小贩': { alias: 'xiaofan', quote: '走过路过，别错过新鲜玩意儿。', money: 16, loot: ['糖葫芦'], role: '街头小贩' },
  '行人': { alias: 'passerby', quote: '江湖险恶，出门在外多留个心眼。', money: 7, loot: [], role: '路人' },
  '官兵': { alias: 'guard', quote: '闲人退后，莫要在城中生事。', money: 25, loot: ['腰牌'], role: '官府卫兵' },
  '驿卒': { alias: 'yizu', quote: '八百里加急，也得先喂饱这匹马。', money: 14, loot: ['快信'], role: '驿站差役' },
  '赶路人': { alias: 'traveler', quote: '前头风大路险，能结伴最好。', money: 9, loot: ['干粮'], role: '过路旅人' },
  '城门守卫': { alias: 'gateguard', quote: '出入城门，先报来路。', money: 22, loot: ['通关木牌'], role: '城门守卫' },
  '客栈老板': {
    alias: 'innkeeper',
    quote: '住店打尖都行，先把银子放下。',
    money: 55,
    loot: ['账本', '房牌'],
    role: '客栈掌柜',
    homeArea: '扬州城',
    vendor: {
      category: '住宿酒食',
      items: [
        { name: '客房牌', price: 80, currency: 'coin', desc: '一晚普通客房，可在客栈落脚。' },
        { name: '米酒', price: 14, currency: 'coin', desc: '暖胃的家常米酒。' },
        { name: '女儿红', price: 32, currency: 'coin', desc: '陈香柔和，最受过路客喜爱。' },
        { name: '汾酒', price: 40, currency: 'coin', desc: '清冽回甘，后劲悠长。' },
        { name: '竹叶青', price: 58, currency: 'coin', desc: '酒色清碧，适合慢慢品。' },
        { name: '热酒', price: 18, currency: 'coin', desc: '暖身热酒，适合夜里驱寒。' }
      ]
    },
    llm: {
      enabled: true,
      homeArea: '扬州城',
      personality: ['精明', '圆滑', '消息灵通', '懂分寸'],
      background: ['经营扬州客栈多年', '熟悉南来北往的客商和江湖客', '擅长安排住店与歇脚'],
      knowledge: ['住宿', '过路人物', '江湖行脚路线', '扬州近期来客'],
      dailyRoutine: ['白天守柜台', '傍晚清点房钱', '偶尔去扬州街口招揽熟客'],
      movement: { allowedRooms: ['客栈', '扬州街'], idleMoveChance: 0.12 }
    }
  },
  '小二': { alias: 'waiter', quote: '客官，热酒热菜马上来。', money: 12, loot: ['抹布'], role: '客栈跑堂' },
  '江湖客': { alias: 'wanderer', quote: '刀口舔血的人，最讲究一个义字。', money: 40, loot: ['酒葫芦'], role: '江湖游侠' },
  '情报贩子': {
    alias: 'informer',
    quote: '想知道消息？那得看你出的价。',
    money: 90,
    loot: ['密报', '耳报夹条'],
    role: '消息贩子',
    homeArea: '扬州城',
    vendor: {
      category: '情报',
      items: [
        { name: '扬州传闻', price: 50, currency: 'coin', desc: '一条城中流传的八卦或风声。' },
        { name: '江湖密报', price: 120, currency: 'coin', desc: '更值钱的消息，通常牵涉人物或势力。' }
      ]
    },
    llm: {
      enabled: true,
      homeArea: '扬州城',
      personality: ['谨慎', '贪财', '老练', '说话留三分'],
      background: ['长期在扬州黑白两道之间贩卖消息', '靠倒卖风声吃饭', '懂得察言观色'],
      knowledge: ['城中八卦', '江湖密闻', '人物去向', '地下交易'],
      dailyRoutine: ['常驻暗巷茶摊附近', '有时出没客栈和码头找买家'],
      movement: { allowedRooms: ['暗巷', '客栈', '扬州码头', '扬州街'], idleMoveChance: 0.2 }
    }
  },
  '神秘人': { alias: 'mysteryman', quote: '有些事，知道得越少越安全。', money: 66, loot: ['黑色令牌'], role: '神秘人物' },
  '怪人': { alias: 'guairen', quote: '嘿嘿……你也听见井里有人说话了？', money: 24, loot: ['怪石', '破布条'], role: '荒地怪人' },
  '疯癫老者': { alias: 'fengdianlaozhe', quote: '庙里没神，井里没鬼，可人心里有什么，谁说得准？', money: 36, loot: ['残破纸符', '旧铜镜'], role: '疯癫异士' },
  '黑衣怪客': { alias: 'heiyiguaike', quote: '看见我的人，最好都当自己没看见。', money: 42, loot: ['黑布蒙面', '密信残角'], role: '行迹诡秘的怪客' },
  '井边怪人': { alias: 'jingbianguairen', quote: '别往下看，井底看久了，井底也会看你。', money: 30, loot: ['井绳碎段', '残旧护符'], role: '废井旁的怪人' },
  '疯和尚': { alias: 'fengheshang', quote: '佛像塌了，可香火还在，妙不妙？', money: 28, loot: ['香灰包', '破木鱼'], role: '破庙疯僧' },
  '夜行怪人': { alias: 'yexingguairen', quote: '白天走路，晚上走影子。你猜我现在走的是哪一样？', money: 48, loot: ['夜行布', '怪人残页'], role: '夜里出没的怪人' },
  '无名乞丐': { alias: 'wumingqigai', quote: '我什么都没看见，但要是赏口饭，兴许能想起一点。', money: 14, loot: ['破碗', '发霉馒头'], role: '躲在荒地边的乞丐' },
  '镖头': {
    alias: 'escortchief',
    quote: '走镖最重要的，是人和货都得活着。',
    money: 75,
    loot: ['镖旗', '押镖单'],
    role: '镖局首领',
    homeArea: '扬州城',
    vendor: {
      category: '行路补给',
      items: [
        { name: '行路干粮', price: 20, currency: 'coin', desc: '适合远行押镖途中充饥。' },
        { name: '简易地图', price: 45, currency: 'coin', desc: '标注扬州周边常走路线。' }
      ]
    },
    llm: {
      enabled: true,
      homeArea: '扬州城',
      personality: ['豪爽', '谨慎', '讲信誉', '护短'],
      background: ['在扬州经营镖局多年', '熟悉各路镖道和沿途风险', '和三教九流都打过交道'],
      knowledge: ['押镖路线', '城外风险', '驿道消息', '护送规矩'],
      dailyRoutine: ['白天坐镇镖局', '偶尔去扬州街看货源', '有时去城门问路况'],
      movement: { allowedRooms: ['镖局', '扬州街', '扬州城门', '东郊驿道'], idleMoveChance: 0.15 }
    }
  },
  '镖师': { alias: 'escort', quote: '拳头硬，路上才有人让路。', money: 35, loot: ['飞镖'], role: '镖局好手' },
  '六扇门捕头': {
    alias: 'constablechief',
    quote: '六扇门办案，闲人退避。',
    money: 88,
    loot: ['缉捕文书', '公门腰牌'],
    role: '六扇门捕头',
    homeArea: '扬州城',
    llm: {
      enabled: true,
      homeArea: '扬州城',
      personality: ['威严', '克制', '讲规矩', '心思深'],
      background: ['统领扬州城一线缉捕事务', '手上压着不少案子', '明面冷硬，内里重视是非'],
      knowledge: ['治安', '案情传闻', '通缉人物', '官府动向'],
      dailyRoutine: ['大多在六扇门分署办案', '也会巡查扬州街和城门'],
      movement: { allowedRooms: ['六扇门分署', '扬州街', '扬州城门'], idleMoveChance: 0.14 }
    }
  },
  '捕快': { alias: 'constable', quote: '见了官差，还不快配合。', money: 30, loot: ['铁尺'], role: '六扇门差役' },
  '赌徒': { alias: 'gambler', quote: '这一把我一定翻本！', money: 26, loot: ['骰子'], role: '赌场赌徒' },
  '庄家': { alias: 'dealer', quote: '买定离手，输了可别怨天。', money: 120, loot: ['筹码'], role: '赌场庄家' },
  '荷官': { alias: 'croupier', quote: '牌桌有牌桌的规矩，诸位莫乱来。', money: 100, loot: ['牌尺'], role: '赌场荷官' },
  '牌桌老李': { alias: 'oldli', quote: '打牌如行军，稳字当头。', money: 38, loot: ['旧纸牌'], role: '牌桌常客' },
  '牌桌老周': { alias: 'oldzhou', quote: '要么不炸，要炸就炸个痛快。', money: 45, loot: ['铜筹'], role: '牌桌常客' },
  '牌桌老孙': { alias: 'oldsun', quote: '牌路七分看手，三分看人。', money: 41, loot: ['茶盏'], role: '牌桌常客' },
  '船夫': { alias: 'boatman', quote: '顺风顺水，好过刀光剑影。', money: 18, loot: ['船桨碎片'], role: '撑船人' },
  '脚夫': { alias: 'porter', quote: '苦力换饭吃，不寒碜。', money: 10, loot: ['麻绳'], role: '码头脚夫' },
  '流浪猫': { alias: 'straycat', quote: '喵呜。', money: 0, loot: ['猫毛'], role: '野猫' },
  '守门士兵': { alias: 'gate_soldier', quote: '没有文书，谁也别想乱进。', money: 18, loot: ['木矛'], role: '守门兵' },
  '猎人': { alias: 'hunter', quote: '林子里没有废箭，只有没眼力的人。', money: 28, loot: ['兽皮'], role: '山野猎户' },
  '商贩': { alias: 'merchant', quote: '天南海北的货，我这儿都能凑。', money: 22, loot: ['货单'], role: '行商' },
  '码头脚夫': { alias: 'dockporter', quote: '一袋粮一口气，少一分都不行。', money: 11, loot: ['扁担'], role: '码头脚夫' },
  '商人': { alias: 'merchantman', quote: '有利可图的地方，就有我。', money: 50, loot: ['账册'], role: '商人' },
  '水手': { alias: 'sailor', quote: '海上讨生活的人，命都系在绳上。', money: 17, loot: ['水手刀'], role: '船员' },
  '浪子': { alias: 'drifter', quote: '风流不一定快活，漂泊倒是真。', money: 14, loot: ['折扇'], role: '浪荡子' },
  '王府侍卫': { alias: 'royalguard', quote: '王府重地，不可造次。', money: 60, loot: ['护卫腰牌'], role: '王府侍卫' },
  '卖艺人': { alias: 'performer', quote: '一招鲜，吃遍天。赏钱随意。', money: 13, loot: ['铜锣'], role: '街头艺人' },
  '围观群众': { alias: 'onlooker', quote: '有热闹不看，岂不白来一趟。', money: 6, loot: [], role: '围观百姓' },
  '霍休': { alias: 'huoxiu', quote: '钱能买来的东西，往往最便宜。', money: 300, loot: ['珠光密匙'], role: '珠光宝气阁主' },
  '珠宝商': { alias: 'jeweler', quote: '这块玉成色极好，只卖识货的人。', money: 140, loot: ['碎玉'], role: '珠宝商人' },
  '平南王': { alias: 'kingpingnan', quote: '天下大势，岂能只看江湖。', money: 260, loot: ['王府令'], role: '平南王' },
  '护卫统领': { alias: 'guardcaptain', quote: '护主不力，便是死罪。', money: 95, loot: ['精钢佩刀'], role: '护卫统领' },
  '青衣楼杀手': { alias: 'qingyi_assassin', quote: '接了单子，就没有回头路。', money: 110, loot: ['淬毒匕首'], role: '杀手' },
  '青衣楼主人': { alias: 'qingyi_master', quote: '楼中一百零八命，皆在我一念之间。', money: 180, loot: ['青衣令'], role: '青衣楼主' },
  '大内高手': { alias: 'imperial_guard', quote: '皇城之内，容不得半点轻狂。', money: 120, loot: ['金羽箭'], role: '大内高手' },
  '铁匠': { alias: 'blacksmith', quote: '兵器要想趁手，火候一分都差不得。', money: 45, loot: ['铁锤'], role: '铁匠' },
  '裁缝': { alias: 'tailor', quote: '针脚细密，才能穿得体面。', money: 24, loot: ['丝线'], role: '裁缝' },
  '药师': { alias: 'herbalist', quote: '药能救人，也能要命。看你怎么用。', money: 38, loot: ['药包'], role: '药师' },
  '店小二': { alias: 'innwaiter', quote: '小的眼尖手快，客官尽管吩咐。', money: 9, loot: ['酒壶'], role: '客栈跑堂' },
  '香客': { alias: 'pilgrim', quote: '佛前一炷香，求个心安。', money: 8, loot: ['香灰袋'], role: '香客' },
  '挑夫': { alias: 'carrier', quote: '肩上有担子，脚下就不能停。', money: 12, loot: ['扁担'], role: '挑夫' },
  '守门僧': { alias: 'gate_monk', quote: '佛门清净地，不可妄动刀兵。', money: 18, loot: ['木鱼槌'], role: '少林僧人' },
  '少林僧人': { alias: 'shaolin_monk', quote: '阿弥陀佛，施主请息怒。', money: 15, loot: ['佛珠'], role: '少林弟子' },
  '小沙弥': { alias: 'novice', quote: '师父说，心静才能见佛。', money: 5, loot: ['木念珠'], role: '少林沙弥' },
  '扫地僧': { alias: 'saodisen', quote: '地扫干净了，心也就亮了。', money: 1, loot: ['旧扫帚'], role: '藏经阁高僧' },
  '藏经阁长老': { alias: 'canonelder', quote: '经卷如海，没有耐性别想读懂。', money: 40, loot: ['经卷残页'], role: '少林长老' },
  '罗汉堂首座': { alias: 'arhatchief', quote: '拳不离心，脚不离地。', money: 35, loot: ['铜钵'], role: '罗汉堂首座' },
  '武僧': { alias: 'fightermonk', quote: '戒律归戒律，拳脚也不能荒废。', money: 22, loot: ['木棍'], role: '少林武僧' },
  '少林武僧': { alias: 'shaolinfighter', quote: '铁布衫练到极处，刀兵难侵。', money: 26, loot: ['僧袍'], role: '少林武僧' },
  '方丈': { alias: 'fangzhang', quote: '世间万法，皆在一念之间。', money: 60, loot: ['佛印'], role: '少林方丈' },
  '玄慈': { alias: 'xuanci', quote: '佛门慈悲，也需护持正道。', money: 55, loot: ['戒律文牒'], role: '少林高僧' },
  '游客': { alias: 'tourist', quote: '早知华山这么险，我就不穿这双鞋了。', money: 6, loot: ['纪念木牌'], role: '游客' },
  '华山弟子': { alias: 'huashan_disciple', quote: '华山剑法，讲究一个正与奇。', money: 20, loot: ['练功木剑'], role: '华山弟子' },
  '岳不群': { alias: 'yuebuqun', quote: '君子藏器于身，待时而动。', money: 100, loot: ['紫霞秘籍残页'], role: '华山掌门' },
  '风清扬': { alias: 'fengqingyang', quote: '剑法练到极致，便是无招胜有招。', money: 50, loot: ['断剑'], role: '剑术宗师' },
  '隐士': { alias: 'hermit', quote: '山中无岁月，人心最难测。', money: 21, loot: ['松子'], role: '山中隐士' },
  '华山仆役': { alias: 'huashan_servant', quote: '山上柴米贵，可别浪费。', money: 8, loot: ['柴刀'], role: '华山仆役' },
  '船长': { alias: 'captain', quote: '海雾再重，也总有破开的时候。', money: 90, loot: ['航海图'], role: '远洋船长' },
  '乘客': { alias: 'passenger', quote: '这趟船票不便宜，希望别遇上风暴。', money: 15, loot: ['船票'], role: '旅客' },
  '引航员': { alias: 'pilot', quote: '这一带暗礁多，没有我你们都得搁浅。', money: 34, loot: ['海图碎页'], role: '引航员' },
  '黑市商人': { alias: 'blackmarket', quote: '规矩只有一条，别问货哪来的。', money: 200, loot: ['黑市凭票'], role: '黑市商人' },
  '线人老王': { alias: 'laowang', quote: '消息能值钱，也能要命。', money: 48, loot: ['小纸条'], role: '线人' },
  '水手长': { alias: 'bosun', quote: '甲板上的活儿，偷懒一眼就看出来。', money: 27, loot: ['缆绳'], role: '水手长' },
  '天文台长': { alias: 'observatorychief', quote: '星空从不说谎，只是人看不懂。', money: 70, loot: ['观测记录'], role: '天文台长' },
  '研究员': { alias: 'researcher', quote: '数据不会骗人，除非你先骗了自己。', money: 18, loot: ['笔记本'], role: '研究员' },
  '保安': { alias: 'security', quote: '实验重地，闲杂人等止步。', money: 16, loot: ['门禁卡'], role: '安保' },
  '首席科学家': { alias: 'chiefscientist', quote: '未知并不可怕，可怕的是无知。', money: 120, loot: ['实验报告'], role: '首席科学家' },
  '金融大亨': { alias: 'tycoon', quote: '资本从不睡觉，机会也是。', money: 220, loot: ['黑卡'], role: '金融大亨' },
  '秘书': { alias: 'secretary', quote: '老板的时间，比金子还贵。', money: 36, loot: ['行程表'], role: '秘书' },
  '保镖': { alias: 'bodyguard', quote: '靠近一步，我就当你有敌意。', money: 44, loot: ['墨镜'], role: '保镖' },
  '居民': { alias: 'resident', quote: '最近这天象，看着就让人心慌。', money: 5, loot: ['钥匙串'], role: '居民' },
  '记者': { alias: 'reporter', quote: '真相总是要有人写出来的。', money: 19, loot: ['录音笔'], role: '记者' },
  '小孩': { alias: 'kid', quote: '我昨天真的看见天上有光！', money: 2, loot: ['玻璃珠'], role: '孩子' },
  '军官': { alias: 'officer', quote: '命令就是命令，不容讨价还价。', money: 80, loot: ['作战图'], role: '军官' },
  '士兵': { alias: 'soldier', quote: '站岗归站岗，眼睛可不能打盹。', money: 18, loot: ['军用水壶'], role: '士兵' },
  '安全局联络官': { alias: 'liaison', quote: '有些信息，知道的人越少越好。', money: 52, loot: ['加密终端'], role: '联络官' },
  '作战参谋': { alias: 'strategist', quote: '战争先打在纸上，才会打到地上。', money: 58, loot: ['战术稿'], role: '作战参谋' },
  '科学家': { alias: 'scientist', quote: '公式推到最后，往往是人性的问题。', money: 32, loot: ['草稿纸'], role: '科学家' },
  '通讯官': { alias: 'comms', quote: '信号一断，前线就是瞎子。', money: 24, loot: ['耳机'], role: '通讯官' },
  '天文学家': { alias: 'astronomer', quote: '宇宙很大，但危险有时来得很近。', money: 42, loot: ['星图'], role: '天文学家' },
  '接头人': { alias: 'contact', quote: '对暗号的人不对，话就不能说。', money: 33, loot: ['暗号纸'], role: '接头人' },
  '降临派长老': { alias: 'eto_elder', quote: '人类的时代，或许本就该结束了。', money: 95, loot: ['降临徽章'], role: '降临派长老' },
  'ETO成员': { alias: 'eto_member', quote: '主会降临，我们只需等待。', money: 28, loot: ['银色徽记'], role: 'ETO成员' },
  '大主教': { alias: 'archbishop', quote: '信仰若无代价，便不值一提。', money: 160, loot: ['祭坛圣徽'], role: '大主教' },
  '黄药师': { alias: 'huangyaoshi', quote: '世上俗礼，于我不过浮云。', money: 120, loot: ['玉箫碎片'], role: '桃花岛主' },
  '程英': { alias: 'chengying', quote: '世间难事，总有转圜余地。', money: 24, loot: ['青布巾'], role: '桃花岛门客' },
  '陆无双': { alias: 'luwushuang', quote: '谁敢欺我，我偏要和他斗到底。', money: 19, loot: ['短刀'], role: '江湖少女' }
};

const smartNpcBlueprints = {
  '老鸨': {
    tags: ['扬州重点NPC', '情报', '酒水', '社交核心'],
    commands: ['talk 老鸨', 'ask 老鸨 about 扬州城', 'list 老鸨', 'buy 女儿红', 'rumor 老鸨']
  },
  '客栈老板': {
    tags: ['扬州重点NPC', '住宿', '消息中转'],
    promptSeed: '掌握来往客商与江湖客的落脚信息，适合做住宿和行路信息类NPC。'
  },
  '情报贩子': {
    tags: ['扬州重点NPC', '情报交易', '灰色角色'],
    promptSeed: '偏向有偿卖消息，语气谨慎，适合高价值八卦与任务线索。'
  },
  '六扇门捕头': {
    tags: ['扬州重点NPC', '官面线索', '治安'],
    promptSeed: '熟悉扬州城治安案件、通缉、官府动向。'
  },
  '镖头': {
    tags: ['扬州重点NPC', '运输', '江湖路线'],
    promptSeed: '熟悉扬州与外地之间的路况、镖路和风险。'
  }
};

module.exports = { npcCatalog, smartNpcBlueprints };
