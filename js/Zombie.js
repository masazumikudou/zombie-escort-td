// ゾンビ
// スプライット配置: assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
// ファイルがなければ緑の円（グレーボックス）で自動フォールバック
// type は stage JSON の waves[].enemy.type と一致させること
class Zombie {
  constructor(scene, spawnCol, spawnRow, def, pf, waveNum) {
    const { x, y } = cellCenter(spawnCol, spawnRow);
    this.scene         = scene;
    this.x             = x;
    this.y             = y;
    this.hp            = def.hp;
    this.maxHp         = def.hp;
    this.speed         = def.speed;
    this.damage        = def.damage;
    this.reward        = def.reward ?? 20;
    this.type          = def.type ?? 'normal';
    this.pf            = pf;
    this.waveNum       = waveNum;
    this.alive         = true;
    this.rewarded      = false;
    this.path          = [];
    this.wpIdx         = 0;
    this.lastPathCalc  = -9999;
    this.lastAttack    = -9999;
    this.lastTargetCol = -1;
    this.lastTargetRow = -1;
    this.lastDx        = 1;
    this.lastDy        = 0;
    this.hitFlash      = 0;
    this.onDeath       = null;
    this._sprite       = null;
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(scaledTime, dt, escort) {
    if (!this.alive) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    const dx = escort.x - this.x, dy = escort.y - this.y;
    const distToEscort = Math.sqrt(dx * dx + dy * dy);

    if (distToEscort < CELL * 0.9) {
      if (scaledTime - this.lastAttack > 1000) {
        this.lastAttack = scaledTime;
        escort.takeDamage(this.damage);
      }
      return;
    }

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

    if (!this.path.length || this.wpIdx >= this.path.length) return;

    const wp   = this.path[this.wpIdx];
    const wpDx = wp.x - this.x, wpDy = wp.y - this.y;
    const dist = Math.sqrt(wpDx * wpDx + wpDy * wpDy);
    const step = this.speed * dt / 1000;

    if (dist <= step) {
      this.x = wp.x; this.y = wp.y; this.wpIdx++;
    } else {
      this.lastDx = wpDx; this.lastDy = wpDy;
      this.x += (wpDx / dist) * step;
      this.y += (wpDy / dist) * step;
    }
  }

  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    this.hitFlash = 100;
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
    if (!this.alive) {
      if (this._sprite) this._sprite.setVisible(false);
      return;
    }

    const dir    = dirFromVec(this.lastDx, this.lastDy);
    const texKey = zombieTexKey(this.type, dir, 1);

    if (this.scene.textures.exists(texKey)) {
      // ─── スプライットモード ───────────────────────────
      if (!this._sprite) {
        this._sprite = this.scene.add.image(this.x, this.y, texKey).setDepth(3);
      } else {
        this._sprite.setPosition(this.x, this.y).setVisible(true);
        if (this._sprite.texture.key !== texKey) this._sprite.setTexture(texKey);
      }
      this._sprite.setFlipX(dir === 'left');
    } else {
      // ─── グレーボックス（単色円） ─────────────────────
      if (this._sprite) { this._sprite.destroy(); this._sprite = null; }

      const r     = 16;
      const flash = this.hitFlash > 0;
      g.fillStyle(flash ? 0xffffff : 0x22cc44, 1);
      g.fillCircle(this.x, this.y, r);
      g.lineStyle(1.5, 0x115522, 1);
      g.strokeCircle(this.x, this.y, r);

      const norm = Math.sqrt(this.lastDx ** 2 + this.lastDy ** 2) || 1;
      g.fillStyle(0x000000, 1);
      g.fillCircle(this.x + (this.lastDx / norm) * r * 0.4,
                   this.y + (this.lastDy / norm) * r * 0.4, 3);
    }

    // HPバーは常にgで描画
    if (this.hp < this.maxHp) {
      const bw    = 28, bh = 3;
      const ratio = this.hp / this.maxHp;
      g.fillStyle(0x330000, 1);
      g.fillRect(this.x - bw / 2, this.y - 22, bw, bh);
      g.fillStyle(0xff3333, 1);
      g.fillRect(this.x - bw / 2, this.y - 22, bw * ratio, bh);
    }
  }

  cleanup() {
    if (this._sprite) { this._sprite.destroy(); this._sprite = null; }
  }
}
