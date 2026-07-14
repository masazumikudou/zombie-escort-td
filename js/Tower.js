// ─── 弾丸 ────────────────────────────────────────────────────
class Bullet {
  constructor(x, y, target, damage, speed = 500, source = null) {
    this.x      = x;
    this.y      = y;
    this.target = target;
    this.damage = damage;
    this.speed  = speed;
    this.source = source;
    this.active = true;
  }

  update(dt) {
    if (!this.active) return;
    if (!this.target.alive) { this.active = false; return; }
    const dx = this.target.x - this.x, dy = this.target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 10) { this.target.takeDamage(this.damage, this.source); this.active = false; return; }
    const step = this.speed * dt / 1000;
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
  }

  draw(g) {
    if (!this.active) return;
    g.fillStyle(0xffffaa, 1);
    g.fillCircle(this.x, this.y, 3);
  }
}

// ─── 弧弾丸（影＋縦オフセット方式） ─────────────────────────────
class ArcBullet {
  constructor(scene, x, y, targetX, targetY, damage, aoeRadius, zombiesRef, singleTarget = null) {
    this.scene         = scene;
    this.startX        = x;       this.startY    = y;
    this.targetX       = targetX; this.targetY   = targetY;
    this.damage        = damage;
    this.aoeRadius     = aoeRadius;
    this._zombies      = zombiesRef;
    this._singleTarget = singleTarget;
    this.active    = true;
    this.elapsed   = 0;
    this.duration  = 1200;
    this.arcHeight = 201;
    this.x = x; this.y = y;

    if (scene.textures.exists('soccer_ball')) {
      this._baseScale = 45 / 1000;
      this._ball = scene.add.sprite(x, y, 'soccer_ball')
        .setFrame(0).setDepth(6).setScale(this._baseScale);
    }
  }

  update(dt) {
    if (!this.active) return;
    this.elapsed = Math.min(this.elapsed + dt, this.duration);
    const t = this.elapsed / this.duration;

    this.x = this.startX + (this.targetX - this.startX) * t;
    this.y = this.startY + (this.targetY - this.startY) * t;

    if (this._ball) {
      const arcOffset = this.arcHeight * Math.sin(t * Math.PI);
      const scale     = this._baseScale * (1 + 0.5 * Math.sin(t * Math.PI));
      this._ball.setPosition(this.x, this.y - arcOffset).setScale(scale);
      this._ball.setFrame(Math.floor(this.elapsed / 150) % 2);
    }

    if (t >= 1) {
      if (this._singleTarget) {
        if (this._singleTarget.alive) this._singleTarget.takeDamage(this.damage);
      } else {
        const r2 = this.aoeRadius * this.aoeRadius;
        for (const z of this._zombies) {
          if (!z.alive || z._spawnTimer > 0) continue;
          const dx = z.x - this.targetX, dy = z.y - this.targetY;
          if (dx * dx + dy * dy <= r2) z.takeDamage(this.damage);
        }
      }
      this.active = false;
      if (this._ball) { this._ball.destroy(); this._ball = null; }
    }
  }

  draw(g) {
    if (!this.active) return;
    const t = this.elapsed / this.duration;
    const shadowScale = 1 - 0.6 * Math.sin(t * Math.PI);
    g.fillStyle(0x000000, 0.35 * shadowScale);
    g.fillEllipse(this.x, this.y, 20 * shadowScale, 10 * shadowScale);
  }
}

// ─── タワー ──────────────────────────────────────────────────
// スプライット配置: assets/sprites/tower/{type}.png
// ファイルがなければ色付き四角（グレーボックス）で自動フォールバック
class Tower {
  constructor(scene, col, row, type) {
    this.scene    = scene;
    this.col      = col;
    this.row      = row;
    this.type     = type;
    const def     = TOWER_DEFS[type];
    this.range    = def.range * CELL;
    this.fireRate = def.fireRate;
    this.damage   = def.damage;
    this.color    = def.color;
    this.sell       = def.sell;
    this.durability = def.durability ?? null;
    this.direction  = null;   // laser専用：'up'|'down'|'left'|'right'
    this._laserFlash = 0;     // laser発射フラッシュ残り時間(ms)
    this.selected   = false;
    const { x, y } = cellCenter(col, row);
    this.x        = x;
    this.y        = y;
    this.lastFire = -99999;
    this._sprite  = null;
    this._initSprite();
  }

  _initSprite() {
    if (this.type === 'bat') {
      if (!this.scene.textures.exists('tower_bat')) return;
      this._sprite = this.scene.add.sprite(this.x, this.y, 'tower_bat')
        .setFrame(0).setScale(0.12).setDepth(2).setOrigin(0.5, 0.725);
      return;
    }
    if (this.type === 'punch') {
      if (!this.scene.textures.exists('tower_punch')) return;
      this._sprite = this.scene.add.sprite(this.x, this.y, 'tower_punch')
        .setFrame(0).setScale(CELL / 330 * 0.9).setDepth(2).setOrigin(0.5, 0.542);
      if (this.scene.textures.exists('tower_punch_back')) {
        this._spriteBack = this.scene.add.sprite(this.x, this.y, 'tower_punch_back')
          .setFrame(0).setScale(CELL / 382 * 0.9).setDepth(2).setOrigin(0.5, 0.703)
          .setVisible(false);
      }
      return;
    }
    const key = `tower_${this.type}`;
    if (!this.scene.textures.exists(key)) return;
    this._sprite = this.scene.add.image(this.x, this.y, key).setDepth(2);
  }

  _punchAnim() {
    const spr = this.direction === 'up' ? this._spriteBack : this._sprite;
    if (!spr) return;
    spr.setFrame(1);
    this.scene.time.delayedCall(280, () => {
      if (spr) spr.setFrame(0);
    });
  }

  _findNearest(zombies, escort = null) {
    const range2 = this.range * this.range;
    const ref    = escort ?? this;  // 護衛基準、なければタワー基準
    let nearest = null, minDist = Infinity;
    for (const z of zombies) {
      if (!z.alive || z._spawnTimer > 0) continue;
      const dx = z.x - this.x, dy = z.y - this.y;
      if (dx * dx + dy * dy > range2) continue;
      const ex = z.x - ref.x, ey = z.y - ref.y;
      const d  = Math.sqrt(ex * ex + ey * ey);
      if (d < minDist) { minDist = d; nearest = z; }
    }
    return nearest;
  }

  update(scaledTime, dt, zombies, bullets, escort = null) {
    this._laserFlash = Math.max(0, this._laserFlash - dt);
    if (scaledTime - this.lastFire < this.fireRate) return;

    if (this.type === 'bat') {
      const adj = [
        { tc: this.col + 1, tr: this.row },
        { tc: this.col - 1, tr: this.row },
        { tc: this.col,     tr: this.row + 1 },
        { tc: this.col,     tr: this.row - 1 },
      ];
      let hit = false;
      for (const { tc, tr } of adj) {
        for (const z of zombies) {
          if (!z.alive || z._spawnTimer > 0) continue;
          if (Math.floor(z.x / CELL) === tc && Math.floor(z.y / CELL) === tr) {
            z.takeDamage(this.damage, { type: this.type, col: this.col, row: this.row });
            hit = true;
          }
        }
      }
      if (!hit) return;
      this.lastFire = scaledTime;
      audioSynth.shoot();
      return;
    }

    if (this.type === 'punch') {
      if (!this.direction) return;
      let tc = this.col, tr = this.row;
      if      (this.direction === 'right') tc = this.col + 1;
      else if (this.direction === 'left')  tc = this.col - 1;
      else if (this.direction === 'up')    tr = this.row - 1;
      const target = zombies.find(z => z.alive && !z._spawnTimer &&
        Math.floor(z.x / CELL) === tc && Math.floor(z.y / CELL) === tr);
      if (!target) return;
      this.lastFire = scaledTime;
      target.takeDamage(this.damage, { type: this.type, col: this.col, row: this.row });
      this._punchAnim();
      audioSynth.shoot();
      return;
    }

    if (this.type === 'cannon') {
      const target = this._findNearest(zombies, escort);
      if (!target) return;
      this.lastFire = scaledTime;
      bullets.push(new ArcBullet(
        this.scene, this.x, this.y,
        target.x, target.y,
        this.damage, 0, zombies, target
      ));
      audioSynth.shoot();
      return;
    }

    if (this.type === 'laser') {
      if (!this.direction) return;  // 方向未設定
      const range = this._laserRange();
      const hit = this._laserHit(zombies, range);
      if (hit > 0) {
        this.lastFire   = scaledTime;
        this._laserFlash = 180;
        audioSynth.shoot();
      }
    } else {
      const target = this._findNearest(zombies, escort);
      if (!target) return;
      this.lastFire = scaledTime;
      const _fd = target.x - this.x, _fd2 = target.y - this.y;
      this.scene._playLog?.push(`[FIRE] t=${Math.round(scaledTime)}ms tower=${this.type}@(${this.col},${this.row}) → id=${target._logId} dist=${Math.round(Math.sqrt(_fd*_fd+_fd2*_fd2))}`);
      bullets.push(new Bullet(this.x, this.y, target, this.damage, 500, { type: this.type, col: this.col, row: this.row }));
      audioSynth.shoot();
    }
  }

  // レーザーがプロップで遮られる最大ピクセル距離を返す
  _laserRange() {
    const propCells = this.scene.propCells;
    const d = this.direction;
    let maxDist = 9999;
    for (let step = 1; step <= 20; step++) {
      let cc = this.col, cr = this.row;
      if (d === 'right') cc = this.col + step;
      if (d === 'left')  cc = this.col - step;
      if (d === 'down')  cr = this.row + step;
      if (d === 'up')    cr = this.row - step;
      if (cc < 0 || cr < 0 || cc >= COLS || cr >= ROWS) { maxDist = step * CELL; break; }
      if (propCells?.has(`${cc},${cr}`)) { maxDist = (step - 0.5) * CELL; break; }
    }
    return maxDist;
  }

  // レーザー方向のゾンビに全ダメージ、ヒット数を返す
  _laserHit(zombies, range) {
    let hit = 0;
    for (const z of zombies) {
      if (!z.alive || z._spawnTimer > 0) continue;
      const dx = z.x - this.x, dy = z.y - this.y;
      const half = CELL * 0.55;
      let inBeam = false;
      if (this.direction === 'right' && dx > 0 && dx <= range && Math.abs(dy) < half) inBeam = true;
      if (this.direction === 'left'  && dx < 0 && -dx <= range && Math.abs(dy) < half) inBeam = true;
      if (this.direction === 'down'  && dy > 0 && dy <= range && Math.abs(dx) < half) inBeam = true;
      if (this.direction === 'up'    && dy < 0 && -dy <= range && Math.abs(dx) < half) inBeam = true;
      if (inBeam) { z.takeDamage(this.damage, { type: this.type, col: this.col, row: this.row }); hit++; }
    }
    return hit;
  }

  draw(g) {
    // レーザー：ビーム描画（レンジ円の代わり）
    if (this.type === 'laser') {
      const range = this._laserRange();
      const dirs  = { right:[1,0], left:[-1,0], down:[0,1], up:[0,-1] };
      const d     = this.direction ? dirs[this.direction] : null;
      if (d) {
        const ex = this.x + d[0] * range, ey = this.y + d[1] * range;
        // 常時：細い方向線
        g.lineStyle(1, this.color, 0.25);
        g.lineBetween(this.x, this.y, ex, ey);
        // 発射フラッシュ
        if (this._laserFlash > 0) {
          const alpha = this._laserFlash / 180;
          g.lineStyle(5, 0xffffff, alpha * 0.7);
          g.lineBetween(this.x, this.y, ex, ey);
          g.lineStyle(3, this.color, alpha);
          g.lineBetween(this.x, this.y, ex, ey);
        }
      } else {
        // 方向未設定：点滅して選択を促す
        g.lineStyle(2, this.color, 0.5 + 0.5 * Math.sin(Date.now() * 0.005));
        g.strokeRect(this.x - CELL/2 + 2, this.y - CELL/2 + 2, CELL - 4, CELL - 4);
      }
    } else {
    // レンジ円（通常タワー）
    g.lineStyle(1, this.color, this.selected ? 0.65 : 0.2);
    g.strokeCircle(this.x, this.y, this.range);
    if (this.selected) {
      g.fillStyle(this.color, 0.07);
      g.fillCircle(this.x, this.y, this.range);
    }
    }

    if (this._sprite) {
      // ─── スプライットモード ───────────────────────────
      this._sprite.setPosition(this.x, this.y);
      if (this._spriteBack) this._spriteBack.setPosition(this.x, this.y);
      // バット：2フレーム交互でぐるぐる感を演出
      if (this.type === 'bat') {
        this._sprite.setFrame(Math.floor(Date.now() / 150) % 2);
      }
      // パンチ：方向によってスプライット切り替え・方向未設定時は点滅
      if (this.type === 'punch') {
        const isUp = this.direction === 'up';
        this._sprite.setVisible(!isUp);
        if (this._spriteBack) this._spriteBack.setVisible(isUp);
        if (this.direction) {
          if (isUp) {
            if (this._spriteBack) this._spriteBack.setAlpha(1);
          } else {
            this._sprite.setFlipX(this.direction === 'left');
            this._sprite.setAlpha(1);
          }
        } else {
          const alpha = 0.5 + 0.5 * Math.sin(Date.now() * 0.005);
          this._sprite.setAlpha(alpha);
        }
      }
      if (this.selected) {
        g.lineStyle(2, 0xffffff, 0.8);
        g.strokeRect(this.x - CELL / 2, this.y - CELL / 2, CELL, CELL);
      }
    } else {
      // ─── グレーボックス（色付き四角） ─────────────────
      const s = CELL / 2 - 4;
      g.fillStyle(this.color, 0.9);
      g.fillRect(this.x - s, this.y - s, s * 2, s * 2);
      g.lineStyle(2, this.selected ? 0xffffff : 0xaaaacc, 1);
      g.strokeRect(this.x - s, this.y - s, s * 2, s * 2);

      // 種別アイコン（白い小図形）
      g.fillStyle(0xffffff, 1);
      if (this.type === 'basic') {
        g.fillCircle(this.x, this.y, 5);
      } else if (this.type === 'rapid') {
        g.fillRect(this.x - 8, this.y - 4, 16, 3);
        g.fillRect(this.x - 8, this.y + 1, 16, 3);
      } else {
        g.fillTriangle(this.x, this.y - 7, this.x - 6, this.y + 5, this.x + 6, this.y + 5);
      }
    }
  }

  cleanup() {
    if (this._sprite)     { this._sprite.destroy();     this._sprite     = null; }
    if (this._spriteBack) { this._spriteBack.destroy(); this._spriteBack = null; }
  }
}
