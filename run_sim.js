'use strict';
// Node.js バッチシミュレーター
// 使い方: node run_sim.js <stageFile> [towerPattern] [escortSpeed] [enemySpeed]
// 例:     node run_sim.js stages/stage_確定中級ステージ.json "normal:12,4 sniper:15,4"

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

// mockScene 用 add/textures/anims スタブ（simulator.html と共通・js/simStub.js）
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/simStub.js'), 'utf8'), ctx);

// balance.json を適用
const balance = JSON.parse(fs.readFileSync(path.join(ROOT, 'balance.json'), 'utf8'));
vm.runInContext(`applyBalance(${JSON.stringify(balance)})`, ctx);

// ─── SimTower（vm外で定義、ctx の TOWER_DEFS/UPGRADE_DEFS/cellCenter を参照） ─
function makeSimTower(col, row, type, log) {
  const TOWER_DEFS  = ctx.TOWER_DEFS;
  const UPGRADE_DEFS = ctx.UPGRADE_DEFS;
  const CELL        = ctx.CELL;
  const cellCenter  = ctx.cellCenter;
  const ESCORT_ENGAGE_RADIUS = ctx.ESCORT_ENGAGE_RADIUS;

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
        // 護衛範囲円（交戦ゲート）: 円の外のゾンビはタワーの射程内でも対象外
        if (escort && dist > ESCORT_ENGAGE_RADIUS) continue;
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
  // COLS/ROWS/MAP_W/MAP_H は config.js で let 宣言のため、ctx.X=... という外部からの代入では
  // vmコンテキスト内スクリプト（Zombie.js等）が bare 参照する束縛までは更新されない。
  // 内部からも明示的に再代入して同期する（さもないとROWS等がconfig.jsのデフォルト値のまま固定される）。
  vm.runInContext(`COLS=${ctx.COLS}; ROWS=${ctx.ROWS}; MAP_W=${ctx.MAP_W}; MAP_H=${ctx.MAP_H};`, ctx);

  const CELL       = ctx.CELL;
  const cellCenter = ctx.cellCenter;

  const pf         = new ctx.Pathfinder(ctx.COLS, ctx.ROWS, stage.obstacles ?? []);
  // road-only: ground_cellsが1件でも指定されていれば、それ以外の全セルをブロックする
  // （GameScene.jsと同一ロジック。opt-in仕様＝未指定なら従来通り全域移動可能）
  if (stage.ground_cells && stage.ground_cells.length > 0) {
    const roadSet = new Set(stage.ground_cells.map(c => `${c.col},${c.row}`));
    for (let c = 0; c < ctx.COLS; c++) {
      for (let r = 0; r < ctx.ROWS; r++) {
        if (!roadSet.has(`${c},${r}`)) pf.blocked.add(`${c},${r}`);
      }
    }
  }
  const ff         = new ctx.FlowField(pf);
  const mockScene  = { flowField: ff, _playLog: log, scaledTime: 0,
                       add: ctx.createMockSceneAdd(), textures: ctx.MOCK_TEXTURES, anims: ctx.MOCK_ANIMS };

  // ─── リレー状態（GameScene.jsの escortIdx/relayPhase/intervalTimer/survivors と同一設計） ───
  const RELAY_INTERVAL = 4000;  // GameScene.js の RELAY_INTERVAL と一致させること（1×基準・4000ms固定）
  const escortDefs = stage.escorts;
  const minSurvivors = stage.minSurvivors ?? 1;
  let escortIdx    = 0;
  let relayPhase   = 'active';  // 'active' | 'interval' | 'done'
  let intervalTimer = 0;
  let survivors    = 0;
  let escort, sem;

  // Y（寄り道防衛）状態。moneyは後段で宣言されるが、参照はコールバック実行時（クロージャ）なので順序問題なし
  let buildLocked = false;
  let yInflow     = null;

  // GameScene.js の _startEscort 相当: escortごとにEscort/SegmentManager(or SpawnEventManager)を作り直す
  function startEscort(idx, timeOffset) {
    const escDef = { ...escortDefs[idx] };
    if (opts.escortSpeed) escDef.speed = +opts.escortSpeed;
    const pixelPath = escDef.path.map(p => cellCenter(p.col, p.row));
    escort = new ctx.Escort(mockScene, pixelPath, escDef);
    if (escDef.segments) {
      sem = new ctx.SegmentManager(stage.spawns ?? {}, escDef.segments);
    } else {
      const spawnEvts = escDef.spawnEvents ?? stage.spawnEvents ?? [];
      sem = new ctx.SpawnEventManager(stage.spawns ?? {}, spawnEvts);
      sem.start(timeOffset);
    }

    // Y（寄り道防衛）コールバック配線（GameScene.jsのonDetour*と同一設計）
    escort.onDetourStart = () => {
      log.push(`[DETOUR_START]    t=${Math.round(mockScene.scaledTime)}ms → announcing`);
    };
    escort.onDetourActivate = () => {
      buildLocked = true;
      const walletAmount = escDef.detour?.walletAmount ?? 0;
      if (walletAmount > 0) {
        money += walletAmount;
        log.push(`[WALLET] t=${Math.round(mockScene.scaledTime)}ms 着席取得 +${walletAmount}  money=${money}`);
      }
      yInflow = new ctx.YInflowManager(stage.spawns ?? {}, escDef.detour?.yInflow ?? []);
      yInflow.start(mockScene.scaledTime);
      log.push(`[DETOUR_ACTIVATE] t=${Math.round(mockScene.scaledTime)}ms waitTime=${escDef.detour?.waitTime ?? 30000}ms buildLocked=true`);
    };
    escort.onDetourEnd = () => {
      buildLocked = false;
      yInflow?.retreatAll();
      yInflow = null;
      log.push(`[DETOUR_END]      t=${Math.round(mockScene.scaledTime)}ms buildLocked=false`);
    };
  }
  startEscort(0, 0);

  // GameScene.js の _onEscortDone 相当
  function onEscortDone(reached, scaledTime) {
    if (reached) {
      survivors++;
      log.push(`[REACH]  t=${Math.round(scaledTime)}ms  護衛ゴール到達  生存護衛=${survivors}`);
    }
    const nextIdx   = escortIdx + 1;
    const remaining = escortDefs.length - nextIdx;
    if (survivors + remaining < minSurvivors || nextIdx >= escortDefs.length) {
      relayPhase = 'done';
      return;
    }
    relayPhase    = 'interval';
    intervalTimer = RELAY_INTERVAL;
    log.push(`[RELAY_INTERVAL]  t=${Math.round(scaledTime)}ms  次の護衛=escortIdx${nextIdx}  interval=${RELAY_INTERVAL}ms`);
  }

  // GameScene.js の _activateNextEscort 相当
  function activateNextEscort(scaledTime) {
    escortIdx++;
    log.push(`[RELAY_START]  t=${Math.round(scaledTime)}ms  escortIdx=${escortIdx}  timeOffset=${Math.round(scaledTime)}ms`);
    startEscort(escortIdx, scaledTime);
    relayPhase = 'active';
  }

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
  let spawnTotal = 0, killCount = 0, closecallCount = 0, closestEver = Infinity;
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
      if (buildLocked) { log.push(`[WARN]   t=${Math.round(scaledTime)}ms Y中のためスキップ: ${tp.type}@(${tp.col},${tp.row})`); continue; }
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

    // GameScene.jsの更新順(ff→sem→zombie→tower→escort)をそのまま踏襲。
    // escortTarget: relayPhase==='active'の時だけ現escortを渡す（GameScene.jsのescortTargetと同一）
    if (escort.alive && !escort.reached) ff.update(escort.col, escort.row);
    const escortTarget = relayPhase === 'active' ? escort : null;
    sem.update(scaledTime, spawnFn, escortTarget);
    yInflow?.update(scaledTime, spawnFn);

    const alive = zombies.filter(z => z.alive);
    for (const z of alive) {
      z.update(scaledTime, DT, escortTarget);
      if (!z._firstContact && escortTarget) {
        const dx = escortTarget.x - z.x, dy = escortTarget.y - z.y;
        if (Math.sqrt(dx*dx + dy*dy) < CELL * 0.95) {
          z._firstContact = { col: z.col, row: z.row, t: scaledTime };
        }
      }
    }
    for (const t of simTowers) t.update(scaledTime, alive, escortTarget);
    escort.update(DT);  // escort は最後に更新（GameScene.jsと同じ順序）

    // GameScene.jsの_checkWinLose相当（relayPhase==='active'の時だけ判定）
    if (relayPhase === 'active') {
      if (escort.reached || escort.state === 'exiting') {
        onEscortDone(true, scaledTime);
      } else if (escort.defeated) {
        log.push(`[GAMEOVER] t=${Math.round(scaledTime)}ms  護衛HP=0  escortIdx=${escortIdx}`);
        onEscortDone(false, scaledTime);
      }
    }
    if (relayPhase === 'done') break;

    // CLOSE_CALL判定はrelayPhase==='active'時のみ（GameScene.jsと同一条件）
    for (const z of zombies) {
      if (!z.alive && !z._retreating && z._closestToEscort < CELL * 1.5 && relayPhase === 'active') {
        closecallCount++;
        if (z._closestToEscort < closestEver) closestEver = z._closestToEscort;
        log.push(`[CLOSE_CALL] t=${Math.round(scaledTime)}ms  dist=${Math.round(z._closestToEscort)}px → 撃破`);
      }
    }
    zombies = zombies.filter(z => z.alive);

    // インターバルカウントダウン（GameScene.jsのintervalTimer -= totalDtと同一設計）
    if (relayPhase === 'interval') {
      intervalTimer -= DT;
      if (intervalTimer <= 0) activateNextEscort(scaledTime);
    }

    scaledTime += DT;
  }
  if (scaledTime > MAX_TIME) log.push('[TIMEOUT] 最大時間(10分)超過');

  const total       = escortDefs.length;
  const passThrough = spawnTotal - killCount;
  const judgment    = survivors >= minSurvivors ? 'CLEAR' : 'GAMEOVER';
  const hpPct       = Math.round((escort.hp ?? 0) / (escort.maxHp || 1) * 100);
  const closestPx   = closestEver === Infinity ? '-' : Math.round(closestEver);
  log.push(`[RESULT] スポーン総数=${spawnTotal} 撃破=${killCount} すり抜け=${passThrough} 護衛生還=${survivors}/${total} HP残=${hpPct}% CLOSE_CALL=${closecallCount}回 最接近=${closestPx}px 判定=${judgment}`);

  return { log, judgment, hpPct, spawnTotal, killCount, passThrough, closecallCount, closestEver, survivors, total };
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
