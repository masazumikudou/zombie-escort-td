'use strict';
// Node.js バッチシミュレーター
// 使い方: node run_sim.js <stageFile> [towerPattern] [escortSpeed] [enemySpeed] [maxTimeMs]
// maxTimeMs省略時はステージJSONのsimMaxTimeMs、それも無ければ既定600000ms(10分)
// 例:     node run_sim.js stages/stage_確定中級ステージ.json "normal:12,4 sniper:15,4"
//
// スイープモード（2-7 機能A・数値の感度分析。タワー配置の探索はしない）:
// 使い方: node run_sim.js <stageFile> [--tower "<配置>"] --sweep KEY=START..END:STEP
// 対応KEY: startMoney / escortSpeed / enemyCountMul / enemyHpMul / triggerIntervalMul
// 例:     node run_sim.js stages/stage_確定中級ステージ.json --tower "normal:12,4 sniper:15,4" --sweep startMoney=600..1400:100
//
// 通常実行時（スイープでなくても）、RESULT行に続けて護衛被弾・すり抜けのスポーン地点別
// 内訳（[DAMAGE_BY_SPAWN]/[LEAK_BY_SPAWN]、2-7 機能B）を出力する。

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
      const noAA = (this._type === 'cannon' || this._type === 'ice' || this._type === 'punch');  // 対空不可タワー
      let best = null, bestDist = Infinity;
      for (const z of zombies) {
        if (!z.alive) continue;
        if (noAA && z._flying) continue;
        const tdx = z.x - this.x, tdy = z.y - this.y;
        if (Math.sqrt(tdx*tdx + tdy*tdy) > this.range) continue;
        const ref = escort ?? { x: this.x, y: this.y };
        const edx = z.x - ref.x, edy = z.y - ref.y;
        const dist = Math.sqrt(edx*edx + edy*edy);
        // 護衛範囲円（交戦ゲート）: 円の外のゾンビはタワーの射程内でも対象外。
        // 鳥（_flying）のみ例外（v2.1確定事項に対する初の例外・2026-07-23小松判断）
        if (escort && !z._flying && dist > ESCORT_ENGAGE_RADIUS) continue;
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
// stageFile（ファイルパス）を読み込んでrunStageに渡す薄いラッパー。
// スイープモードは同一stageオブジェクトを使い回して何度もrunStageを呼ぶため、
// ファイル読み込み自体はrunStageから切り離してある。
function run(stageFile, towerPattern = '', opts = {}) {
  const stage = JSON.parse(fs.readFileSync(path.join(ROOT, stageFile), 'utf8'));
  return runStage(stage, towerPattern, opts);
}

function runStage(stage, towerPattern = '', opts = {}) {
  ctx.Zombie._seq = 0;  // 連続run()でのIDリセット

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
  // ブロック型タイル(blockW/blockH・道縦ノーマル(2)等)は原点セルのみ記録されているため、
  // 幅・高さ分を展開してから歩行可能判定に使う（描画側は元々展開済み・判定側だけ漏れていた）
  if (stage.ground_cells && stage.ground_cells.length > 0) {
    const roadSet = new Set();
    for (const cell of stage.ground_cells) {
      const bdef = ctx.GROUND_BLOCK_DEFS?.[cell.type];
      const bw = bdef ? (bdef.blockW ?? bdef.blockCells ?? 1) : 1;
      const bh = bdef ? (bdef.blockH ?? bdef.blockCells ?? 1) : 1;
      for (let dc = 0; dc < bw; dc++) {
        for (let dr = 0; dr < bh; dr++) {
          roadSet.add(`${cell.col + dc},${cell.row + dr}`);
        }
      }
    }
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

  // 被弾原因・すり抜けのスポーン地点別集計（2-7 機能B）
  const damageBySpawn = new Map(); // "col,row" → { totalDmg, hits, byType: Map<type,count> }
  const leakBySpawn   = new Map(); // "col,row" → count

  const spawnFn = (col, row, def, waveNum, leader) => {
    const finalDef = opts.enemySpeed ? { ...def, speed: +opts.enemySpeed } : def;
    spawnTotal++;
    const z = new ctx.Zombie(mockScene, col, row, finalDef, waveNum, leader);
    z._firstContact  = null;
    z._spawnOrigin   = { col, row };
    z._killed        = false;
    z.onDeath = () => {
      z._killed = true;
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
  // 優先順位: CLI指定(opts.maxTimeMs) > ステージJSON指定(stage.simMaxTimeMs) > 既定値600000ms(10分)
  const MAX_TIME = opts.maxTimeMs ? +opts.maxTimeMs : (stage.simMaxTimeMs ?? 600_000);

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
      const _hpBefore = escortTarget ? escortTarget.hp : null;
      z.update(scaledTime, DT, escortTarget);
      if (escortTarget && _hpBefore != null) {
        const _dmg = _hpBefore - escortTarget.hp;
        if (_dmg > 0) {
          const _key = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
          let _rec = damageBySpawn.get(_key);
          if (!_rec) { _rec = { totalDmg: 0, hits: 0, byType: new Map() }; damageBySpawn.set(_key, _rec); }
          _rec.totalDmg += _dmg;
          _rec.hits += 1;
          _rec.byType.set(z.type, (_rec.byType.get(z.type) ?? 0) + 1);
        }
      }
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
  if (scaledTime > MAX_TIME) log.push(`[TIMEOUT] 最大時間(${Math.round(MAX_TIME / 60000)}分)超過`);

  const total       = escortDefs.length;
  const passThrough = spawnTotal - killCount;
  const judgment    = survivors >= minSurvivors ? 'CLEAR' : 'GAMEOVER';
  const hpPct       = Math.round((escort.hp ?? 0) / (escort.maxHp || 1) * 100);
  const closestPx   = closestEver === Infinity ? '-' : Math.round(closestEver);
  log.push(`[RESULT] スポーン総数=${spawnTotal} 撃破=${killCount} すり抜け=${passThrough} 護衛生還=${survivors}/${total} HP残=${hpPct}% CLOSE_CALL=${closecallCount}回 最接近=${closestPx}px 判定=${judgment}`);

  // すり抜け（未撃破）をスポーン地点別に集計（2-7 機能B）
  for (const z of allSpawned) {
    if (z._killed) continue;
    const key = `${z._spawnOrigin.col},${z._spawnOrigin.row}`;
    leakBySpawn.set(key, (leakBySpawn.get(key) ?? 0) + 1);
  }

  if (damageBySpawn.size > 0) {
    log.push('[DAMAGE_BY_SPAWN]');
    const sorted = [...damageBySpawn.entries()].sort((a, b) => b[1].totalDmg - a[1].totalDmg);
    for (const [key, rec] of sorted) {
      const byTypeStr = [...rec.byType.entries()].map(([t, n]) => `${t}×${n}`).join(', ');
      log.push(`  spawn=(${key})   被弾${rec.hits}回  合計${rec.totalDmg}dmg  （${byTypeStr}）`);
    }
  }
  if (leakBySpawn.size > 0) {
    log.push('[LEAK_BY_SPAWN]');
    const sorted = [...leakBySpawn.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, count] of sorted) {
      log.push(`  spawn=(${key})  すり抜け${count}体`);
    }
  }

  return { log, judgment, hpPct, spawnTotal, killCount, passThrough, closecallCount, closestEver, survivors, total };
}

// ─── スイープモード（2-7 機能A） ───────────────────────────────────────────────
// "KEY=START..END:STEP" を解析して振る値の配列を返す
function parseSweepExpr(expr) {
  const m = expr.match(/^(\w+)=(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/);
  if (!m) throw new Error(`--sweep の形式が不正です: "${expr}"\n期待形式: KEY=START..END:STEP （例: startMoney=600..1400:100）`);
  const [, key, startS, endS, stepS] = m;
  const start = Number(startS), end = Number(endS), step = Number(stepS);
  if (step === 0) throw new Error('--sweep のSTEPは0にできません');
  const values = [];
  if (step > 0) for (let v = start; v <= end + 1e-9; v += step) values.push(Math.round(v * 1000) / 1000);
  else          for (let v = start; v >= end - 1e-9; v += step) values.push(Math.round(v * 1000) / 1000);
  return { key, values };
}

// 対応キー: startMoney / escortSpeed / enemyCountMul / enemyHpMul / triggerIntervalMul
// stage(生JSON)をディープコピーしてから上書きする（元のstageは書き換えない）
function applySweepOverride(stage, opts, key, value) {
  const newStage = JSON.parse(JSON.stringify(stage));
  const newOpts  = { ...opts };

  const forEachTrigger = (fn) => {
    for (const esc of newStage.escorts ?? []) {
      for (const seg of esc.segments ?? []) {
        for (const trig of seg.triggers ?? []) fn(trig);
      }
    }
  };
  const forEachEnemy = (fn) => {
    for (const esc of newStage.escorts ?? []) {
      for (const seg of esc.segments ?? []) {
        for (const entry of [...(seg.initial ?? []), ...(seg.triggers ?? [])]) fn(entry.enemy ?? entry);
      }
    }
  };

  switch (key) {
    case 'startMoney':
      newStage.startMoney = value;
      break;
    case 'escortSpeed':
      newOpts.escortSpeed = value;
      break;
    case 'enemyCountMul':
      forEachTrigger(trig => { if (trig.count != null) trig.count = Math.max(0, Math.round(trig.count * value)); });
      break;
    case 'enemyHpMul':
      forEachEnemy(enemy => { if (enemy.hp != null) enemy.hp = Math.max(1, Math.round(enemy.hp * value)); });
      break;
    case 'triggerIntervalMul':
      forEachTrigger(trig => { if (trig.interval != null) trig.interval = Math.max(0, Math.round(trig.interval * value)); });
      break;
    default:
      throw new Error(`未対応の--sweepキー: "${key}"（対応: startMoney/escortSpeed/enemyCountMul/enemyHpMul/triggerIntervalMul）`);
  }
  return { newStage, newOpts };
}

function runSweep(stageFile, towerPattern, sweepExpr) {
  const baseStage  = JSON.parse(fs.readFileSync(path.join(ROOT, stageFile), 'utf8'));
  const { key, values } = parseSweepExpr(sweepExpr);

  for (const value of values) {
    const { newStage, newOpts } = applySweepOverride(baseStage, {}, key, value);
    const res = runStage(newStage, towerPattern, newOpts);
    console.log(
      `${key}=${value}`.padEnd(20) +
      `生還${res.survivors}/${res.total}`.padEnd(10) +
      `HP残${res.hpPct}%`.padEnd(9) +
      `撃破${res.killCount}/${res.spawnTotal}`.padEnd(11) +
      `すり抜け${res.passThrough}`.padEnd(11) +
      `CC=${res.closecallCount}`
    );
  }
}

// ─── CLI エントリ ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const argv = process.argv.slice(2);
  const sweepFlagIdx = argv.indexOf('--sweep');

  if (sweepFlagIdx >= 0) {
    // ─── スイープモード: node run_sim.js <stageFile> [--tower "<配置>"] --sweep KEY=START..END:STEP ───
    const stageFile = argv[0];
    if (!stageFile || stageFile.startsWith('--')) {
      console.error('使い方: node run_sim.js <stageFile> [--tower "<配置>"] --sweep KEY=START..END:STEP');
      process.exit(1);
    }
    const towerFlagIdx = argv.indexOf('--tower');
    const towerPattern = towerFlagIdx >= 0 ? argv[towerFlagIdx + 1] : '';
    try {
      runSweep(stageFile, towerPattern, argv[sweepFlagIdx + 1]);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    return;
  }

  // ─── 既存の位置引数モード（変更なし） ───────────────────────────────────────
  const [stageFile, towerPattern, escortSpeed, enemySpeed, maxTimeMs] = argv;
  if (!stageFile) {
    console.error('使い方: node run_sim.js <stageFile> [towerPattern] [escortSpeed] [enemySpeed] [maxTimeMs]');
    process.exit(1);
  }
  const result = run(stageFile, towerPattern, { escortSpeed, enemySpeed, maxTimeMs });
  console.log(result.log.join('\n'));
}

module.exports = { run, runStage, parseTowerPattern, parseSweepExpr, applySweepOverride };
