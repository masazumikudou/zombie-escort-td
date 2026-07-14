// ─── 地面ブロック定義（editor.html の GROUND_BLOCK_DEFS と手動同期すること）
// blockCells: 1タイルが占めるセル数（正方形）。imagePx: 元画像の一辺px。
const GROUND_BLOCK_DEFS = {
  grass:          { blockCells: 4, imagePx: 256 },
  asphalt:        { blockCells: 4, imagePx: 256 },
  道路縦:             { blockCells: 1, imagePx: 256  },
  道路横:             { blockCells: 1, imagePx: 592  },
  road_vertical:      { blockCells: 1, imagePx: 591  },
  '道縦ノーマル (2)': { blockW: 2, blockH: 1, imagePxW: 400, imagePxH: 200  },
  '道縦マンホール (2)':{ blockW: 2, blockH: 1, imagePxW: 400, imagePxH: 200  },
  '道横':             { blockW: 1, blockH: 2, imagePxW: 530, imagePxH: 1060 },
};

// ─── グリッド ───────────────────────────────────────────────
const CELL    = 100;  // 1マスのピクセルサイズ
const MAX_ZOMBIES = 120; // 同時存在ゾンビ数の安全上限（クラッシュ防止用、難易度調整ではない）
let COLS    = 20;
let ROWS    = 15;
let MAP_W   = CELL * COLS;
let MAP_H   = CELL * ROWS;

// ─── キャンバス ─────────────────────────────────────────────
const CANVAS_W = 960;
const CANVAS_H = 640;
const UI_H     = 44;   // 下部ステータスバーの高さ

// ─── カメラ ─────────────────────────────────────────────────
const ZOOM_LEVELS        = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_ZOOM_IDX   = 2;       // 1.0
const AUTO_RETURN_DELAY  = 3000;    // ms（無操作後に護衛へ自動復帰）

// ─── 時間スケール ────────────────────────────────────────────
const TIME_SCALES = [0, 0.25, 1.0, 2.0, 3.0]; // 0=停止, 1=スロー, 2=通常, 3=2倍, 4=3倍
const TIME_LABELS = ['⏸ 停止', '🐢 スロー', '▶ 通常', '⏩ 2倍', '⏩⏩ 3倍'];

// ─── タワー定義 ──────────────────────────────────────────────
// range はセル単位（ピクセル = range * CELL）
// 数値（cost/range/fireRate/damage/durability）は balance.json で上書き。
// ここの数値は balance.json が読めなかった場合のフォールバック。
const TOWER_DEFS = {
  normal: { label:'ノーマル',   color:0x4488ff, textColor:'#5599ff', cost:120, sell:84,  range:2.5, fireRate:800,  damage:50,  durability:null },
  sniper: { label:'スナイパー', color:0x44ff88, textColor:'#55ffaa', cost:250, sell:175, range:4.5, fireRate:450,  damage:34,  durability:null },
  cannon: { label:'砲',         color:0xff8822, textColor:'#ffaa44', cost:180, sell:126, range:3.0, fireRate:1600, damage:100, durability:null },
  ice:    { label:'アイス',     color:0x44ccff, textColor:'#66ddff', cost:150, sell:105, range:2.5, fireRate:900,  damage:25,  durability:null },
  punch:  { label:'パンチ',     color:0xff6600, textColor:'#ff8833', cost:120, sell:84,  range:1.0, fireRate:2000, damage:100, durability:null },
};

// ─── タワー表示制限（難易度計測フェーズ用）─────────────────────
// null = 全種表示。配列指定 = その種類のみUIに表示（定義・コードは残る）
const TOWER_UNLOCK = ['normal', 'sniper', 'cannon', 'ice', 'punch'];

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
  tree:         { texture: 'prop/tree.png',    cols: 1, rows: 1 },
  木1:          { texture: 'prop/木1.png',     cols: 1, rows: 1 },
  木2:          { texture: 'prop/木2.png',     cols: 1, rows: 1 },
  ベンチ:       { texture: 'prop/ベンチ.png',  cols: 1, rows: 1, scale: 0.5 },
  公園:         { texture: 'prop/公園.png',   cols: 6, rows: 6 },
  駐車場:       { texture: 'prop/駐車場.png',      cols: 4, rows: 2 },
  駐車場車有り: { texture: 'prop/駐車場車有り.png', cols: 4, rows: 2 },
  家青:             { texture: 'prop/家青.png',           cols: 3, rows: 3 },
  家緑:             { texture: 'prop/家緑.png',           cols: 3, rows: 3 },
  スーパーマーケット: { texture: 'prop/スパーマーケット.png', cols: 6, rows: 3 },
  アイスクリーム:   { texture: 'prop/アイスクリーム.png',   cols: 3, rows: 3 },
  ハンバーガー:     { texture: 'prop/ハンバーガー.png',     cols: 3, rows: 3 },
  商店街:       { texture: 'prop/商店街.png',  cols: 15, rows: 3 },
  house5_front: { texture: 'prop/house5_front.png',  cols: 15, rows: 3 },
  house5_back:  { texture: 'prop/house5_back.png',   cols: 15, rows: 3 },
  道路横_prop:       { texture: 'ground/道路横.png',       cols: 1, rows: 1 },
  road_vertical_prop: { texture: 'ground/road_vertical.png', cols: 1, rows: 1 },
};

// ─── デカール定義（地面装飾、当たり判定なし） ─────────────────
// アセットパス: assets/sprites/decal/{type}.png
// editor.html の DECAL_DEFS と手動同期すること
const DECAL_DEFS = {
  crosswalk_h: { cols: 2, rows: 1 },
  crosswalk_v: { cols: 1, rows: 2 },
  manhole:     { cols: 1, rows: 1 },
  tree:        { cols: 1, rows: 1 },
  木1:         { cols: 1, rows: 1 },
  木2:         { cols: 1, rows: 1 },
  ベンチ:      { cols: 1, rows: 1, scale: 0.5 },
  縁石:        { cols: 2, rows: 1, scale: 0.5 },
  grave_rip:   { cols: 1, rows: 1 },
  grave_z:     { cols: 1, rows: 1 },
};

// ─── ゾンビ基準値 ────────────────────────────────────────────
// balance.json が読めない場合のフォールバック。数値は balance.json を正とする
const ZOMBIE_BASE = {
  salaryman: { hp: 75,  speed: 50, damage: 10, reward: 20, skin: 'salaryman' },
  worker:    { hp: 100, speed: 50, damage: 12, reward: 25, skin: 'worker'    },
  police:    { hp: 150, speed: 50, damage: 15, reward: 35, skin: 'police'    },
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

const ZOMBIE_TYPES    = [];
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
