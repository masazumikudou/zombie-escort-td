// SpawnEventManager: 時刻駆動・データ駆動型スポーン管理
//
// JSON構造:
//   spawns: { "A": {col,row}, "B": {col,row}, ... }
//   spawnEvents: [
//     { time, spawn, enemy, count?, interval?, hp?, speed?, damage?, reward?, leashTo? }
//     { time, spawn, enemy, formation, pitch, interval?, hp?, speed?, damage?, reward?, leashTo }
//   ]
//
// time は護衛スタートからの経過秒（整数・小数どちらも可）
// count省略=1、interval省略=400ms
// formation: 隊列体数。指定時は count を無視し隊列モードで動作。

// ─── FormationGroup ───────────────────────────────────────────────────────────
// 隊列（フォーメーション）管理クラス
//
// ★ 将来の切替フラグ（本番マップ移行時に true にする）:
//   FormationGroup.USE_FLOW_FIELD = true
// true にすると後続の移動がFlowField追従に切り替わる。
// 現状(false)は直線移動。切替コスト = このフラグ1行のみ。
var FormationGroup = class FormationGroup {
  constructor(leashTo, pitch) {
    this.leashTo  = leashTo;   // {col,row}
    this.pitch    = pitch;     // px: 前の個体との維持距離
    this.members  = [];        // 生存中の隊列メンバー（インデックス順）
    this._seated  = false;     // 先頭が leashTo に着座済みか
  }

  // 後続の移動を実行（Zombie.update 内から FormationGroup.followerMove(this, prev, dt) で呼ぶ）
  // 戻り値: true = 移動した, false = pitch以内につき停止
  // ★ USE_FLOW_FIELD = true 時はここを FlowField 追従に差し替える
  static followerMove(zombie, prev, dt) {
    const dx   = prev.x - zombie.x;
    const dy   = prev.y - zombie.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= zombie._formation.pitch) return false;
    const step = zombie.speed * dt / 1000;
    zombie.lastDx = dx;
    zombie.lastDy = dy;
    if (dist <= step) {
      zombie.x = prev.x;
      zombie.y = prev.y;
    } else {
      zombie.x += (dx / dist) * step;
      zombie.y += (dy / dist) * step;
    }
    return true;
  }

  // メンバー追加（SpawnEventManager がスポーン後に呼ぶ）
  add(z) {
    z._fmIdx      = this.members.length;
    z._formation  = this;
    z._fmReleased = false;
    this.members.push(z);
  }

  // 死亡時コールバック（onDeath チェーンから呼ぶ）
  onMemberDeath(z) {
    const i = this.members.indexOf(z);
    if (i < 0) return;
    this.members.splice(i, 1);
    this.members.forEach((m, j) => { m._fmIdx = j; });

    // 未解除の先頭が死亡 → 次が繰り上がり先頭化・leashTo継承
    if (i === 0 && !z._fmReleased && this.members.length > 0) {
      const nxt = this.members[0];
      nxt.leashTarget   = { col: this.leashTo.col, row: this.leashTo.row };
      nxt._leashWaiting = false;
      nxt._leashWaitMs  = 0;
      nxt.path  = [cellCenter(this.leashTo.col, this.leashTo.row)];
      nxt.wpIdx = 0;
      this._seated = false;  // 新先頭は再び進軍してから着座
    }
  }

  // 毎フレーム呼び出し（SpawnEventManager.update 内）
  // 着座後に護衛が接近したら先頭から1体ずつ順次解除する
  tick(escort) {
    if (!escort || !this.members.length) return;

    // 先頭の着座確認（進軍中・着座前は解除しない）
    if (!this._seated) {
      if (this.members[0]._leashWaiting) this._seated = true;
      else return;
    }

    // 最初の未解除メンバーを探して1体ずつ解除
    const nextIdx = this.members.findIndex(m => !m._fmReleased);
    if (nextIdx < 0) return;

    const m = this.members[nextIdx];

    if (nextIdx === 0) {
      // 先頭: 護衛 CELL*1.5 以内で解除
      const dx = escort.x - m.x, dy = escort.y - m.y;
      if (Math.sqrt(dx * dx + dy * dy) < CELL * 1.5) this._releaseOne(m);
    } else {
      // 後続: 前が解除済みかつ（前が死亡 or 前が護衛に取り付き中）
      const prev = this.members[nextIdx - 1];
      if (!prev._fmReleased) return;
      const dx = escort.x - prev.x, dy = escort.y - prev.y;
      if (!prev.alive || Math.sqrt(dx * dx + dy * dy) < CELL * 0.9) {
        this._releaseOne(m);
      }
    }
  }

  _releaseOne(m) {
    m._fmReleased   = true;
    m._formation    = null;   // null になったら Zombie が FlowField に移行
    m.leashTarget   = null;
    m._leashWaiting = false;
  }
}

// FormationGroup のデフォルトフラグ
FormationGroup.USE_FLOW_FIELD = false;

// ─── SpawnEventManager ────────────────────────────────────────────────────────
var SpawnEventManager = class SpawnEventManager {
  constructor(spawns, spawnEvents) {
    this.spawnDefs   = spawns;
    // spawnEventsがundefined/nullでも落ちないようガード（segments・spawnEvents両方とも
    // 未定義のステージ（旧wavesのみ等）で呼ばれると[...undefined]がTypeErrorになるため）
    this.events      = [...(spawnEvents ?? [])].sort((a, b) => a.time - b.time);
    this.eventIdx    = 0;
    this._pending    = [];   // { fireAt, col, row, enemyDef, evIdx, gid, isFirst, formation }
    this._leaders    = {};   // gid → zombie（非隊列グループ先頭リーダー参照）
    this._formations = [];   // アクティブな FormationGroup リスト
    this.allDone     = false;
    this._spawnMul   = 1.0;
    this._startMs    = 0;
  }

  setSpawnMultiplier(m) { this._spawnMul = m; }

  start(timeOffset = 0) {
    this._startMs = timeOffset;
  }

  // escort: 現在の護衛オブジェクト（FormationGroup.tick に渡す）
  update(scaledTime, spawnFn, escort = null) {
    if (this.allDone) return;

    // 全フォーメーションの順次解除tick
    for (const fg of this._formations) fg.tick(escort);
    this._formations = this._formations.filter(fg => fg.members.length > 0);

    // 時刻が来たイベントをキューに展開
    while (this.eventIdx < this.events.length) {
      const ev     = this.events[this.eventIdx];
      const fireMs = this._startMs + ev.time * 1000;
      if (scaledTime < fireMs) break;

      const coord = this.spawnDefs[ev.spawn];
      if (!coord) { this.eventIdx++; continue; }

      const enemyDef = this._buildEnemyDef(ev);
      const gid      = this.eventIdx;

      if (ev.formation) {
        // ─── 隊列モード ────────────────────────────────────
        const fg       = new FormationGroup(ev.leashTo, ev.pitch ?? 400);
        const count    = ev.formation;
        const interval = ev.interval ?? 400;
        this._formations.push(fg);

        for (let i = 0; i < count; i++) {
          this._pending.push({
            fireAt:     scaledTime + (i * interval) / this._spawnMul,
            col:        coord.col,
            row:        coord.row,
            enemyDef,
            evIdx:      this.eventIdx,
            gid,
            isFirst:    i === 0,
            formation:  fg,
          });
        }
      } else {
        // ─── 既存モード（count + interval）────────────────
        const count    = ev.count    ?? 1;
        const interval = ev.interval ?? 400;

        for (let i = 0; i < count; i++) {
          this._pending.push({
            fireAt:    scaledTime + (i * interval) / this._spawnMul,
            col:       coord.col,
            row:       coord.row,
            enemyDef,
            evIdx:     this.eventIdx,
            gid,
            isFirst:   i === 0,
            formation: null,
          });
        }
      }
      this.eventIdx++;
    }

    // キュー内の個体を時刻順に発火
    const next = [];
    for (const p of this._pending) {
      if (scaledTime >= p.fireAt) {
        const leader = (p.formation || p.isFirst) ? null : (this._leaders[p.gid] ?? null);
        const z = spawnFn(p.col, p.row, p.enemyDef, p.evIdx, leader);

        if (!p.formation && p.isFirst && z) this._leaders[p.gid] = z;

        if (z && p.formation) {
          const fg = p.formation;
          fg.add(z);
          // 先頭以外はleashTargetを持たない（先頭はenemyDef経由で既に設定済み）
          if (z._fmIdx !== 0) {
            z.leashTarget   = null;
            z._leashWaiting = false;
          }
          // onDeathチェーン: 隊列管理に死亡を通知
          const origDeath = z.onDeath;
          z.onDeath = () => { fg.onMemberDeath(z); if (origDeath) origDeath(); };
        }
      } else {
        next.push(p);
      }
    }
    this._pending = next;

    if (this.eventIdx >= this.events.length && this._pending.length === 0) {
      this.allDone = true;
    }
  }

  // 次イベントが5秒以内なら警告情報を返す（スポーン予告点滅用）
  getWarning(scaledTime) {
    if (this.eventIdx >= this.events.length) return null;
    const ev        = this.events[this.eventIdx];
    const fireMs    = this._startMs + ev.time * 1000;
    const remaining = fireMs - scaledTime;
    if (remaining > 0 && remaining <= 5000) {
      return { spawn: this.spawnDefs[ev.spawn], remaining };
    }
    return null;
  }

  _buildEnemyDef(ev) {
    // enemy: "salaryman"（旧形式）or { type, hp, speed, ... }（新形式）の両対応
    const isObj    = ev.enemy && typeof ev.enemy === 'object';
    const typeName = isObj ? ev.enemy.type : ev.enemy;
    const src      = isObj ? ev.enemy : ev;   // プロパティの取得元
    const base     = ZOMBIE_BASE[typeName] ?? {};
    const def      = { ...base, type: typeName };
    if (src.hp     !== undefined) def.hp     = src.hp;
    if (src.speed  !== undefined) def.speed  = src.speed;
    if (src.damage !== undefined) def.damage = src.damage;
    if (src.reward !== undefined) def.reward = src.reward;
    if (ev.leashTo !== undefined) def.leashTo = ev.leashTo;
    if (src.circleAt         !== undefined) def.circleAt         = src.circleAt;
    if (src.circleRadius     !== undefined) def.circleRadius     = src.circleRadius;
    if (src.circleDurationMs !== undefined) def.circleDurationMs = src.circleDurationMs;
    return def;
  }
}

// ─── SegmentManager ───────────────────────────────────────────────────────────
// 区間制・位置トリガー方式のスポーン管理（SegmentManagerとSpawnEventManagerは並存）
// JSON形式: escortDef.segments = [ { segmentId, range:{fromWp,toWp}, initial:[], triggers:[], onExit } ]
// trigger: { type:"progress", atWpIdx, spawn, count?, interval?, enemy:{type,hp,speed,...,leashTo?,circleAt?,circleRadius?,circleDurationMs?} }
// 鳥系(type:"bird")専用: circleAt{col,row}=旋回中心・circleRadius(px,既定300)・circleDurationMs(既定5000)。
// radius/durationを0にすると旋回スキップで侵入直後に即ホーミング。
var SegmentManager = class SegmentManager {
  constructor(spawns, segments) {
    this.spawns      = spawns;     // {"A":{col,row}, ...} spawnDefsと同形式
    this.segments    = segments;
    this._segIdx     = 0;
    this._pending    = [];         // {fireAtMs, col, row, enemyDef} interval対応キュー
    // 区間ごとのゾンビ参照（retreat対象のグループ分け用）。全区間分のinitialを開始時に
    // 一括スポーンするため、所属区間ごとに配列を分けて持つ（現区間だけの単一配列ではない）。
    this._segZombieGroups  = segments.map(() => []);
    this._allInitialSpawned = false;
    this.allDone     = false;
    // トリガー発火状態は`${segIdx}:${triggerIdx}`キーでインスタンス側が持つ。
    // ステージJSON（trig._fired）に書き込むとrunAll()の複数run間で同一stageオブジェクトを
    // 使い回した際に発火済み状態が持ち越されてしまうため。
    this._fired      = new Set();
  }

  update(scaledTime, spawnFn, escort) {
    if (this.allDone) return;

    // 全区間のinitialを開始時（このマネージャーが初めてupdateされた瞬間＝t=0 or リレー開始時点）に
    // 一括スポーン。「開幕に盤面の全待機ゾンビが見えている＝読みの材料」が新文法の第一原則のため、
    // 区間ごとに遅延スポーンしない（区間所属・retreatタイミングは_segZombieGroupsで従来通り維持）。
    if (!this._allInitialSpawned) {
      this._allInitialSpawned = true;
      this.segments.forEach((seg, segIdx) => {
        for (const def of (seg.initial ?? [])) {
          const coord = this.spawns[def.spawn];
          if (!coord) continue;
          const z = spawnFn(coord.col, coord.row, this._buildEnemyDef(def.enemy ?? def), segIdx, null);
          // initial配置は護衛範囲円ゲートで静止させる（progress/intervalスポーンは即行動）
          if (z) { z._engageGate = true; this._segZombieGroups[segIdx].push(z); }
        }
      });
    }

    // intervalペンディング処理（区間に関係なく消化）
    const nextPending = [];
    for (const p of this._pending) {
      if (scaledTime >= p.fireAtMs) {
        const z = spawnFn(p.col, p.row, p.enemyDef, this._segIdx, null);
        if (z) this._segZombieGroups[this._segIdx].push(z);
      } else {
        nextPending.push(p);
      }
    }
    this._pending = nextPending;

    if (!escort) return;

    const seg = this.segments[this._segIdx];
    if (!seg) { this.allDone = true; return; }

    // progressトリガー判定（escort.wpIdxが閾値以上になったら発火）
    const triggers = seg.triggers ?? [];
    for (let ti = 0; ti < triggers.length; ti++) {
      const trig = triggers[ti];
      const key  = `${this._segIdx}:${ti}`;
      if (this._fired.has(key)) continue;
      if (trig.type === 'progress' && escort.wpIdx >= trig.atWpIdx) {
        const coord = this.spawns[trig.spawn];
        if (!coord) { this._fired.add(key); continue; }
        const count    = trig.count ?? 1;
        const interval = trig.interval ?? 0;
        const enemyDef = this._buildEnemyDef(trig.enemy ?? trig);
        for (let i = 0; i < count; i++) {
          this._pending.push({ fireAtMs: scaledTime + i * interval, col: coord.col, row: coord.row, enemyDef });
        }
        this._fired.add(key);
      }
    }

    // 区間遷移判定（護衛wpIdxがtoWpを超えたら次区間へ）
    if (escort.wpIdx > seg.range.toWp) {
      this._exitCurrentSegment();
    }
  }

  _exitCurrentSegment() {
    // その区間のゾンビ（initial＋トリガー産）を全員退場させる
    for (const z of this._segZombieGroups[this._segIdx]) {
      if (z.alive && !z._retreating) z.retreat();
    }
    this._segZombieGroups[this._segIdx] = [];
    // 未発火のペンディングもキャンセル
    this._pending = [];
    this._segIdx++;
    if (this._segIdx >= this.segments.length) this.allDone = true;
  }

  _buildEnemyDef(def) {
    const type   = def.type ?? 'salaryman';
    const base   = (typeof ZOMBIE_BASE !== 'undefined' ? ZOMBIE_BASE[type] : null) ?? {};
    const result = { ...base, type };
    if (def.hp      !== undefined) result.hp      = def.hp;
    if (def.speed   !== undefined) result.speed   = def.speed;
    if (def.damage  !== undefined) result.damage  = def.damage;
    if (def.reward  !== undefined) result.reward  = def.reward;
    if (def.leashTo !== undefined) result.leashTo = def.leashTo;
    if (def.circleAt         !== undefined) result.circleAt         = def.circleAt;
    if (def.circleRadius     !== undefined) result.circleRadius     = def.circleRadius;
    if (def.circleDurationMs !== undefined) result.circleDurationMs = def.circleDurationMs;
    return result;
  }

  // GameSceneがwaveManager.getWarning()を呼ぶためスタブ実装
  getWarning(scaledTime) { return null; }
}

// ─── YInflowManager（Y専用・時間駆動流入） ──────────────────────────
// Y開始（onDetourActivate）からの経過時間で発火する専用スポーン管理。
// 護衛が停止しているY中はSegmentManagerの位置トリガー（progress）が使えないため、
// 独立した時間駆動の流入だけを担当する。SegmentManager本体（区間のretreat）とは
// 無関係に、自分がスポーンしたゾンビだけをY終了時にretreatAll()で退場させる。
var YInflowManager = class YInflowManager {
  constructor(spawns, yInflowDefs) {
    this.spawns   = spawns;
    this.defs     = yInflowDefs ?? [];
    this._startAt = null;    // Y開始時刻（scaledTime）。start()で設定
    this._fired   = new Set();
    this._zombies = [];      // 自分がスポーンしたゾンビ（Y終了時のretreat対象）
  }

  start(scaledTime) {
    this._startAt = scaledTime;
  }

  update(scaledTime, spawnFn) {
    if (this._startAt === null) return;
    const elapsed = scaledTime - this._startAt;
    for (let i = 0; i < this.defs.length; i++) {
      if (this._fired.has(i)) continue;
      const def = this.defs[i];
      if (elapsed < (def.atMs ?? 0)) continue;
      const coord = this.spawns[def.spawn];
      if (!coord) { this._fired.add(i); continue; }
      const count    = def.count ?? 1;
      const enemyDef = this._buildEnemyDef(def.enemy ?? def);
      for (let n = 0; n < count; n++) {
        const z = spawnFn(coord.col, coord.row, enemyDef, 'Y', null);
        if (z) this._zombies.push(z);
      }
      this._fired.add(i);
    }
  }

  // Y終了時（onDetourEnd）に呼ぶ。区間境界のretreatと同じ扱い（失敗の蓄積を切る）
  retreatAll() {
    for (const z of this._zombies) {
      if (z.alive && !z._retreating) z.retreat();
    }
    this._zombies = [];
  }

  _buildEnemyDef(def) {
    const type   = def.type ?? 'salaryman';
    const base   = (typeof ZOMBIE_BASE !== 'undefined' ? ZOMBIE_BASE[type] : null) ?? {};
    const result = { ...base, type };
    if (def.hp      !== undefined) result.hp      = def.hp;
    if (def.speed   !== undefined) result.speed   = def.speed;
    if (def.damage  !== undefined) result.damage  = def.damage;
    if (def.reward  !== undefined) result.reward  = def.reward;
    if (def.leashTo !== undefined) result.leashTo = def.leashTo;
    if (def.circleAt         !== undefined) result.circleAt         = def.circleAt;
    if (def.circleRadius     !== undefined) result.circleRadius     = def.circleRadius;
    if (def.circleDurationMs !== undefined) result.circleDurationMs = def.circleDurationMs;
    return result;
  }
}
