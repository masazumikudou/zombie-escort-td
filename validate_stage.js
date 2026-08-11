'use strict';
// R-6: ステージJSON静的検証スクリプト
// 1便目（座標・ルール突き合わせ系・9項目）＋2便目（枠外spawn侵入余裕チェック・猶予マップ）
// シムを一切動かさず、座標とルールの整合性だけを機械的にチェックする。
// 「JSONの書き損じがエラーなく素通りし、実行結果から逆算しないと発覚しない」事故の再発防止。
//
// 使い方: node validate_stage.js stages/xxx.json
//        node validate_stage.js --margin stages/xxx.json   （猶予マップ出力モード・判定なし）
//
// 判定は2段階:
//   ERROR: 量産に進めない致命的な不整合
//   WARN : 動くが小松の確認が要る

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname);

// ─── config.js + balance.json から定数を取得 ─────────────────────────────────
// config.jsは他ファイルに依存しないため、vmコンテキストへの単独読み込みで足りる
// （run_sim.jsと同じくvm.runInContext経由で取得。トップレベルconst/letの
//  ctx.NAMEプロパティ露出はNode vmの既知の癖で不安定なため、この方式に統一する）。
// balance.jsonはZOMBIE_BASE/ESCORT_ENGAGE_RADIUSを上書きするため、run_sim.jsと同じ手順で適用する
// （2便目の距離計算は実機/シムと同じ単位系・同じ数値を正典として使う必要があるため）。
const ctx = vm.createContext({ console, Math, JSON });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'), ctx);
const balance = JSON.parse(fs.readFileSync(path.join(ROOT, 'balance.json'), 'utf8'));
vm.runInContext(`applyBalance(${JSON.stringify(balance)})`, ctx);

const GROUND_BLOCK_DEFS  = vm.runInContext('GROUND_BLOCK_DEFS', ctx);
const PROP_DEFS          = vm.runInContext('PROP_DEFS', ctx);
const ZOMBIE_BASE         = vm.runInContext('ZOMBIE_BASE', ctx);
const CELL                = vm.runInContext('CELL', ctx);
const ESCORT_ENGAGE_RADIUS = vm.runInContext('ESCORT_ENGAGE_RADIUS', ctx);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── 2便目用の幾何ヘルパー（js/config.jsのcellCenterと同一式） ───────────────
function cellCenter(col, row) {
  return { x: col * CELL + CELL / 2, y: row * CELL + CELL / 2 };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 点pから線分ab（両端含む）への最短距離
function pointToSegmentDist(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return dist(p, { x: a.x + abx * t, y: a.y + aby * t });
}

// 点pから、pathPixels（連続する折れ線）上の最近接点までの距離
function nearestPathDist(p, pathPixels) {
  if (!pathPixels || pathPixels.length === 0) return Infinity;
  if (pathPixels.length === 1) return dist(p, pathPixels[0]);
  let min = Infinity;
  for (let i = 0; i < pathPixels.length - 1; i++) {
    min = Math.min(min, pointToSegmentDist(p, pathPixels[i], pathPixels[i + 1]));
  }
  return min;
}

// 護衛pathのwaypoint fromIdx→toIdx間の実距離合計（waypoint間を直線で結んだ長さの総和）
function pathDistanceBetween(pathCoords, fromIdx, toIdx) {
  const lo = clamp(Math.min(fromIdx, toIdx), 0, pathCoords.length - 1);
  const hi = clamp(Math.max(fromIdx, toIdx), 0, pathCoords.length - 1);
  let total = 0;
  for (let i = lo; i < hi; i++) {
    total += dist(cellCenter(pathCoords[i].col, pathCoords[i].row), cellCenter(pathCoords[i + 1].col, pathCoords[i + 1].row));
  }
  return total;
}

function resolveEnemySpeed(enemyDef) {
  if (enemyDef?.speed !== undefined) return enemyDef.speed;
  return ZOMBIE_BASE[enemyDef?.type]?.speed;
}

// ground_cells登録セルを、ブロック型タイル（blockW/blockH・blockCells）分だけ展開して
// 「道路として歩行可能」なセル集合を作る。GameScene.js（87-109行目）と同一ロジック。
function buildRoadSet(groundCells) {
  const roadSet = new Set();
  for (const cell of groundCells ?? []) {
    const bdef = GROUND_BLOCK_DEFS[cell.type];
    const bw = bdef ? (bdef.blockW ?? bdef.blockCells ?? 1) : 1;
    const bh = bdef ? (bdef.blockH ?? bdef.blockCells ?? 1) : 1;
    for (let dc = 0; dc < bw; dc++) {
      for (let dr = 0; dr < bh; dr++) {
        roadSet.add(`${cell.col + dc},${cell.row + dr}`);
      }
    }
  }
  return roadSet;
}

// propフットプリント（col,rowを左上原点として cols×rows 展開）。run_sim.jsのcomputePropBlockedと同一ロジック。
// 【注意】発注文の「3×3フットプリント範囲（中心座標±1マス）」という記述は実装と異なる。
// 実際のPROP_DEFSはprop種別ごとにサイズが違い（1×1〜15×3まで）、col/rowは中心ではなく
// 左上原点として扱われる（run_sim.js computePropBlocked・GameScene.js _propBlocked構築ロジックと同一）。
// シム/実機と食い違うと「シムが衝突の最終ゲートキーパー」の前提が崩れるため、実装に合わせた。
function propFootprintCells(prop) {
  const pdef = PROP_DEFS[prop.type];
  const cells = [];
  if (!pdef) return cells;
  for (let dc = 0; dc < (pdef.cols ?? 1); dc++) {
    for (let dr = 0; dr < (pdef.rows ?? 1); dr++) {
      cells.push({ col: prop.col + dc, row: prop.row + dr });
    }
  }
  return cells;
}

function collectPathCells(escorts) {
  const set = new Set();
  for (const e of escorts ?? []) {
    for (const p of e.path ?? []) set.add(`${p.col},${p.row}`);
  }
  return set;
}

// escort variant名 -> そのescort自身のpathセル集合
function collectPathCellsByEscort(escorts) {
  const map = new Map();
  for (const e of escorts ?? []) {
    map.set(e.variant, new Set((e.path ?? []).map(p => `${p.col},${p.row}`)));
  }
  return map;
}

// spawn名 -> それを実際に使用しているescort variantの集合
// 「ゼロ距離接触」はそのspawnを使うescort自身のpathとの重複でのみ発生する
// （異なるescortのpathとたまたま座標が重なっていても、そのescortがまだ登場していない
//  時点の話なので無害——本セッションでstage_確定ABAステージの検証時に実例で確認済み）
function collectSpawnOwners(escorts) {
  const owners = new Map();  // name -> Set<variant>
  for (const e of escorts ?? []) {
    for (const seg of e.segments ?? []) {
      for (const entry of [...(seg.initial ?? []), ...(seg.triggers ?? [])]) {
        if (!entry.spawn) continue;
        if (!owners.has(entry.spawn)) owners.set(entry.spawn, new Set());
        owners.get(entry.spawn).add(e.variant);
      }
    }
  }
  return owners;
}

function inGrid(col, row, cols, rows) {
  return col >= 0 && col < cols && row >= 0 && row < rows;
}

// ─── メイン検証 ──────────────────────────────────────────────────────────
function validateStage(stage) {
  const results = [];  // { item, level: 'ERROR'|'WARN', message }
  const add = (item, level, message) => results.push({ item, level, message });

  const cols = stage.grid?.cols;
  const rows = stage.grid?.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    add(0, 'ERROR', `stage.gridが不正です（cols=${cols}, rows=${rows}）。以降の検証を中止します`);
    return results;
  }

  const groundCells   = stage.ground_cells ?? [];
  const hasRoadDef     = groundCells.length > 0;
  const roadSet         = buildRoadSet(groundCells);
  const pathCells       = collectPathCells(stage.escorts);           // 全escort合算（項目6用）
  const pathCellsByEscort = collectPathCellsByEscort(stage.escorts);   // escort別（項目2・5用）
  const spawnOwners     = collectSpawnOwners(stage.escorts);
  const spawns          = stage.spawns ?? {};

  // spawn名 -> それを使うescortたちの自身pathセルの和集合（未使用spawnは全escort合算にフォールバック）
  function ownerPathCellsFor(name) {
    const owners = spawnOwners.get(name);
    if (!owners || owners.size === 0) return pathCells;  // どのescortも使わないなら安全側に全合算で判定
    const merged = new Set();
    for (const variant of owners) {
      for (const cell of pathCellsByEscort.get(variant) ?? []) merged.add(cell);
    }
    return merged;
  }

  // spawnsをグリッド内／外で分類（グリッド外は「枠外spawn」として項目5で別途検証）
  const inGridSpawns  = [];
  const offGridSpawns = [];
  for (const [name, coord] of Object.entries(spawns)) {
    if (!coord || typeof coord.col !== 'number' || typeof coord.row !== 'number') {
      add(7, 'ERROR', `spawns.${name} の座標が不正です: ${JSON.stringify(coord)}`);
      continue;
    }
    if (inGrid(coord.col, coord.row, cols, rows)) inGridSpawns.push([name, coord]);
    else offGridSpawns.push([name, coord]);
  }

  // ── 項目1: 敵spawnが道路セル上か ──────────────────────────────────────
  if (!hasRoadDef) {
    add(1, 'WARN', `ground_cellsが未定義のためスキップ（road-only制約が発動しないステージ。意図的なら問題なし）`);
  } else {
    for (const [name, coord] of inGridSpawns) {
      if (!roadSet.has(`${coord.col},${coord.row}`)) {
        add(1, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) は道路セル（ground_cells）上にありません`);
      }
    }
  }

  // ── 項目2: 敵spawnが護衛pathの真上でないか ────────────────────────────
  // 判定は「そのspawnを実際に使うescort自身のpath」に限定する（他escortのpathとの
  // 偶然の重なりは、そのescortがまだ登場していない時点の話なので無害）
  for (const [name, coord] of inGridSpawns) {
    if (ownerPathCellsFor(name).has(`${coord.col},${coord.row}`)) {
      add(2, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) が使用escort自身の護衛pathの座標と重複しています（ゼロ距離接触の事故）`);
    }
  }

  // ── 項目3: 1交戦地の初期敵が4体以内か ─────────────────────────────────
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const n = (seg.initial ?? []).length;
      if (n >= 5) {
        add(3, 'ERROR', `escort=${escort.variant} segment=${seg.segmentId} のinitial敵数が${n}体です（4体以内推奨）`);
      }
    }
  }

  // ── 項目4: propの足元が道路を侵食していないか ─────────────────────────
  if (!hasRoadDef) {
    add(4, 'WARN', `ground_cellsが未定義のためスキップ（road-only制約が発動しないステージ）`);
  } else {
    for (const prop of stage.props ?? []) {
      const cells = propFootprintCells(prop);
      const hitCells = cells.filter(c => roadSet.has(`${c.col},${c.row}`));
      if (hitCells.length > 0) {
        add(4, 'ERROR', `props ${prop.type}@(${prop.col},${prop.row}) のフットプリントが道路セルと重複: ${hitCells.map(c => `(${c.col},${c.row})`).join(' ')}`);
      }
    }
  }

  // ── 項目5: 枠外spawnの着地先が道路かつpath外か ────────────────────────
  for (const [name, coord] of offGridSpawns) {
    // bird等circleAt使用の枠外spawnは、盤内最寄りセルへの直進クランプではなく
    // 旋回地点(circleAt)周辺への進入になるため、この幾何とは無関係。対象外として明示する。
    const usedByBird = (stage.escorts ?? []).some(e =>
      (e.segments ?? []).some(seg =>
        (seg.triggers ?? []).some(t => t.spawn === name && (t.enemy?.circleAt || t.circleAt))
      )
    );
    if (usedByBird) {
      add(5, 'WARN', `spawns.${name}(${coord.col},${coord.row}) はcircleAt使用（鳥系）のためクランプ判定の対象外`);
      continue;
    }
    const cCol = clamp(coord.col, 0, cols - 1);
    const cRow = clamp(coord.row, 0, rows - 1);
    if (hasRoadDef && !roadSet.has(`${cCol},${cRow}`)) {
      add(5, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) のクランプ後着地先(${cCol},${cRow})が道路セル上にありません`);
    }
    if (ownerPathCellsFor(name).has(`${cCol},${cRow}`)) {
      add(5, 'ERROR', `spawns.${name}(${coord.col},${coord.row}) のクランプ後着地先(${cCol},${cRow})が使用escort自身の護衛pathの座標と重複しています`);
    }
  }

  // ── 項目10: 枠外spawnの侵入余裕チェック（2便目・CC発注書ではチェック項目6と表記されているが、
  // 本スクリプトの1-9番採番と衝突するため10番として実装する。工程表「現在地」のR-6検査項目
  // 10件リストの6番目と同一項目） ──────────────────────────────────────
  // 対象: initial/triggerでoff-grid(枠外)のspawnを使用しているenemyエントリすべて。
  // ①侵入所要時間 = 盤外spawn座標→クランプ後着地点の距離÷敵speed
  //   （着地点が護衛pathからescortEngageRadius(450px)より遠い場合は、着地点→path最近接点の距離も加算）
  // ②segment猶予 = (trigger.atWpIdx、initialならsegment.range.fromWp)→segment.range.toWpの
  //   護衛path実距離÷護衛speed
  // 判定: ①≧② → ERROR（間に合わず素通り）。余裕率(②÷①)が1.0〜1.5 → WARN。それ以上は出力なし。
  for (const escort of stage.escorts ?? []) {
    const escortSpeed = escort.speed;
    const pathPixels  = (escort.path ?? []).map(p => cellCenter(p.col, p.row));
    for (const seg of escort.segments ?? []) {
      const entries = [
        ...(seg.initial ?? []).map(x => ({ src: 'initial', spawn: x.spawn, enemy: x.enemy ?? x, startWp: seg.range?.fromWp })),
        ...(seg.triggers ?? []).map(x => ({ src: 'trigger', spawn: x.spawn, enemy: x.enemy ?? x, startWp: x.atWpIdx })),
      ];
      for (const { src, spawn, enemy, startWp } of entries) {
        const coord = spawns[spawn];
        if (!coord) continue;  // 未定義spawn参照は別項目（旧R-6リストの検出対象・本スクリプトでは扱わない）
        if (inGrid(coord.col, coord.row, cols, rows)) continue;  // 枠外spawnのみが対象

        if (enemy?.circleAt) {
          add(10, 'WARN', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) はcircleAt使用（鳥系）のため侵入余裕チェックの対象外`);
          continue;
        }
        if (startWp === undefined || seg.range?.toWp === undefined) {
          add(10, 'WARN', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) はwaypoint範囲が特定できず侵入余裕チェックをスキップ`);
          continue;
        }
        const enemySpeed = resolveEnemySpeed(enemy);
        if (!enemySpeed) {
          add(10, 'WARN', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) は敵speedが解決できず侵入余裕チェックをスキップ（type=${enemy?.type}）`);
          continue;
        }

        const spawnPixel  = cellCenter(coord.col, coord.row);
        const cCol        = clamp(coord.col, 0, cols - 1);
        const cRow         = clamp(coord.row, 0, rows - 1);
        const landingPixel = cellCenter(cCol, cRow);
        const entryDist    = dist(spawnPixel, landingPixel);

        const pathDist = nearestPathDist(landingPixel, pathPixels);
        const extraDist = pathDist > ESCORT_ENGAGE_RADIUS ? pathDist : 0;

        const entryTimeMs = ((entryDist + extraDist) / enemySpeed) * 1000;

        const graceDist  = pathDistanceBetween(escort.path, startWp, seg.range.toWp);
        const graceTimeMs = (graceDist / escortSpeed) * 1000;

        const label = `escort=${escort.variant} segment=${seg.segmentId} ${src}(spawn=${spawn}) 侵入所要時間=${Math.round(entryTimeMs)}ms 猶予=${Math.round(graceTimeMs)}ms`;
        if (entryTimeMs >= graceTimeMs) {
          add(10, 'ERROR', `${label} 不足=${Math.round(entryTimeMs - graceTimeMs)}ms（間に合わず素通りする）`);
        } else {
          const ratio = graceTimeMs / entryTimeMs;
          if (ratio >= 1.0 && ratio <= 1.5) {
            add(10, 'WARN', `${label} 余裕率=${ratio.toFixed(2)}（ギリギリ帯・確認推奨）`);
          }
          // ratio > 1.5 は出力しない（緊張ゼロ問題はR-6のスコープ外）
        }
      }
    }
  }

  // ── 項目6: buildSpotが道路セル上・path外か ────────────────────────────
  for (const bs of stage.buildSpots ?? []) {
    if (!inGrid(bs.col, bs.row, cols, rows)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) がグリッド範囲外です`);
      continue;
    }
    if (hasRoadDef && !roadSet.has(`${bs.col},${bs.row}`)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) は道路セル上にありません`);
    }
    if (pathCells.has(`${bs.col},${bs.row}`)) {
      add(6, 'ERROR', `buildSpots(${bs.col},${bs.row}) が護衛pathの座標と重複しています`);
    }
  }

  // ── 項目7: 全座標がグリッド範囲内か（buildSpots/ground_cells/props/path/盤内spawns） ──
  for (const bs of stage.buildSpots ?? []) {
    if (!inGrid(bs.col, bs.row, cols, rows)) {
      add(7, 'ERROR', `buildSpots(${bs.col},${bs.row}) がグリッド範囲外です（項目6と重複報告）`);
    }
  }
  for (const cell of groundCells) {
    if (!inGrid(cell.col, cell.row, cols, rows)) {
      add(7, 'ERROR', `ground_cells(${cell.col},${cell.row}) type=${cell.type} がグリッド範囲外です`);
    }
  }
  for (const prop of stage.props ?? []) {
    const cells = propFootprintCells(prop);
    const outOfRange = cells.filter(c => !inGrid(c.col, c.row, cols, rows));
    if (outOfRange.length > 0) {
      add(7, 'ERROR', `props ${prop.type}@(${prop.col},${prop.row}) のフットプリントがグリッド範囲外にはみ出しています: ${outOfRange.map(c => `(${c.col},${c.row})`).join(' ')}`);
    }
  }
  for (const escort of stage.escorts ?? []) {
    for (const p of escort.path ?? []) {
      if (!inGrid(p.col, p.row, cols, rows)) {
        add(7, 'ERROR', `escort=${escort.variant} のpath座標(${p.col},${p.row})がグリッド範囲外です`);
      }
    }
  }
  // 盤内spawnsは項目1classifyの時点で既にグリッド範囲内であることが保証されているため
  // （グリッド外を意図した座標=offGridSpawnsは項目5で別途検証済み）、ここでの追加チェックは不要。

  // ── 項目8: 資金の供給元ゼロ検出 ───────────────────────────────────────
  const stageMoney = stage.startMoney;
  const escortMoneys = (stage.escorts ?? []).map(e => e.startMoney);
  const allZeroOrUndefined = (!stageMoney) && escortMoneys.every(m => !m);
  if (allZeroOrUndefined) {
    add(8, 'ERROR', `stage.startMoneyと全escortのstartMoneyが全て0または未定義です。資金がどこからも供給されません`);
  }

  // ── 項目9: enemyへのhp直書き検出（v2.8ルール） ────────────────────────
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const hasSegComment = Object.keys(seg).some(k => k.startsWith('_comment'));
      const enemyEntries = [
        ...(seg.initial ?? []).map(x => ({ src: 'initial', spawn: x.spawn, enemy: x.enemy ?? x })),
        ...(seg.triggers ?? []).map(x => ({ src: 'trigger', spawn: x.spawn, enemy: x.enemy ?? x })),
      ];
      for (const { src, spawn, enemy } of enemyEntries) {
        if (enemy && enemy.hp !== undefined && !hasSegComment) {
          add(9, 'WARN', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) にenemy.hp明示指定(${enemy.hp})があり_comment系キーがありません（balance.json値を上書きする意図的な変更か確認要）`);
        }
      }
    }
  }

  // ── 項目11: buildSpots vs propフットプリントの衝突検出（3便目）────────────
  // R-6発端の元ネタ（本番segment_test再設計でbuildSpots 42箇所中11箇所がprop
  // フットプリントと衝突していた事故）に対応。項目4（propと道路）・項目6（buildSpotと
  // 道路・path）とは別軸のため見落とされていた。propFootprintCellsを流用。
  {
    const propCellMap = new Map();  // "col,row" -> "type@(col,row)" ラベル
    for (const prop of stage.props ?? []) {
      for (const c of propFootprintCells(prop)) {
        propCellMap.set(`${c.col},${c.row}`, `${prop.type}@(${prop.col},${prop.row})`);
      }
    }
    for (const bs of stage.buildSpots ?? []) {
      const label = propCellMap.get(`${bs.col},${bs.row}`);
      if (label) {
        add(11, 'ERROR', `buildSpots(${bs.col},${bs.row}) がprop(${label})のフットプリントと重複しています`);
      }
    }
  }

  // ── 項目12: spawnキーの未定義参照検出（3便目）─────────────────────────
  // initial/triggersが参照するspawn名が実際にstage.spawnsに定義されているか。
  // SpawnEventManager.js側はconsole.warnで実行時に検出するが、静的チェックとしては
  // 未実装だった（file_structure_review.md R-6原文の項目3）。
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const refs = [
        ...(seg.initial ?? []).map(x => ({ src: 'initial', spawn: x.spawn })),
        ...(seg.triggers ?? []).map(x => ({ src: 'trigger', spawn: x.spawn })),
      ];
      for (const { src, spawn } of refs) {
        if (spawn !== undefined && !(spawn in spawns)) {
          add(12, 'ERROR', `escort=${escort.variant} segment=${seg.segmentId} の${src}が未定義のspawn名"${spawn}"を参照しています`);
        }
      }
    }
  }

  // ── 項目13: leashTo座標の歩行可能性チェック（3便目）────────────────────
  // enemy.leashToが指定されている場合、グリッド範囲内かつ道路セル上であることを確認
  // （file_structure_review.md R-6原文の項目4後半）。
  for (const escort of stage.escorts ?? []) {
    for (const seg of escort.segments ?? []) {
      const entries = [
        ...(seg.initial ?? []).map(x => ({ src: 'initial', spawn: x.spawn, enemy: x.enemy ?? x })),
        ...(seg.triggers ?? []).map(x => ({ src: 'trigger', spawn: x.spawn, enemy: x.enemy ?? x })),
      ];
      for (const { src, spawn, enemy } of entries) {
        const leashTo = enemy?.leashTo;
        if (!leashTo) continue;
        if (!inGrid(leashTo.col, leashTo.row, cols, rows)) {
          add(13, 'ERROR', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) のleashTo(${leashTo.col},${leashTo.row})がグリッド範囲外です`);
          continue;
        }
        if (hasRoadDef && !roadSet.has(`${leashTo.col},${leashTo.row}`)) {
          add(13, 'ERROR', `escort=${escort.variant} segment=${seg.segmentId} の${src}(spawn=${spawn}) のleashTo(${leashTo.col},${leashTo.row})が道路セル上にありません`);
        }
      }
    }
  }

  return results;
}

// ─── 出力 ────────────────────────────────────────────────────────────────
const ITEM_LABELS = {
  0: 'grid定義',
  1: '敵spawnが道路セル上か',
  2: '敵spawnが護衛pathの真上でないか',
  3: '1交戦地の初期敵が4体以内か',
  4: 'propの足元が道路を侵食していないか',
  5: '枠外spawnの着地先が道路かつpath外か',
  6: 'buildSpotが道路セル上・path外か',
  7: '全座標がグリッド範囲内か',
  8: '資金の供給元ゼロ検出',
  9: 'enemyへのhp直書き検出',
  10: '枠外spawnの侵入余裕チェック（2便目）',
  11: 'buildSpots vs propフットプリントの衝突検出（3便目）',
  12: 'spawnキーの未定義参照検出（3便目）',
  13: 'leashTo座標の歩行可能性チェック（3便目）',
};

function printReport(stageFile, results) {
  console.log(`=== validate_stage.js: ${stageFile} ===`);
  let errorCount = 0, warnCount = 0;
  for (let item = 0; item <= 13; item++) {
    if (item === 0) continue;
    const itemResults = results.filter(r => r.item === item);
    const errs  = itemResults.filter(r => r.level === 'ERROR');
    const warns = itemResults.filter(r => r.level === 'WARN');
    if (itemResults.length === 0) {
      console.log(`[${item}] ${ITEM_LABELS[item]} ... OK`);
      continue;
    }
    const label = errs.length > 0 ? `NG (ERROR ${errs.length}件)` : `OK (WARN ${warns.length}件)`;
    console.log(`[${item}] ${ITEM_LABELS[item]} ... ${label}`);
    for (const r of itemResults) {
      console.log(`    ${r.level === 'ERROR' ? '[ERROR]' : '[WARN] '} ${r.message}`);
    }
  }
  errorCount = results.filter(r => r.level === 'ERROR').length;
  warnCount  = results.filter(r => r.level === 'WARN').length;
  console.log('');
  console.log(`=== 判定: ${errorCount > 0 ? 'NG' : 'OK'} (ERROR ${errorCount}件 / WARN ${warnCount}件) ===`);
  return errorCount === 0;
}

// ─── --margin: 猶予マップ出力（判定なし・補助モード） ─────────────────────
// 全escort×全waypointについて「そのwaypointから、現在のsegmentの終了waypointまでの猶予」を
// 一覧表示する。項目10の判定ロジックとは別軸——ここでは何も判定しない（OK/NGの集計に含めない）。
// 用途: 小松がMAP上に導線を引いた直後、Claudeが枠外spawnの配置を決めるための資料。
function printMarginMap(stage) {
  for (const escort of stage.escorts ?? []) {
    console.log(`[${escort.variant}]`);
    const escortSpeed = escort.speed;
    for (const seg of escort.segments ?? []) {
      const fromWp = seg.range?.fromWp;
      const toWp   = seg.range?.toWp;
      if (fromWp === undefined || toWp === undefined) {
        console.log(`  segment=${seg.segmentId} range未定義のためスキップ`);
        continue;
      }
      for (let wp = fromWp; wp < toWp; wp++) {
        const graceDist = pathDistanceBetween(escort.path, wp, toWp);
        const graceMs   = Math.round((graceDist / escortSpeed) * 1000);
        console.log(`  wp${wp}→(segment ${seg.segmentId}終了wp${toWp}まで) 猶予: ${graceMs}ms`);
      }
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const marginMode = args.includes('--margin');
  const stageFile = args.find(a => a !== '--margin');
  if (!stageFile) {
    console.error('使い方: node validate_stage.js <stageFile>');
    console.error('       node validate_stage.js --margin <stageFile>   （猶予マップ出力・判定なし）');
    process.exit(1);
  }
  const stage = JSON.parse(fs.readFileSync(path.join(ROOT, stageFile), 'utf8'));

  if (marginMode) {
    printMarginMap(stage);
    process.exit(0);
  }

  const results = validateStage(stage);
  const ok = printReport(stageFile, results);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { validateStage };
