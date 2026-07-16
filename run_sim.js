'use strict';
// Node.js バッチシミュレーター
// 使い方: node run_sim.js <stageFile> [towerPattern] [escortSpeed] [enemySpeed]
// 例:     node run_sim.js stages/stage_01_meander_verified.json "normal:12,4 sniper:15,4"

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ─── ゲームファイル読み込み順（順序厳守） ────────────────────────────────────
const files = [
  'js/config.js',
  'js/pathfinder.js',
  'js/FlowField.js',
  'js/SpawnEventManager.js',  // FormationGroup を含む
  'js/Escort.js',
  'js/Zombie.js',
];

// ─── vm コンテキスト構築 ─────────────────────────────────────────────────────
const ctx = vm.createContext({
  console,
  Math,
  JSON,
  setTimeout,
  clearTimeout,
  // Phaser/audio スタブ
  audioSynth: { hit() {}, escortHit() {} },
});

const ROOT = path.resolve(__dirname);
for (const f of files) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  vm.runInContext(code, ctx);
}

// balance.json を適用
const balance = JSON.parse(fs.readFileSync(path.join(ROOT, 'balance.json'), 'utf8'));
vm.runInContext(`applyBalance(${JSON.stringify(balance)})`, ctx);

// ─── SimTower（vm外で定義、ctx の TOWER_DEFS/UPGRADE_DEFS/cellCenter を参照） ─
function makeSimTower(col, row, type, log) {
  const TOWER_DEFS  = ctx.TOWER_DEFS;
  const UPGRADE_DEFS = ctx.UPGRADE_DEFS;
  const CELL        = ctx.CELL;
  const cellCenter  = ctx.cellCenter;

  const cc = cellCenter(col, row);
  const d  = TOWER_DEFS[type] ?? TOWER_DEFS.normal;
  return {
    x: cc.x, y: cc.y,
    range:    d.range * CELL,
    fireRate: d.fireRate,
    damage:   d.damage,
    lastFire: -99999,
    _bullets: [],
    _type:    type,
    _col:     col,
    _row:     row,
    _label:   `${type}@(${col},${row})`,
    upgradeLevel:  1,
    _baseDamage:   d.damage,
    _baseFireRate: d.fireRate,
    _log(msg) { log.push(msg); },
    _applyUpgradeStats() {
      const ups = UPGRADE_DEFS?.perType?.[this._type];
      if (!ups) return;
      const n = this.upgradeLevel - 1;
      if (ups.dmgMult)      this.damage   = Math.round(this._baseDamage   * Math.pow(ups.dmgMult, n));
      if (ups.fireRateMult) this.fireRate = Math.round(this._baseFireRate  / Math.pow(ups.fireRateMult, n));
    },
    upgrade() {
      const maxLv = UPGRADE_DEFS?.maxLevel ?? 3;
      if (this.upgradeLevel >= maxLv) return false;
      this.upgradeLevel++;
      this._applyUpgradeStats();
      return true;
    },
    update(scaledTime, zombies, escort) {
      this._bullets = this._bullets.filter(b => {
        if (scaledTime < b.arrivesAt) return true;
        if (b.target.alive) b.target.takeDamage(this.damage);
        return false;
      });
      if (scaledTime - this.lastFire < this.fireRate) return;
      let best = null, bestDist = Infinity;
      for (const z of zombies) {
        if (!z.alive) continue;
        const tdx = z.x - this.x, tdy = z.y - this.y;
        if (Math.sqrt(tdx*tdx + tdy*tdy) > this.range) continue;
        const ref = escort ?? { x: this.x, y: this.y };
        const edx = z.x - ref.x, edy = z.y - ref.y;
        const dist = Math.sqrt(edx*edx + edy*edy);
        if (dist < bestDist) { bestDist = dist; best = z; }
      }
      if (!best) return;
      const fdx  = best.x - this.x, fdy = best.y - this.y;
      const dist = Math.sqrt(fdx*fdx + fdy*fdy);
      const arrivesAt = scaledTime + (dist / 500) * 1000;
      this._bullets.push({ arrivesAt, target: best });
      this.lastFire = scaledTime;
      this._log(`[FIRE] t=${Math.round(scaledTime)}ms tower=${this._label} → id=${best._logId} dist=${Math.round(dist)} eta=${Math.round(arrivesAt)}ms`);
    },
  };
}

// ─── タワー配置テキスト解析 ────────────────────────────────────────────────
// 形式: "normal:5,3 sniper:8,3"    即時建設
//       "sniper:7,14@90000"         t=90000ms に建設
//       "upgrade:5,3@60000"         t=60000ms に (5,3) を強化
function parseTowerPattern(text) {
  if (!text || !text.trim()) return [];
  return text.trim().split(/[\s\n]+/).flatMap(token => {
    const m = token.match(/^(\w+):(\d+),(\d+)(?:@(\d+))?$/);
    return m ? [{ type: m[1], col: +m[2], row: +m[3], buildAt: m[4] !== undefined ? +m[4] : 0 }] : [];
  });
}

// ─── シミュレーション本体 ─────────────────────────────────────────────────────
function run(stageFile, towerPattern = '', opts = {}) {
  ctx.Zombie._seq = 0;  // 連続run()でのIDリセット

  const stage = JSON.parse(fs.readFileSync(path.join(ROOT, stageFile), 'utf8'));
  const log   = [];

  ctx.COLS  = stage.grid.cols;
  ctx.ROWS  = stage.grid.rows;
  ctx.MAP_W = ctx.CELL * ctx.COLS;
  ctx.MAP_H = ctx.CELL * ctx.ROWS;

  const CELL       = ctx.CELL;
  const cellCenter = ctx.cellCenter;

  const pf         = new ctx.Pathfinder(ctx.COLS, ctx.ROWS, stage.obstacles ?? []);
  const ff         = new ctx.FlowField(pf);
  const mockScene  = { flowField: ff, _playLog: log, scaledTime: 0 };

  // 護衛（first escort のみ）
  const escDef    = { ...stage.escorts[0] };
  if (opts.escortSpeed) escDef.speed = +opts.escortSpeed;
  const pixelPath = escDef.path.map(p => cellCenter(p.col, p.row));
  const escort    = new ctx.Escort(mockScene, pixelPath, escDef);

  // SpawnEventManager: escortDef.spawnEvents → 上位 spawnEvents にフォールバック
  const spawnEvts = escDef.spawnEvents ?? stage.spawnEvents ?? [];
  const sem       = new ctx.SpawnEventManager(stage.spawns ?? {}, spawnEvts);
  sem.start(0);

  // タワー
  const towerPlacements = parseTowerPattern(towerPattern);
  const simTowers = [];
  let money = stage.startMoney ?? 500;

  const delayedQueue = [];
  for (const tp of towerPlacements) {
    if (tp.buildAt > 0) { delayedQueue.push(tp); continue; }
    if (tp.type === 'upgrade') {
      const t = simTowers.find(t => t._col === tp.col && t._row === tp.row);
      if (t) { t.upgrade(); log.push(`[UPGRADE] upgrade@(${tp.col},${tp.row}) Lv${t.upgradeLevel}`); }
      else    { log.push(`[WARN]   upgrade@(${tp.col},${tp.row}) タワー未発見`); }
      continue;
    }
    const TOWER_DEFS = ctx.TOWER_DEFS;
    const def = TOWER_DEFS[tp.type];
    if (!def) { log.push(`[WARN]   不明タワー種別: ${tp.type}`); continue; }
    if (money < def.cost) { log.push(`[WARN]   資金不足: ${tp.type}@(${tp.col},${tp.row}) cost=${def.cost} 残=${money}`); continue; }
    simTowers.push(makeSimTower(tp.col, tp.row, tp.type, log));
    money -= def.cost;
    log.push(`[BUILD]  ${tp.type}@(${tp.col},${tp.row})  cost=${def.cost}  残=${money}`);
  }
  delayedQueue.sort((a, b) => a.buildAt - b.buildAt);

  // ゾンビ管理
  let zombies = [], allSpawned = [];
  let spawnTotal = 0, killCount = 0;
  let scaledTime = 0;

  const spawnFn = (col, row, def, waveNum, leader) => {
    const finalDef = opts.enemySpeed ? { ...def, speed: +opts.enemySpeed } : def;
    spawnTotal++;
    const z = new ctx.Zombie(mockScene, col, row, finalDef, waveNum, leader);
    z._firstContact = null;
    z.onDeath = () => {
      killCount++;
      money += z.reward ?? 0;
      log.push(`[KILL]   t=${Math.round(scaledTime)}ms  id=${z._logId}  killCount=${killCount}  reward+${z.reward ?? 0}  残=${money}`);
    };
    zombies.push(z);
    allSpawned.push(z);
    log.push(`[SPAWN]  t=${Math.round(scaledTime)}ms  id=${z._logId}  spawn=(${col},${row})  hp=${finalDef.hp}  total=${spawnTotal}`);
    return z;
  };

  // ─── シミュレーションループ ──────────────────────────────────────────────────
  const DT       = 50;
  const MAX_TIME = 600_000;

  while (scaledTime <= MAX_TIME) {
    mockScene.scaledTime = scaledTime;

    // 時間指定タワー
    while (delayedQueue.length > 0 && delayedQueue[0].buildAt <= scaledTime) {
      const tp = delayedQueue.shift();
      if (tp.type === 'upgrade') {
        const t = simTowers.find(t => t._col === tp.col && t._row === tp.row);
        if (t) { t.upgrade(); log.push(`[UPGRADE] t=${Math.round(scaledTime)}ms  upgrade@(${tp.col},${tp.row}) Lv${t.upgradeLevel}`); }
        else    { log.push(`[WARN]   t=${Math.round(scaledTime)}ms  upgrade@(${tp.col},${tp.row}) タワー未発見`); }
        continue;
      }
      const TOWER_DEFS = ctx.TOWER_DEFS;
      const def = TOWER_DEFS[tp.type];
      if (!def) { log.push(`[WARN]   不明タワー種別: ${tp.type}`); continue; }
      if (money < def.cost) { log.push(`[WARN]   t=${Math.round(scaledTime)}ms 資金不足: ${tp.type}@(${tp.col},${tp.row}) cost=${def.cost} 残=${money}`); continue; }
      simTowers.push(makeSimTower(tp.col, tp.row, tp.type, log));
      money -= def.cost;
      log.push(`[BUILD]  t=${Math.round(scaledTime)}ms  ${tp.type}@(${tp.col},${tp.row})  cost=${def.cost}  残=${money}`);
    }

    if (!escort.defeated && !escort.reached) ff.update(escort.col, escort.row);
    sem.update(scaledTime, spawnFn, escort.defeated ? null : escort);

    const alive = zombies.filter(z => z.alive);
    for (const z of alive) {
      z.update(scaledTime, DT, escort.defeated ? null : escort);
      if (!z._firstContact && !escort.defeated) {
        const dx = escort.x - z.x, dy = escort.y - z.y;
        if (Math.sqrt(dx*dx + dy*dy) < CELL * 0.95) {
          z._firstContact = { col: z.col, row: z.row, t: scaledTime };
        }
      }
    }
    for (const t of simTowers) t.update(scaledTime, alive, escort.defeated ? null : escort);
    escort.update(DT);

    if (escort.defeated) {
      log.push(`[GAMEOVER] t=${Math.round(scaledTime)}ms  護衛HP=0`);
      break;
    }
    if (escort.state === 'exiting' || escort.reached) {
      log.push(`[REACH]  t=${Math.round(scaledTime)}ms  護衛ゴール到達`);
      break;
    }
    if (zombies.length > 400) zombies = zombies.filter(z => z.alive);
    scaledTime += DT;
  }
  if (scaledTime > MAX_TIME) log.push('[TIMEOUT] 最大時間(10分)超過');

  const survived   = (escort.state === 'exiting' || escort.reached) ? 1 : 0;
  const passThrough = spawnTotal - killCount;
  const judgment   = survived >= (stage.minSurvivors ?? 1) ? 'CLEAR' : 'GAMEOVER';
  const hpPct      = Math.round(escort.hp / escort.maxHp * 100);
  log.push(`[RESULT] スポーン総数=${spawnTotal} 撃破=${killCount} すり抜け=${passThrough} 護衛生還=${survived}/1 HP残=${hpPct}% 判定=${judgment}`);

  return { log, judgment, hpPct, spawnTotal, killCount, passThrough };
}

// ─── CLI エントリ ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const [,, stageFile, towerPattern, escortSpeed, enemySpeed] = process.argv;
  if (!stageFile) {
    console.error('使い方: node run_sim.js <stageFile> [towerPattern] [escortSpeed] [enemySpeed]');
    process.exit(1);
  }
  const result = run(stageFile, towerPattern, { escortSpeed, enemySpeed });
  console.log(result.log.join('\n'));
}

module.exports = { run, parseTowerPattern };
