// ウェーブ管理：スポーン制御・クリア判定
class WaveManager {
  constructor(waves, spawns) {
    this.waves    = waves;
    this.spawns   = spawns;
    this.waveIdx  = 0;
    this.spawnCount   = 0;
    this.deadCount    = 0;
    this.spawnSide    = 0;       // スポーン地点をローテーション
    this.nextSpawnTime = Infinity;
    this.waitingClear  = false;
    this.allDone       = false;
    this._onWaveStart  = null;   // コールバック (waveNum, total) => {}
    this._onAllDone    = null;   // コールバック () => {}
  }

  get currentWaveNum() { return this.waveIdx + 1; }
  get totalWaves()     { return this.waves.length; }

  onWaveStart(cb) { this._onWaveStart = cb; }
  onAllDone(cb)   { this._onAllDone   = cb; }

  // timeOffset: scaledTime の現在値（2人目以降の護衛用）
  start(timeOffset = 0) {
    const w = this.waves[0];
    if (!w) { this.allDone = true; return; }
    this.nextSpawnTime = timeOffset + w.startDelay;
    if (this._onWaveStart) this._onWaveStart(1, this.waves.length);
  }

  // spawnFn: (col, row, def, waveNum) => Zombie
  update(scaledTime, spawnFn) {
    if (this.allDone) return;

    const wave = this.waves[this.waveIdx];
    if (!wave) { this.allDone = true; if (this._onAllDone) this._onAllDone(); return; }

    // クリア待ち：全員死亡チェック
    if (this.waitingClear) {
      if (this.deadCount >= this.spawnCount) {
        this._advance(scaledTime);
      }
      return;
    }

    if (scaledTime < this.nextSpawnTime) return;

    // 1体スポーン
    const spawn = this.spawns[this.spawnSide % this.spawns.length];
    this.spawnSide++;
    const z = spawnFn(spawn.col, spawn.row, wave.enemy, this.waveIdx);
    const prevOnDeath = z.onDeath;
    z.onDeath = () => { this.deadCount++; if (prevOnDeath) prevOnDeath(); };
    this.spawnCount++;
    this.nextSpawnTime = scaledTime + wave.spawnInterval;

    if (this.spawnCount >= wave.count) {
      this.waitingClear = true;
    }
  }

  _advance(scaledTime) {
    this.waveIdx++;
    this.spawnCount   = 0;
    this.deadCount    = 0;
    this.waitingClear = false;

    if (this.waveIdx >= this.waves.length) {
      this.allDone = true;
      if (this._onAllDone) this._onAllDone();
      return;
    }

    this.nextSpawnTime = scaledTime + this.waves[this.waveIdx].startDelay;
    if (this._onWaveStart) this._onWaveStart(this.waveIdx + 1, this.waves.length);
  }
}
