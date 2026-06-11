// ゾンビ（グレーボックス：緑の円）
// タワーは経路をブロックしない。遮蔽物プロップのみブロック。
class Zombie {
  constructor(spawnCol, spawnRow, def, pf, waveNum) {
    const { x, y } = cellCenter(spawnCol, spawnRow);
    this.x           = x;
    this.y           = y;
    this.hp          = def.hp;
    this.maxHp       = def.hp;
    this.speed       = def.speed;
    this.damage      = def.damage;
    this.reward      = def.reward ?? 20;
    this.pf          = pf;
    this.waveNum     = waveNum;
    this.alive       = true;
    this.rewarded    = false;
    this.path        = [];
    this.wpIdx       = 0;
    this.lastPathCalc = -9999;
    this.lastAttack  = -9999;
    this.lastTargetCol = -1;
    this.lastTargetRow = -1;
    this.lastDx      = 1;
    this.lastDy      = 0;
    this.hitFlash    = 0;
    this.onDeath     = null;
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(scaledTime, dt, escort) {
    if (!this.alive) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    // 護衛との距離チェック
    const dx          = escort.x - this.x;
    const dy          = escort.y - this.y;
    const distToEscort = Math.sqrt(dx * dx + dy * dy);

    // 攻撃範囲内なら攻撃して停止
    if (distToEscort < CELL * 0.9) {
      if (scaledTime - this.lastAttack > 1000) {
        this.lastAttack = scaledTime;
        escort.takeDamage(this.damage);
      }
      return;
    }

    // 経路再計算：500ms ごと OR 護衛が別セルに移動したとき
    const targetChanged = escort.col !== this.lastTargetCol || escort.row !== this.lastTargetRow;
    if (targetChanged || scaledTime - this.lastPathCalc > 500) {
      this.lastPathCalc  = scaledTime;
      this.lastTargetCol = escort.col;
      this.lastTargetRow = escort.row;

      const cp = this.pf.find(this.col, this.row, escort.col, escort.row);
      if (cp && cp.length > 1) {
        this.path  = cp.slice(1).map(p => cellCenter(p.col, p.row));
        this.wpIdx = 0;
      }
    }

    // ウェイポイント追従
    if (!this.path.length || this.wpIdx >= this.path.length) return;

    const wp    = this.path[this.wpIdx];
    const wpDx  = wp.x - this.x;
    const wpDy  = wp.y - this.y;
    const dist  = Math.sqrt(wpDx * wpDx + wpDy * wpDy);
    const step  = this.speed * dt / 1000;

    if (dist <= step) {
      this.x = wp.x;
      this.y = wp.y;
      this.wpIdx++;
    } else {
      this.lastDx = wpDx;
      this.lastDy = wpDy;
      this.x += (wpDx / dist) * step;
      this.y += (wpDy / dist) * step;
    }
  }

  // true: 死亡した
  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp       -= amount;
    this.hitFlash  = 100;
    if (this.hp <= 0) {
      this.hp    = 0;
      this.alive = false;
      audioSynth.hit();
      if (this.onDeath) this.onDeath();
      return true;
    }
    return false;
  }

  draw(g) {
    if (!this.alive) return;

    const r       = 16;
    const isFlash = this.hitFlash > 0;

    g.fillStyle(isFlash ? 0xffffff : 0x22cc44, 1);
    g.fillCircle(this.x, this.y, r);
    g.lineStyle(1.5, 0x115522, 1);
    g.strokeCircle(this.x, this.y, r);

    // 向き（目のような点）
    const norm = Math.sqrt(this.lastDx ** 2 + this.lastDy ** 2) || 1;
    const ex   = this.x + (this.lastDx / norm) * r * 0.4;
    const ey   = this.y + (this.lastDy / norm) * r * 0.4;
    g.fillStyle(0x000000, 1);
    g.fillCircle(ex, ey, 3);

    // HPバー（傷ついているときのみ表示）
    if (this.hp < this.maxHp) {
      const bw    = 28, bh = 3;
      const ratio = this.hp / this.maxHp;
      g.fillStyle(0x330000, 1);
      g.fillRect(this.x - bw / 2, this.y - r - 6, bw, bh);
      g.fillStyle(0xff3333, 1);
      g.fillRect(this.x - bw / 2, this.y - r - 6, bw * ratio, bh);
    }
  }
}
