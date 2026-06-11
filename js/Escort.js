// 護衛対象
// スプライット配置: assets/sprites/escort/{variant}/walk_{dir}_{frame:02d}.png
// ファイルがなければ青い円（グレーボックス）で自動フォールバック
class Escort {
  constructor(scene, pixelPath, def) {
    this.scene   = scene;
    this.path    = pixelPath;
    this.wpIdx   = 0;
    this.x       = pixelPath[0]?.x ?? 0;
    this.y       = pixelPath[0]?.y ?? 0;
    this.hp      = def.hp;
    this.maxHp   = def.hp;
    this.speed   = def.speed;
    this.variant = def.variant ?? 'dad';
    this.alive   = true;
    this.reached = false;
    this.lastDx  = 1;
    this.lastDy  = 0;
    this.hitFlash = 0;
    this._sprite  = null;
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(dt) {
    if (!this.alive || this.reached) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    if (this.wpIdx >= this.path.length) { this.reached = true; return; }

    const wp   = this.path[this.wpIdx];
    const dx   = wp.x - this.x, dy = wp.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this.speed * dt / 1000;

    if (dist <= step) {
      this.x = wp.x; this.y = wp.y;
      this.wpIdx++;
      if (this.wpIdx >= this.path.length) this.reached = true;
    } else {
      this.lastDx = dx; this.lastDy = dy;
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = 200;
    audioSynth.escortHit();
    if (this.hp <= 0) this.alive = false;
  }

  draw(g) {
    if (!this.alive || this.reached) {
      if (this._sprite) this._sprite.setVisible(false);
      return;
    }

    const dir    = dirFromVec(this.lastDx, this.lastDy);
    const texKey = escortTexKey(this.variant, dir, 1);

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

      const r       = 22;
      const flash   = this.hitFlash > 0;
      g.fillStyle(flash ? 0xff6666 : 0x4488ff, 1);
      g.fillCircle(this.x, this.y, r);
      g.lineStyle(2.5, flash ? 0xff0000 : 0x2244cc, 1);
      g.strokeCircle(this.x, this.y, r);

      const norm = Math.sqrt(this.lastDx ** 2 + this.lastDy ** 2) || 1;
      g.fillStyle(0xffffff, 0.9);
      g.fillCircle(this.x + (this.lastDx / norm) * r * 0.5,
                   this.y + (this.lastDy / norm) * r * 0.5, 5);
    }

    // HPバーは常にgで描画
    const barW  = 44, barH = 5;
    const ratio = this.hp / this.maxHp;
    const barC  = ratio > 0.5 ? 0x00ee00 : ratio > 0.25 ? 0xffaa00 : 0xff2222;
    g.fillStyle(0x111122, 1);
    g.fillRect(this.x - barW / 2, this.y - 34, barW, barH);
    g.fillStyle(barC, 1);
    g.fillRect(this.x - barW / 2, this.y - 34, barW * ratio, barH);
  }

  cleanup() {
    if (this._sprite) { this._sprite.destroy(); this._sprite = null; }
  }
}
