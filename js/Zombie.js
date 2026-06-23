// ゾンビ
// スプライット配置: assets/sprites/zombie/{type}/walk_{dir}_{frame:02d}.png
// ファイルがなければ緑の円（グレーボックス）で自動フォールバック
// type は stage JSON の waves[].enemy.type と一致させること
class Zombie {
  constructor(scene, spawnCol, spawnRow, def, waveNum, leader = null) {
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
    this.waveNum       = waveNum;
    this.alive         = true;
    this.rewarded      = false;
    this.path          = [];
    this.wpIdx         = 0;
    this._ffVersion    = -1;
    this.leader        = leader;  // チェーンリーダー（null = 自分がリーダー）
    this.lastAttack    = -9999;
    this.lastDx        = 0;
    this.lastDy        = 0;
    this.hitFlash      = 0;
    this._animTime     = 0;
    this._animFrame    = 1;
    this.onDeath       = null;
    this._sprite       = null;
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(scaledTime, dt, escort) {
    if (!this.alive) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    // インターバル中（escort=null）は既存パスを進み続け、攻撃しない
    if (!escort || escort.defeated) {
      this._advancePath(dt);
      return;
    }

    const dx = escort.x - this.x, dy = escort.y - this.y;
    const distToEscort = Math.sqrt(dx * dx + dy * dy);

    if (distToEscort < CELL * 0.9) {
      // 攻撃中 - アニメ静止（フレーム1）
      this._animTime  = 0;
      this._animFrame = 1;
      if (scaledTime - this.lastAttack > 1000) {
        this.lastAttack = scaledTime;
        escort.takeDamage(this.damage);
      }
      return;
    }

    // 移動中 - 歩行アニメ進行
    this._animTime  += dt;
    this._animFrame  = Math.floor(this._animTime / (1000 / zombieFps(this.type))) % zombieFrameCount(this.type) + 1;

    // リーダー死亡時は自分がリーダーに昇格
    if (this.leader !== null && !this.leader.alive) this.leader = null;

    if (this.leader !== null) {
      // フォロワー：リーダーの現在座標を追う（groupIntervalの時間差が自然なスペースを生む）
      this.path  = [{ x: this.leader.x, y: this.leader.y }];
      this.wpIdx = 0;
    } else {
      // リーダー：FlowFieldで経路取得
      const ff = this.scene.flowField;
      if (this.wpIdx >= this.path.length || this._ffVersion !== ff.version) {
        this._ffVersion = ff.version;
        const next = ff.getNextCell(this.col, this.row);
        if (next) {
          this.path  = [cellCenter(next.col, next.row)];
          this.wpIdx = 0;
        }
      }
    }

    this._advancePath(dt);
  }

  _advancePath(dt) {
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

    const dir = dirFromVec(this.lastDx, this.lastDy);

    if (this.scene.textures.exists('salaryman_right')) {
      // ─── スプライトシートモード ───────────────────────────
      // 方向ごとにスプライト切り替え（upはright/leftのフォールバック）
      let sheetKey, animKey;
      if (dir === 'down' && this.scene.textures.exists('salaryman_down')) {
        sheetKey = 'salaryman_down'; animKey = 'salaryman_walk_down';
      } else if (dir === 'up' && this.scene.textures.exists('salaryman_up')) {
        sheetKey = 'salaryman_up';   animKey = 'salaryman_walk_up';
      } else {
        sheetKey = 'salaryman_right'; animKey = 'salaryman_walk_right';
      }

      if (!this._sprite || !this._sprite.anims || this._spriteKey !== sheetKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.sprite(this.x, this.y, sheetKey).setDepth(3);
        this._spriteKey = sheetKey;
        if (this.scene.anims.exists(animKey)) this._sprite.play(animKey);
      }
      this._sprite.setPosition(this.x, this.y).setVisible(true);
      this._sprite.setFlipX(dir === 'left');
      this._sprite.setTint(this.hitFlash > 0 ? 0xff8888 : 0xffffff);
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
