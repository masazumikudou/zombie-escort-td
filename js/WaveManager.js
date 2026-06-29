// ─── WaveManager ─────────────────────────────────────────────
// グループスポーン方式：護衛がゴールするまでスポーンし続ける
//
// JSONパラメーター（waves[]各要素）:
//   startDelay    : waves[0]のみ有効。初回グループまでの待機時間(ms)
//   duration      : このウェーブを何秒間継続するか（次のウェーブへの切替タイミング）
//   spawnInterval : グループとグループの間隔(ms)
//   groupSize     : 1グループの人数
//   groupInterval : グループ内の個体間隔(ms)
//   enemy         : 敵パラメーター

class WaveManager {
  constructor(waves, spawns, escort) {
    this.waves     = waves;
    this.spawns    = spawns;
    this.escort    = escort;
    this.waveIdx   = 0;
    this.startTime = 0;
    this.nextGroupTime   = Infinity;
    this._groupRemaining = 0;
    this._groupNextTime  = Infinity;
    this._groupSpawn     = null;
    this._warningSpawn   = null;
    this._groupLeaderZombie = null;  // グループ1体目（全フォロワーの基準リーダー）
    this.allDone         = false;
    this._onWaveStart    = null;
    this._spawnMultiplier = 1.0;
  }

  setSpawnMultiplier(m) { this._spawnMultiplier = m; }

  get currentWaveNum() { return this.waveIdx + 1; }
  get totalWaves()     { return this.waves.length; }

  onWaveStart(cb) { this._onWaveStart = cb; }

  start(timeOffset = 0) {
    const w = this.waves[0];
    if (!w) { this.allDone = true; return; }
    // startDelay 後を elapsed=0 の基準にする（duration がズレなくなる）
    this.startTime     = timeOffset + (w.startDelay ?? 0);
    this.nextGroupTime = timeOffset + (w.startDelay ?? 0);
    if (this._onWaveStart) this._onWaveStart(1, this.waves.length);
  }

  update(scaledTime, spawnFn) {
    if (this.allDone) return;
    if (!this.escort || !this.escort.alive || this.escort.reached) return;

    // 時間経過でウェーブ進行
    const elapsed    = scaledTime - this.startTime;
    const newWaveIdx = this._calcWaveIdx(elapsed);
    if (newWaveIdx !== this.waveIdx) {
      this.waveIdx = newWaveIdx;
      const newWave = this.waves[this.waveIdx];
      // 次ウェーブの startDelay 分だけ次グループ発火を遅らせる
      this.nextGroupTime    = scaledTime + (newWave.startDelay ?? 0);
      this._groupRemaining    = 0;
      this._warningSpawn      = null;
      this._groupLeaderZombie = null;
      if (this._onWaveStart) this._onWaveStart(this.waveIdx + 1, this.waves.length);
    }

    const wave = this.waves[this.waveIdx];
    if (!wave) return;

    // ─ 3秒前予告：スポーン地点を確定してロック ─
    if (this._groupRemaining === 0 && this.nextGroupTime !== Infinity) {
      const remaining = this.nextGroupTime - scaledTime;
      if (remaining <= 3000 && remaining > 0 && this._warningSpawn === null) {
        const sorted = this._sortedSpawns();
        this._warningSpawn = sorted[0] ?? null;
      }
    }

    // ─ グループ内の連鎖スポーン ─
    if (this._groupRemaining > 0 && scaledTime >= this._groupNextTime) {
      const z = spawnFn(this._groupSpawn.col, this._groupSpawn.row, wave.enemy, this.waveIdx, this._groupLeaderZombie);
      if (this._groupLeaderZombie === null) this._groupLeaderZombie = z;  // 1体目がリーダー
      this._groupRemaining--;
      this._groupNextTime = scaledTime + (wave.groupInterval ?? 800) / this._spawnMultiplier;
      // 最後の1体が出た瞬間から spawnInterval を待つ
      if (this._groupRemaining === 0) {
        this.nextGroupTime      = scaledTime + (wave.spawnInterval ?? 7000) / this._spawnMultiplier;
        this._warningSpawn      = null;
        this._groupLeaderZombie = null;  // 次グループのリーダーをリセット
      }
    }

    // ─ 次グループの発火 ─
    if (this._groupRemaining === 0 && scaledTime >= this.nextGroupTime) {
      const sorted = this._sortedSpawns();
      if (sorted.length === 0) return;
      this._groupSpawn      = this._warningSpawn ?? sorted[0];
      this._warningSpawn    = null;
      this._prevGroupZombie = null;
      this._groupRemaining  = wave.groupSize ?? 1;
      this._groupNextTime   = scaledTime;
      this.nextGroupTime    = Infinity;
    }
  }

  // 3秒前に確定したスポーン地点と残り時間を返す（確定前 or スポーン中はnull）
  getWarning(scaledTime) {
    if (this.allDone || !this.escort?.alive || this.escort?.reached) return null;
    if (this._groupRemaining > 0) return null;
    if (!this._warningSpawn) return null;
    const remaining = this.nextGroupTime - scaledTime;
    if (remaining <= 0) return null;
    return { spawn: this._warningSpawn, remaining };
  }

  _calcWaveIdx(elapsedMs) {
    let acc = 0;
    for (let i = 0; i < this.waves.length - 1; i++) {
      const w = this.waves[i];
      // duration 未指定なら count*spawnInterval から自動計算
      const autoDuration = ((w.count ?? w.groupSize ?? 1) * (w.spawnInterval ?? 7000)) / 1000;
      acc += (w.duration ?? autoDuration) * 1000;
      if (elapsedMs < acc) return i;
    }
    return this.waves.length - 1;
  }

  _sortedSpawns() {
    if (!this.escort || this.spawns.length === 0) return [...this.spawns];
    const ex = this.escort.x / CELL;
    const ey = this.escort.y / CELL;
    return [...this.spawns].sort((a, b) => {
      const da = (a.col - ex) ** 2 + (a.row - ey) ** 2;
      const db = (b.col - ex) ** 2 + (b.row - ey) ** 2;
      return da - db;
    });
  }
}
