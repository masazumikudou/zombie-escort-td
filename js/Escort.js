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
    this.alive        = true;
    this.reached      = false;
    this.defeated     = false;
    this._defeatTimer = 0;
    this.lastDx  = 1;
    this.lastDy  = 0;
    this.hitFlash   = 0;
    this._animTime  = 0;
    this._animFrame = 1;
    this._sprite    = null;
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(dt) {
    if (!this.alive) return;

    if (this.defeated) {
      this._defeatTimer += dt;
      if (this._defeatTimer >= 2000) this.alive = false;
      return;
    }

    if (this.reached) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    // 歩行アニメ（移動中は常にサイクル）
    this._animTime  += dt;
    this._animFrame  = Math.floor(this._animTime / (1000 / escortFps(this.variant))) % escortFrameCount(this.variant) + 1;

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
    if (!this.alive || this.defeated) return;
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = 200;
    audioSynth.escortHit();
    if (this.hp <= 0) this.defeated = true;
  }

  draw(g) {
    if (!this.alive) {
      if (this._sprite) this._sprite.setVisible(false);
      return;
    }

    if (this.defeated) {
      if (this._sprite) { this._sprite.destroy(); this._sprite = null; }
      const blink = Math.floor(this._defeatTimer / 200) % 2 === 0;
      if (blink) {
        g.fillStyle(0x555555, 0.7);
        g.fillCircle(this.x, this.y, 22);
        g.lineStyle(2, 0x888888, 0.5);
        g.strokeCircle(this.x, this.y, 22);
      }
      return;
    }

    if (this.reached) {
      if (this._sprite) this._sprite.setVisible(false);
      return;
    }

    const dir = dirFromVec(this.lastDx, this.lastDy);

    // 方向別シートキー
    let sheetKey, animKey;
    if (dir === 'down' && this.scene.textures.exists(`${this.variant}_down`)) {
      sheetKey = `${this.variant}_down`;
      animKey  = `${this.variant}_walk_down`;
    } else if (dir === 'up' && this.scene.textures.exists(`${this.variant}_up`)) {
      sheetKey = `${this.variant}_up`;
      animKey  = `${this.variant}_walk_up`;
    } else {
      sheetKey = `${this.variant}_right`;
      animKey  = `${this.variant}_walk_right`;
    }

    if (this.scene.textures.exists(sheetKey)) {
      // ─── スプライットシートモード ────────────────────
      if (!this._sprite || this._spriteKey !== sheetKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.sprite(this.x, this.y, sheetKey).setDepth(3);
        this._spriteKey = sheetKey;
        if (this.scene.anims.exists(animKey)) this._sprite.play(animKey);
      }
      this._sprite.setScale(100 / 256);
      this._sprite.setOrigin(0.5, 0.75);
      this._sprite.setPosition(this.x, this.y + 15).setVisible(true);
      this._sprite.setFlipX(dir !== 'left');
      this._sprite.setTint(this.hitFlash > 0 ? 0xff8888 : 0xffffff);
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
