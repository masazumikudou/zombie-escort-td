// ─── グリッド ───────────────────────────────────────────────
const CELL    = 64;   // 1マスのピクセルサイズ
const COLS    = 20;
const ROWS    = 15;
const MAP_W   = CELL * COLS;  // 1280
const MAP_H   = CELL * ROWS;  // 960

// ─── キャンバス ─────────────────────────────────────────────
const CANVAS_W = 960;
const CANVAS_H = 640;
const UI_H     = 44;   // 下部ステータスバーの高さ

// ─── カメラ ─────────────────────────────────────────────────
const ZOOM_LEVELS        = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_ZOOM_IDX   = 2;       // 1.0
const AUTO_RETURN_DELAY  = 3000;    // ms（無操作後に護衛へ自動復帰）

// ─── 時間スケール ────────────────────────────────────────────
const TIME_SCALES = [0, 0.25, 1.0]; // 0=停止, 1=スロー, 2=通常
const TIME_LABELS = ['⏸ 停止', '🐢 スロー', '▶ 通常'];

// ─── タワー定義 ──────────────────────────────────────────────
// range はセル単位（ピクセル = range * CELL）
// 数値（cost/range/fireRate/damage/durability）は balance.json で上書き。
// ここの数値は balance.json が読めなかった場合のフォールバック。
const TOWER_DEFS = {
  basic:  { label:'基本', color:0x4488ff, textColor:'#5599ff', cost:100, sell:50,  range:2.5, fireRate:900,  damage:25, durability:null },
  rapid:  { label:'速射', color:0xff8800, textColor:'#ff9933', cost:150, sell:75,  range:2.0, fireRate:250,  damage:10, durability:null },
  sniper: { label:'狙撃', color:0x44ff88, textColor:'#55ffaa', cost:200, sell:100, range:4.5, fireRate:1600, damage:70, durability:null },
};

// ─── プロップ定義 ────────────────────────────────────────────
// アセットパス: assets/sprites/prop/{type}.png
// col/row はステージ JSON でのプロップ左上セル座標
const PROP_DEFS = {
  shop:       { texture: 'prop/shop.png',       cols: 4, rows: 4 },
  shop_front:  { texture: 'prop/shop_front.png',  cols: 3, rows: 3 },
  shop_back:   { texture: 'prop/shop_back.png',   cols: 3, rows: 3 },
  house_front:  { texture: 'prop/house_front.png',  cols: 3, rows: 3 },
  house_back:   { texture: 'prop/house_back.png',   cols: 3, rows: 3 },
  guardrail_h:  { texture: 'prop/guardrail_h.png',  cols: 1, rows: 1 },
  guardrail_v:  { texture: 'prop/guardrail_v.png',  cols: 1, rows: 1 },
};

// ─── ゾンビ基準値 ────────────────────────────────────────────
// balance.json が読めない場合のフォールバック。数値は balance.json を正とする
const ZOMBIE_BASE = {
  normal:        { hp: 30, speed: 55, damage: 10, reward: 20 },
  normal_cap:    { hp: 45, speed: 62, damage: 13, reward: 25 },
  normal_helmet: { hp: 60, speed: 70, damage: 18, reward: 30 },
  alt:           { hp: 35, speed: 58, damage: 11, reward: 22 },
  alt_helmet:    { hp: 65, speed: 68, damage: 19, reward: 32 },
  alt_cap:       { hp: 50, speed: 64, damage: 15, reward: 27 },
};

// balance.json の数値を TOWER_DEFS と ZOMBIE_BASE に反映する（BootScene から呼ぶ）
function applyBalance(b) {
  if (!b) return;
  const sellRate = b.sellRate ?? 0.5;
  Object.entries(b.towers ?? {}).forEach(([type, stats]) => {
    if (!TOWER_DEFS[type]) return;
    Object.assign(TOWER_DEFS[type], stats);
    TOWER_DEFS[type].sell = Math.floor(TOWER_DEFS[type].cost * sellRate);
  });
  Object.entries(b.zombies ?? {}).forEach(([type, stats]) => {
    // flags は別枠のため数値フィールドのみマージ
    const { hp, speed, damage, reward } = stats;
    ZOMBIE_BASE[type] = { ...ZOMBIE_BASE[type], hp, speed, damage, reward };
  });
}

// ─── アセットパス（差し替えポイント） ─────────────────────────
// ASSET SWAP POINT: 各キー先に実スプライトを置けば即差し替え可能
const ASSET_PATHS = {
  escort: {
    run: 'assets/sprites/escort/run_{dir}_{n}.png',  // dir=r/l/u/d, n=1..6
  },
  zombie: {
    run: 'assets/sprites/zombie/run_{dir}_{n}.png',
  },
  audio: {
    shoot:  'assets/audio/shoot.wav',
    hit:    'assets/audio/hit.wav',
    groan:  'assets/audio/groan.wav',
    clear:  'assets/audio/clear.wav',
    gameover: 'assets/audio/gameover.wav',
  }
};

// ─── スプライト規約 ──────────────────────────────────────────
// ファイルを配置するだけでコード変更なしに本素材へ切り替わる。
// キー命名規則: {entity}_{variant}_{dir}_{frame:02d}
//   entity  : zombie | escort | tower | obstacle
//   variant : zombie種別 or 護衛バリアント（後述）
//   dir     : down | up | right  (left は right を setFlipX で対応)
//   frame   : 01, 02, 03 ...
//
// ファイルパス規約:
//   ゾンビ  : assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
//   護衛    : assets/sprites/escort/{variant}/walk_{dir}_{frame:02d}.png
//   タワー  : assets/sprites/tower/{type}.png
//   遮蔽物  : assets/sprites/obstacle/building.png
//   音声    : assets/audio/{name}.wav

const ZOMBIE_TYPES    = ['normal','normal_helmet','normal_cap','alt','alt_helmet','alt_cap'];
const ESCORT_VARIANTS = ['dad','mom','grandma'];
const WALK_DIRS       = ['down','up','left','right']; // 移動方向ロジック用（4方向）
const SPRITE_DIRS     = ['down','up','right'];        // スプライット読み込み用（left は right を反転）

// ─── アニメーション定義 ──────────────────────────────────────
// バリアント／種別ごとにフレーム数・fpsを上書き可能（デフォルト6フレーム）
const ANIM_DEFS = {
  zombie: { default: { frames: 6, fps: 8 } },
  escort: { default: { frames: 6, fps: 6 } },
};
const zombieFrameCount = type    => (ANIM_DEFS.zombie[type]    ?? ANIM_DEFS.zombie.default).frames;
const zombieFps        = type    => (ANIM_DEFS.zombie[type]    ?? ANIM_DEFS.zombie.default).fps;
const escortFrameCount = variant => (ANIM_DEFS.escort[variant] ?? ANIM_DEFS.escort.default).frames;
const escortFps        = variant => (ANIM_DEFS.escort[variant] ?? ANIM_DEFS.escort.default).fps;

const _pad = n => String(n).padStart(2, '0');
const zombieTexKey  = (type, dir, frame) => `zombie_${type}_${dir}_${_pad(frame)}`;
const escortTexKey  = (variant, dir, frame) => `escort_${variant}_${dir}_${_pad(frame)}`;

// ─── ユーティリティ ──────────────────────────────────────────
function cellCenter(col, row) {
  return { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
}

function dirFromVec(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}
