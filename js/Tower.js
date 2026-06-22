// ─── 弾丸 ────────────────────────────────────────────────────
class Bullet {
  constructor(x, y, target, damage, speed = 500) {
    this.x      = x;
    this.y      = y;
    this.target = target;
    this.damage = damage;
    this.speed  = speed;
    this.active = true;
  }

  update(dt) {
    if (!this.active) return;
    if (!this.target.alive) { this.active = false; return; }
    const dx = this.target.x - this.x, dy = this.target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 10) { this.target.takeDamage(this.damage); this.active = false; return; }
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
    const key = `tower_${this.type}`;
    if (!this.scene.textures.exists(key)) return;
    this._sprite = this.scene.add.image(this.x, this.y, key).setDepth(2);
  }

  _findNearest(zombies) {
    const range2 = this.range * this.range;
    let nearest = null, minDist2 = Infinity;
    for (const z of zombies) {
      if (!z.alive) continue;
      const dx = z.x - this.x, dy = z.y - this.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= range2 && d2 < minDist2) { minDist2 = d2; nearest = z; }
    }
    return nearest;
  }

  update(scaledTime, dt, zombies, bullets) {
    this._laserFlash = Math.max(0, this._laserFlash - dt);
    if (scaledTime - this.lastFire < this.fireRate) return;

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
      const target = this._findNearest(zombies);
      if (!target) return;
      this.lastFire = scaledTime;
      bullets.push(new Bullet(this.x, this.y, target, this.damage));
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
      if (!z.alive) continue;
      const dx = z.x - this.x, dy = z.y - this.y;
      const half = CELL * 0.55;
      let inBeam = false;
      if (this.direction === 'right' && dx > 0 && dx <= range && Math.abs(dy) < half) inBeam = true;
      if (this.direction === 'left'  && dx < 0 && -dx <= range && Math.abs(dy) < half) inBeam = true;
      if (this.direction === 'down'  && dy > 0 && dy <= range && Math.abs(dx) < half) inBeam = true;
      if (this.direction === 'up'    && dy < 0 && -dy <= range && Math.abs(dx) < half) inBeam = true;
      if (inBeam) { z.takeDamage(this.damage); hit++; }
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
    if (this._sprite) { this._sprite.destroy(); this._sprite = null; }
  }
}
