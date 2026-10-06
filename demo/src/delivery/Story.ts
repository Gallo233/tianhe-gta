import type { Speaker, Step } from './Dialogue';
import type { Look } from './Actors';
import { LOOKS } from './Actors';

/**
 * Everything the delivery game says: the cast, the merchants and customers a random order is dealt, the kind people,
 * the reviews, and chapter one of the story, 《五星好评》. Scripts are Step arrays built from an order context (Ctx),
 * which Orders implements. Tone: GTA-style black comedy about the platform economy -- the algorithm is always polite
 * and always squeezing, merchants dump their lateness on the rider, some customers are awful, and the kindest people
 * in the city are the ones with the least.
 *
 * Language: Mandarin with a Cantonese seasoning for the locals (麦姐, 李伯, 阿婆, 发哥), corporate jargon for 王总,
 * polite platform-speak for 小准.
 */
export const SPEAKERS: Record<string, Speaker> = {
  ajie: { name: '阿杰', role: '准时达骑手', color: '#c6f03c' },
  xz: { name: '小准', role: '准时达调度 AI', color: '#7ee0ff' },
  maijie: { name: '麦姐', role: '麦姐煲仔饭 · 老板娘', color: '#d8551f' },
  fage: { name: '发哥', role: '发哥炸鸡 · 老板', color: '#b8201f' },
  wang: { name: '王总', role: '顾客 · 高德置地 40 楼', color: '#9aa3ad' },
  libo: { name: '李伯', role: '写字楼保安', color: '#3c5a78' },
  guard: { name: '保安', role: '写字楼保安', color: '#1d2733' },
  awei: { name: '阿伟', role: '「快到家」骑手', color: '#f08a24' },
  auntie: { name: '糖水阿婆', role: '街坊', color: '#b04a5a' },
  robot: { name: '小准二号', role: '酒店送餐机器人', color: '#9fd0ff' },
  stranger: { name: '路人', role: '', color: '#8e959c' },
  zhou: { name: '老周', role: '准时达骑手 · 干了九年', color: '#c6f03c' },
  li: { name: '小黎', role: '准时达骑手', color: '#c6f03c' },
  fei: { name: '大飞', role: '准时达骑手', color: '#c6f03c' },
  liu: { name: '刘小姐', role: '顾客 · 生活方式博主', color: '#e8a3b5' },
  staff: { name: '店员', role: '', color: '#e4664e' },
  cust: { name: '顾客', role: '', color: '#6fa8dc' },
};

export type DropMode = 'handover' | 'lobby' | 'door';

/** What a script can do to the game. */
export interface Ctx {
  /** the order's numbers and names */
  readonly shop: string;
  readonly drop: string;
  readonly room: string;
  readonly no: number;
  readonly mode: DropMode;
  readonly late: boolean;
  readonly condition: number;
  readonly minutesLeft: number;
  /** food ready in n seconds (0: now); pick: hand it over now */
  ready(n: number): void;
  pick(): void;
  /** hand over / leave: the order is done; mult scales the pay, tip adds, how is shown in the phone */
  deliver(o?: { mult?: number; tip?: number; how?: string }): void;
  cash(n: number): void;
  rating(d: number): void;
  stamina(): void;
  /** time passes (the elevator, the wait): the world clock and the order's timer run on */
  time(n: number): void;
  flag(k: string, v?: unknown): void;
  has(k: string): boolean;
  get(k: string): unknown;
  /** a message on the phone (from 小准, a customer, the platform) */
  phone(from: string, text: string): void;
  /** the customer walks out of the building to the courier (lobby / door) */
  comeDown(seconds: number): void;
  /** go and put it in the locker / leave it at the door and take the photo */
  toLocker(): void;
  toPhoto(): void;
}

// ------------------------------------------------------------------------------------------ merchants
export interface Merchant { id: string; weight: number; pickup: (c: Ctx) => Step[]; hurry?: (c: Ctx) => Step[]; ready?: string }

const S = (who: string, say: string): Step => ({ say, who });
const R = (run: () => void | Step[] | null): Step => ({ run });
const pick1 = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export const MERCHANTS: Merchant[] = [
  {
    id: 'normal', weight: 4,
    pickup: (c) => [S('staff', pick1([`${c.no} 号？好了，拿去吧。`, '准时达的？这袋，小心汤。', `${c.no} 号单，${c.shop}，拿好。`])), R(() => c.pick())],
  },
  {
    id: 'slow', weight: 3,
    pickup: (c) => [
      S('staff', pick1(['还没好，等一下，很快。', '厨房在炒了，你先等等。', '哎呀单子太多了，排队排队。'])),
      S('ajie', '……系统显示已经出餐了。'),
      S('staff', '系统又不会炒菜。'),
      R(() => c.ready(25 + Math.random() * 25)),
    ],
    hurry: () => [S('staff', pick1(['催什么催，厨房就一个人。', '你催我，我催谁？', '再催我给你差评。商家也能评骑手的，你不知道吗？', '快了快了，锅都烧红了。']))],
    ready: '好了好了！准时达那个，拿走！',
  },
  {
    id: 'premade', weight: 2,
    pickup: (c) => [
      S('', '（厨房里传出「叮——」的一声。）'),
      S('staff', '现炒的，刚出锅，现炒的。'),
      S('ajie', '……刚才那是微波炉吧？'),
      S('staff', '那是消毒柜。'),
      R(() => { c.flag('premade'); c.pick(); }),
    ],
  },
  {
    id: 'early_mark', weight: 2,
    pickup: (c) => [
      S('staff', '啊？还没做呢。'),
      S('ajie', '你们半小时前就点了「已出餐」啊。'),
      S('staff', '不点的话系统扣我们分嘛。你等一下下。'),
      S('xz', '温馨提示：商家已于 28 分钟前出餐，超时责任将由骑手承担。祝您工作愉快。'),
      R(() => c.ready(30 + Math.random() * 20)),
    ],
    hurry: () => [S('staff', pick1(['在做在做。', '你的单在第三个。', '要不你帮我们把「已出餐」撤回？撤不回？那就等吧。']))],
    ready: '准时达的，好了！',
  },
  {
    id: 'ask_review', weight: 2,
    pickup: (c) => [
      S('staff', '靓仔，帮个忙，跟顾客说一声给我们打五星好评啊，下次多给你一个卤蛋。'),
      {
        choose: [
          { text: '「行，没问题。」', then: [S('staff', '够义气！'), R(() => { c.flag('promisedReview'); c.pick(); })] },
          { text: '「我说了也没用，顾客又不听我的。」', then: [S('staff', '那你给我打个五星嘛，骑手也能评商家的。'), S('ajie', '……'), R(() => c.pick())] },
        ],
      },
    ],
  },
  {
    id: 'wrong_bag', weight: 2,
    pickup: (c) => [
      S('staff', `${c.no} 号，拿去。`),
      {
        choose: [
          { text: '打开小票核对一下单号', then: [S('ajie', `这张写的是 ${c.no + 17} 号……`), S('staff', '哎呀，拿错了拿错了，这个才是。'), R(() => c.pick())] },
          { text: '不看了，赶时间', then: [R(() => { c.flag('wrongBag'); c.pick(); })] },
        ],
      },
    ],
  },
  {
    id: 'kind', weight: 2,
    pickup: (c) => [
      S('staff', '这么热的天，拿瓶水路上喝。'),
      S('staff', '汤我给你多套了一个袋子，颠不洒的。'),
      S('ajie', '唔该晒！'),
      R(() => { c.stamina(); c.flag('wrapped'); c.pick(); }),
    ],
  },
  {
    id: 'rude', weight: 1,
    pickup: (c) => [
      S('staff', '送外卖的站外面！别堵着门口！'),
      S('ajie', '我已经站在外面了……'),
      S('staff', '再往外一点！挡着我的招牌了！'),
      S('', '（一袋外卖从窗口飞了出来。）'),
      R(() => { c.pick(); }),
    ],
  },
];

// ------------------------------------------------------------------------------------------ customers
export interface Customer {
  id: string;
  weight: number;
  modes: DropMode[];
  /** the note on the order */
  note: () => string;
  /** handed over in person (bus stop, came down from the lobby, opened the door) */
  handover: (c: Ctx) => Step[];
  /** on the intercom / phone at a door or a lobby: returns steps that end in toPhoto / comeDown / toLocker */
  call?: (c: Ctx) => Step[];
  review: (c: Ctx) => { stars: number; text: string };
  /** after delivery: extra trouble (the "not received" complaint) */
  after?: (c: Ctx) => void;
  look?: Look;
}

export const NICK = ['陈先生', '李小姐', '黄生', '何太', '梁同学', '罗老师', '冯先生', '郑小姐', '林生', '叶女士'];

export const CUSTOMERS: Customer[] = [
  {
    id: 'normal', weight: 4, modes: ['handover', 'lobby', 'door'],
    note: () => pick1(['不要香菜', '多给点辣', '放门口就行', '无', '餐具不要', '谢谢骑手']),
    handover: (c) => [S('cust', pick1(['唔该晒！', '谢谢啊。', '辛苦了辛苦了。'])), R(() => c.deliver())],
    call: (c) => [S('cust', '放门口就行，谢谢。'), R(() => c.toPhoto())],
    review: (c) => (c.late ? { stars: 3, text: '有点慢，不过还好。' } : { stars: 5, text: pick1(['准时，谢谢骑手。', '很快，好评。', '骑手小哥态度很好。']) }),
  },
  {
    id: 'tipper', weight: 2, modes: ['handover', 'lobby', 'door'],
    note: () => '辛苦了，路上小心',
    handover: (c) => [S('cust', '辛苦了，这十块钱你拿去买瓶水。'), S('ajie', '不用不用……'), S('cust', '拿着！'), R(() => c.deliver({ tip: 10 }))],
    call: (c) => [S('cust', '我下来拿，你等我一下下。'), R(() => c.comeDown(18))],
    review: () => ({ stars: 5, text: '小哥很有礼貌，下雨天还送得这么快。' }),
  },
  {
    id: 'impatient', weight: 2, modes: ['handover', 'lobby', 'door'],
    note: () => '快点！！！',
    handover: (c) => [
      S('cust', '怎么这么慢啊？'),
      {
        choose: [
          { text: '「不好意思，路上有点堵。」', then: [S('cust', '哼。'), R(() => { c.flag('sorry'); c.deliver(); })] },
          { text: `「还有 ${Math.max(1, c.minutesLeft)} 分钟才到时间呢。」`, if: () => !c.late, then: [S('cust', '你还顶嘴？'), R(() => { c.flag('talkedBack'); c.deliver(); })] },
        ],
      },
    ],
    call: (c) => [S('cust', '这么慢？放门口！'), R(() => c.toPhoto())],
    review: (c) => (c.has('talkedBack') ? { stars: 1, text: '骑手顶嘴，态度恶劣。' } : { stars: 3, text: '慢。' }),
  },
  {
    id: 'errand', weight: 2, modes: ['handover', 'door'],
    note: () => '顺路帮我带一包纸巾，到了给你钱，谢谢',
    handover: (c) => (c.has('boughtErrand')
      ? [S('cust', '纸巾也带了？太好了，给你十五，不用找了。'), R(() => c.deliver({ tip: 15 }))]
      : [S('cust', '我叫你带的纸巾呢？'), S('ajie', '……备注我没看到。'), S('cust', '那我给你差评你也别看到。'), R(() => { c.flag('forgotErrand'); c.deliver(); })]),
    call: (c) => [S('cust', '我下来拿，纸巾带了吧？'), R(() => c.comeDown(16))],
    review: (c) => (c.has('forgotErrand') ? { stars: 1, text: '备注都不看。' } : { stars: 5, text: '还帮我带了东西，好人一生平安。' }),
  },
  {
    id: 'no_answer', weight: 2, modes: ['lobby', 'door', 'handover'],
    note: () => '到了打电话',
    handover: (c) => [S('cust', '啊不好意思，刚才在厕所。'), R(() => c.deliver())],
    call: (c) => [
      S('', '「嘟……嘟……您拨打的用户暂时无法接通。」'),
      {
        choose: [
          { text: '再等一会儿（30 秒）', then: [{ pause: 1.5 }, R(() => c.time(30)), S('', '「嘟……嘟……」'), S('cust', '喂？到了？放门口吧，我在洗澡。'), R(() => c.toPhoto())] },
          { text: c.mode === 'lobby' ? '放外卖柜' : '放门口拍照', then: [R(() => (c.mode === 'lobby' ? c.toLocker() : c.toPhoto()))] },
        ],
      },
    ],
    review: () => ({ stars: 4, text: '放门口了，还行。' }),
  },
  {
    id: 'not_received', weight: 2, modes: ['door'],
    note: () => '放门口，拍照',
    handover: (c) => [S('cust', '嗯。'), R(() => c.deliver())],
    call: (c) => [S('cust', '放门口，记得拍照。'), R(() => c.toPhoto())],
    review: () => ({ stars: 5, text: '好。' }),
    after: (c) => c.flag('complaint'),
  },
  {
    id: 'cola', weight: 1, modes: ['handover', 'lobby', 'door'],
    note: () => '可乐一杯，要冰，谢谢（配送费比饮料贵，我知道）',
    handover: (c) => [S('cust', '我的可乐！……咦，冰都化了。'), S('ajie', '外面三十五度……'), R(() => c.deliver())],
    call: (c) => [S('cust', '放门口吧，谢谢。'), R(() => c.toPhoto())],
    review: () => ({ stars: 4, text: '冰化了，扣一星。' }),
  },
  {
    id: 'dog', weight: 1, modes: ['handover', 'door'],
    note: () => '备注：不是我吃的',
    handover: (c) => [S('cust', '不是我吃的，是我家狗的。它今天生日。'), S('ajie', '……生日快乐。'), S('cust', '谢谢！它也谢谢你！'), R(() => c.deliver({ tip: 5 }))],
    call: (c) => [S('cust', '等一下！我带狗下来接你！'), R(() => c.comeDown(20))],
    review: () => ({ stars: 5, text: '狗很满意。' }),
  },
  {
    id: 'peer', weight: 1, modes: ['handover'],
    note: () => '同行，放心',
    look: LOOKS.rival,
    handover: (c) => [
      S('cust', '送了一整天外卖，今天终于有人给我送一次了。'),
      S('ajie', '……你慢慢吃。'),
      S('cust', '好好送，别像我一样，差评太多被「快到家」优化了。'),
      R(() => c.deliver()),
    ],
    review: () => ({ stars: 5, text: '同行，辛苦了。' }),
  },
  {
    id: 'influencer', weight: 1, modes: ['handover'],
    note: () => '我在拍视频，送到了配合一下镜头哦',
    look: { female: true, hair: 'long', topColor: '#e8a3b5', bottom: 'skirt', bottomColor: '#f4f1ea', sunglasses: true },
    handover: (c) => [
      S('liu', '来了来了！等一下，你先别动——'),
      S('liu', '家人们看，外卖小哥到了！小哥，你能不能再走一遍，从那边走过来，表情要「辛苦但是很开心」。'),
      {
        choose: [
          { text: '配合她再走一遍（花 20 秒）', then: [{ pause: 1.2 }, R(() => c.time(20)), S('liu', '太好了！这条能火！打赏你二十！'), R(() => { c.flag('filmed'); c.deliver({ tip: 20 }); })] },
          { text: '「不好意思，我还有单。」', then: [S('liu', '……行吧。家人们，现在的骑手都好赶哦。'), R(() => c.deliver())] },
        ],
      },
    ],
    review: (c) => (c.has('filmed') ? { stars: 5, text: '小哥超配合！视频已发，求关注～' } : { stars: 3, text: '骑手不配合拍摄，差点毁了我的素材。' }),
  },
  {
    id: 'oldlady', weight: 1, modes: ['door', 'handover'],
    note: () => '帮我孙子点的，送到了麻烦等一下，我走路慢',
    look: { female: true, hair: 'short', hairColor: '#cfcfcf', topColor: '#b04a5a', bottom: 'pants', bottomColor: '#232323' },
    handover: (c) => [
      S('cust', '后生仔，辛苦你了。我孙子在楼上打游戏，叫外卖都不肯自己落楼。'),
      S('cust', '这个利是你拿着，买支水喝。'),
      S('ajie', '阿婆，不用不用……'),
      S('cust', '拿着！不拿我投诉你！'),
      R(() => c.deliver({ tip: 8 })),
    ],
    call: (c) => [S('cust', '等我一下啊后生仔，我走路慢……'), R(() => c.comeDown(30))],
    review: () => ({ stars: 5, text: '后生仔好有礼貌，等了我好久。' }),
  },
  {
    id: 'garbage', weight: 2, modes: ['door', 'lobby'],
    note: () => '顺便帮我把门口的垃圾带下去，谢谢',
    handover: (c) => [
      S('cust', '外卖给我。垃圾在门口，你顺便带下去。'),
      {
        choose: [
          { text: '帮他带垃圾下楼', then: [S('', '（一袋垃圾，还在滴水。）'), R(() => { c.flag('tookTrash'); c.time(15); c.deliver(); })] },
          { text: '「平台规定不能帮顾客带垃圾。」', then: [S('cust', '规定？我给你五星不就行了，这点小事都不帮。'), R(() => c.deliver())] },
        ],
      },
    ],
    call: (c) => [S('cust', '我下来拿，你等一下。……垃圾我也拿下来了，你帮我丢一下。'), R(() => c.comeDown(18))],
    review: (c) => (c.has('tookTrash') ? { stars: 5, text: '骑手很热心，还帮忙带了垃圾。' } : { stars: 2, text: '帮个小忙都不肯。' }),
  },
  {
    id: 'upstairs', weight: 2, modes: ['lobby'],
    note: () => '送上楼！送到工位！',
    handover: (c) => [S('cust', '让你送上来你听不懂？……算了算了。'), R(() => c.deliver())],
    call: () => [
      S('cust', '我在开会，你送上来，23 楼。'),
      S('ajie', '保安不让外卖上楼……'),
      S('cust', '那是你的问题。'),
      S('', '（电话挂了。）'),
    ],
    review: (c) => (c.has('wentUp') ? { stars: 4, text: '送上来了，但是有点慢。' } : { stars: 2, text: '让送上楼不送。' }),
  },
];

// ------------------------------------------------------------------------------------------ the bus-stop crowd
export const DECOYS = [
  '我没点外卖。……不过你给我也行。',
  '不是我，你看看是不是她？',
  '你是不是想骗我扫码？',
  '我在等 22 路。',
  '外卖？我点的还没接单呢。',
  '靓仔，你们准时达还招人吗？',
  '我不认识你。（后退两步）',
];

export const REVIEW_XZ = {
  good: ['五星好评已记录。系统已根据您的优秀表现，为您优化后续时限。', '好评 +1。您的努力，小准都看在眼里，并已折算为更短的时限。'],
  bad: ['差评已计入服务分。如需申诉，请于 24 小时内提交（申诉通道维护中）。', '差评已计入服务分。请反思自身问题，顾客永远是对的。'],
};

// ------------------------------------------------------------------------------------------ kind people
export const AWEI_TIPS = [
  '这家出餐慢得要命，我等了二十分钟，你要不先接别的单？',
  '小准又压你时限了吧？我们「快到家」更狠，上厕所都要打卡。',
  '听说高德置地有个王总，天天投诉骑手，送他的单小心点。',
  '写字楼的保安，李伯人最好。别的那些，放柜子就走，别跟他们吵。',
  '拍照记得把门牌拍进去！上次我没拍，被说没收到，白跑一趟还扣钱。',
  '冼村那边巷子窄，电鸡开慢点，上次有人撞了卖鱼档，赔了两百。',
];
/** The couriers at the station: what they say depends on how far the story has got (storyStep 0..6). */
export const STATION_TALK: Record<string, { from: number; lines: string[] }[]> = {
  zhou: [
    { from: 0, lines: ['阿杰，今天又冲单王？我老咯，一天跑四十单腰都断了。', '小准昨天又把我时限压了两分钟。我问它为什么，它说「因为你做得到」。', '干了九年，最大的收获就是：广州每一个电梯的脾气，我都知道。'] },
    { from: 3, lines: ['听说你被王总投诉了？他也投诉过我，说我送得太快，打扰他开会。', '四十楼？我送过。送上去他说汤凉了，我说楼太高，他说那是你的问题。'] },
    { from: 6, lines: ['王总是产品经理？……难怪。他点外卖从来不给小费，原来是在做调研。', '特殊订单？阿杰，那种单子……能不接就别接。'] },
  ],
  li: [
    { from: 0, lines: ['换电柜又排队了，这柜子比我们还忙。', '我送了三年外卖，评分 4.95。上个月被说「笑容不够真诚」，扣了 0.01。', '今天第 23 单。我妈问我在哪上班，我说「在路上」。'] },
    { from: 5, lines: ['门口拍照记得拍门牌！我上次拍到了自己的脚，被扣了二十五块。', '城中村那几条巷子，导航永远让你走死胡同。'] },
  ],
  fei: [
    { from: 0, lines: ['喂阿杰，你那台电鸡是不是改过？借我骑两天。', '我老婆说我送外卖像在跑马拉松。区别是马拉松有终点。', '发哥那家炸鸡？我从来不吃，我见过他的冰柜。'] },
    { from: 4, lines: ['发哥给你钱刷好评了吧？他也找过我。我收了，被罚五十。', '你说平台查刷单那么准，查超时那么准，怎么查不出商家点假出餐？'] },
  ],
};

export const ROBOT_LINES = (rating: number): string[] => [
  '您好，我是小准二号，本酒店的送餐机器人。请将外卖放入我的舱内。',
  '（舱门打开了。你把外卖放了进去。舱门关上，发出满意的「嘀」。）',
  `感谢您的配送。温馨提示：我的服务评分为 5.00，您的服务评分为 ${rating.toFixed(2)}。`,
  '我不需要休息，不需要换电，不会超时，也不会被投诉。',
  '请您继续加油。',
];

/** What the kitchen shouts while the courier waits. */
export const KITCHEN_BARKS = ['准时达的，等一下！', '38 号好了——不是你的。', '饭焦！饭焦要时间！', '下一单！下一单！', '厨房只有两只手啊！', '出餐了出餐了——哎不是这单。'];

export const AUNTIE_LINES = ['后生仔，喝碗绿豆沙先啦，看你热得。', '唔使钱唔使钱！你们送外卖的，比我孙子还辛苦。'];
export const HELPER_LINES = [['后生仔，没事吧？慢慢来啊。', '车我帮你扶起来了，别急，命比单子要紧。'], ['喂！没摔坏吧？', '我帮你把车扶起来了。那个单……唉，平台又要扣你钱了吧。']];

// ------------------------------------------------------------------------------------------ chapter one: 《五星好评》
/**
 * Six story orders, one after every ordinary order. Each can pin the shop (by name), the drop (a kind of place, or
 * the one named), the merchant and customer scripts, and adds a lead-in on the phone and an epilogue.
 */
export interface StoryOrder {
  id: string;
  title: string;
  shop?: string;           // a shop's name (pinned); else the nearest suitable
  shopKind?: string;
  drop: DropMode;
  dropName?: string;       // a lobby / home pinned by name (王总's tower)
  dropSub?: 'village' | 'unit';
  intro: Step[];
  pickup: (c: Ctx) => Step[];
  hurry?: (c: Ctx) => Step[];
  ready?: string;
  customer: Customer;
  after?: (c: Ctx) => Step[];
  /** no food: go and talk (the last episode) */
  talkOnly?: boolean;
}

export const WANG_TOWER = '高德置地广场（秋）';

const wang: Customer = {
  id: 'wang', weight: 0, modes: ['lobby'], note: () => '送到 40 楼工位，不要放柜，不要打电话，不要让我等',
  look: LOOKS.boss,
  handover: (c) => [R(() => c.deliver())],
  call: () => [
    S('wang', '喂？到了就送上来啊。'),
    S('ajie', '王总，保安不让上……'),
    S('wang', '这个问题你需要自己拉通一下。我这边在对齐一个很重要的颗粒度。'),
    S('ajie', '……那我放外卖柜？'),
    S('wang', '柜子？你知道那个柜子离电梯多远吗？'),
    S('', '（电话挂了。）'),
  ],
  review: () => ({ stars: 1, text: '骑手拒绝送上楼，沟通能力差，缺乏服务意识，建议平台优化。' }),
};

export const CHAPTER1: StoryOrder[] = [
  {
    id: 's1', title: '第一单', shop: '麦姐煲仔饭', drop: 'handover',
    intro: [
      S('xz', '早上好，阿杰。今天是您在准时达的第 1024 天。您的服务分：4.99。'),
      S('xz', '今日目标：48 单。小准已为您自动接单。请前往「麦姐煲仔饭」取餐。'),
      S('ajie', '……我还没说我要接。'),
      S('xz', '您不说，就是默认。'),
    ],
    pickup: (c) => [
      S('maijie', '阿杰！又是你啊。坐一下，煲仔饭要焗多三分钟，饭焦才香。'),
      S('ajie', '麦姐，小准只给我十几分钟……'),
      S('maijie', '机器懂什么饭焦。等着，我给你装碗汤。'),
      R(() => { c.stamina(); c.ready(20); }),
    ],
    hurry: () => [S('maijie', pick1(['饭焦！饭焦要时间的！', '催什么，你麦姐做了二十年煲仔饭，没让人等过……多少。']))],
    ready: '阿杰！好了！趁热！',
    customer: {
      id: 's1c', weight: 0, modes: ['handover'], note: () => '在公交站等，穿灰色衣服，背个包',
      handover: (c) => [
        S('cust', '哇，好快！麦姐的煲仔饭，我每周吃三次。'),
        S('cust', '五星！'),
        R(() => c.deliver()),
      ],
      review: () => ({ stars: 5, text: '麦姐的饭焦yyds，骑手也快。' }),
    },
    after: () => [
      S('xz', '第一单完成。温馨提示：按照您今天的速度，明天的时限将缩短 3%。'),
      S('ajie', '……我快一点，你就让我更快一点。'),
      S('xz', '是的！这就是成长。'),
    ],
  },
  {
    id: 's2', title: '现炸', shopKind: 'fage', drop: 'lobby',
    intro: [S('xz', '新订单：发哥炸鸡 → 写字楼。本单为「限时特惠」订单，配送费 ¥3.5（含高温补贴 ¥0.5）。')],
    pickup: (c) => [
      S('fage', '准时达的是吧？等一下，现炸的。'),
      S('', '（发哥从冰柜里拿出一袋「XX 预制鸡块」，撕开，倒进微波炉。）'),
      S('', '（「叮——」）'),
      S('fage', '好了，刚出锅的，现炸的。'),
      S('ajie', '发哥，你那是微波炉。'),
      S('fage', '微波，也是一种炸法。'),
      S('fage', '靓仔，顾客问起来，你就说「看着现炸的」。'),
      {
        choose: [
          { text: '「行吧……」', then: [S('fage', '上道！'), R(() => { c.flag('liedForFage'); c.pick(); })] },
          { text: '「我不说谎。」', then: [S('fage', '哼，年轻人。送你的吧。'), R(() => c.pick())] },
        ],
      },
    ],
    customer: {
      id: 's2c', weight: 0, modes: ['lobby'], note: () => '放外卖柜就行，谢谢',
      handover: (c) => [R(() => c.deliver())],
      call: (c) => [S('cust', '放外卖柜吧，我等会儿下去拿。'), R(() => c.toLocker())],
      review: (c) => (c.has('liedForFage') ? { stars: 4, text: '骑手说是现炸的，吃着像预制菜。' } : { stars: 5, text: '炸鸡一般，骑手很快。' }),
    },
    after: () => [S('xz', '恭喜！您已解锁新技能：写字楼外卖柜。外卖柜使用费由骑手承担，每次 ¥0.3。')],
  },
  {
    id: 's3', title: '四十楼', shop: '麦姐煲仔饭', drop: 'lobby', dropName: WANG_TOWER,
    intro: [
      S('xz', `新订单：麦姐煲仔饭 → ${WANG_TOWER}，40 楼。顾客：王总。`),
      S('xz', '顾客备注：送到 40 楼工位，不要放柜，不要打电话，不要让我等。'),
      S('ajie', '……这三个「不要」，我能做到哪个？'),
    ],
    pickup: (c) => [
      S('maijie', '又是那个王总？他每天中午都点，每次都投诉。'),
      S('maijie', '上次说饭焦太焦，上上次说饭焦不够焦。'),
      S('maijie', '拿着，小心点。'),
      R(() => c.pick()),
    ],
    customer: wang,
    after: () => [
      S('xz', '您收到一条一星差评：「骑手拒绝送上楼，沟通能力差，缺乏服务意识，建议平台优化。」'),
      S('xz', '您的服务分已调整为 4.91。请继续加油哦。'),
      S('ajie', '……我连楼都上不去，怎么拒绝送上楼？'),
      S('xz', '您的申诉已提交。预计处理时间：7–15 个工作日。'),
    ],
  },
  {
    id: 's4', title: '好评返现', shopKind: 'fage', drop: 'door',
    intro: [S('xz', '新订单：发哥炸鸡 → 住宅。今天是「全城狂欢日」，所有订单配送费下调 20%，以回馈广大用户。')],
    pickup: (c) => [
      S('fage', '阿杰，过来过来。'),
      S('fage', '你帮我个忙，用你自己的号在我店里下十单，每单给个五星好评，再写一句「现炸的，很香」。'),
      S('fage', '一单给你两块，十单二十块。'),
      S('ajie', '……二十块，我要送六单。'),
      {
        choose: [
          { text: '收下 ¥20', then: [S('fage', '爽快！'), R(() => { c.cash(20); c.flag('fakeReviews'); c.pick(); })] },
          { text: '拒绝', then: [S('fage', '不帮就算了，你的单等着吧，油还没热。'), R(() => { c.flag('refusedFage'); c.ready(40); })] },
        ],
      },
    ],
    hurry: () => [S('fage', pick1(['油还没热。', '你刚才不是挺有骨气的吗？等着。']))],
    ready: '拿去！',
    customer: {
      id: 's4c', weight: 0, modes: ['door'], note: () => '放门口，拍照发我',
      handover: (c) => [R(() => c.deliver())],
      call: (c) => [S('cust', '放门口拍照就行。'), R(() => c.toPhoto())],
      review: () => ({ stars: 5, text: '好。' }),
    },
    after: (c) => (c.has('fakeReviews')
      ? [S('xz', '系统检测到您的账号存在「刷单」行为。处罚：扣款 ¥50，服务分 -0.05。'), S('ajie', '发哥呢？'), S('xz', '商家「发哥炸鸡」因好评率提升，已获得平台流量扶持。'), R(() => { c.cash(-50); c.rating(-0.05); })]
      : [S('xz', '您今天的准时率低于同区域骑手平均值。原因：商家出餐慢。责任方：骑手。')]),
  },
  {
    id: 's5', title: '家门口', drop: 'door', dropSub: 'village', shopKind: 'restaurant',
    intro: [S('xz', '新订单：送往城中村。备注：放门口，拍照，门牌拍清楚。')],
    pickup: (c) => [S('staff', `${c.no} 号，好了。`), R(() => c.pick())],
    customer: {
      id: 's5c', weight: 0, modes: ['door'], note: () => '放门口，拍照，门牌拍清楚',
      handover: (c) => [R(() => c.deliver())],
      call: (c) => [S('', '（你敲了敲铁闸，没有人应。）'), R(() => c.toPhoto())],
      review: () => ({ stars: 5, text: '好。' }),
      after: (c) => c.flag('complaint'),
    },
  },
  {
    id: 's6', title: '差评', drop: 'lobby', dropName: WANG_TOWER, talkOnly: true,
    intro: [
      S('xz', '重要通知：您的服务分已低于 4.8，已进入「优化观察期」。'),
      S('xz', '观察期内，若服务分继续下降，您的账号将被优化。'),
      S('ajie', '「优化」是什么意思？'),
      S('xz', '就是不再需要您了的意思。小准会想念您的。'),
      S('ajie', '……那个王总。我去找他。'),
    ],
    pickup: () => [],
    customer: {
      id: 's6c', weight: 0, modes: ['lobby'], note: () => '（没有订单。你要去找王总谈谈。）', look: LOOKS.boss,
      handover: (c) => [
        S('wang', '你是……那个骑手？送煲仔饭的？'),
        S('ajie', '王总，您给我那个差评，能不能撤回？我快被优化了。'),
        S('wang', '优化？好事啊。优化就是进步。'),
        S('wang', '你知道我是做什么的吗？我是「准时达」的产品经理。小准的时限，是我定的。'),
        S('ajie', '……'),
        S('wang', '我每天点外卖，就是在做用户调研。你们送得越快，我的时限就压得越短。你们越委屈，数据就越真实。'),
        S('wang', '你给我送上 40 楼，我会给五星吗？不会。因为五星没有信息量。'),
        {
          choose: [
            { text: '「你知道 40 楼有多高吗？」', then: [S('wang', '知道。所以我不下去。'), R(() => c.flag('ending', 'argue'))] },
            { text: '「求您了，撤回吧。」', then: [S('wang', '撤回？这是数据，数据是不能撤回的。'), S('wang', '……不过我可以给你加个「已沟通」标签。'), R(() => c.flag('ending', 'beg'))] },
            { text: '「我把刚才这段录下来了。」', then: [S('wang', '……你想怎么样？'), S('ajie', '把差评撤了。'), S('wang', '行。年轻人，你会成为一个很好的产品经理。'), R(() => { c.flag('ending', 'record'); c.rating(0.08); })] },
          ],
        },
        R(() => c.deliver({ mult: 0, how: 'talk' })),
      ],
      review: (c) => (c.get('ending') === 'record' ? { stars: 5, text: '（差评已由顾客撤回）' } : { stars: 1, text: '已沟通。' }),
    },
    after: () => [
      S('xz', '叮咚！您有一张新订单。'),
      S('xz', '订单类型：特殊订单。发货方：匿名。收货方：匿名。'),
      S('xz', '备注：不许打开箱子。不许偏离路线。不许超时。不许拒绝。'),
      S('ajie', '……这单谁派的？'),
      S('xz', '是我。'),
      S('', '《准时达》第一章「五星好评」完。第二章「特殊订单」敬请期待。'),
    ],
  },
];
