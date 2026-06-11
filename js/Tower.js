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

    const dx   = this.target.x - this.x;
    const dy   = this.target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 10) {
      this.target.takeDamage(this.damage);
      this.active = false;
      return;
    }

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
class Tower {
  constructor(col, row, type) {
    this.col      = col;
    this.row      = row;
    this.type     = type;
    const def     = TOWER_DEFS[type];
    this.range    = def.range * CELL;  // ピクセル換算
    this.fireRate = def.fireRate;
    this.damage   = def.damage;
    this.color    = def.color;
    this.sell     = def.sell;
    this.selected = false;
    const { x, y } = cellCenter(col, row);
    this.x        = x;
    this.y        = y;
    this.lastFire = -99999;
  }

  _findNearest(zombies) {
    let nearest = null, minDist = Infinity;
    for (const z of zombies) {
      if (!z.alive) continue;
      const dx = z.x - this.x, dy = z.y - this.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d <= this.range && d < minDist) { minDist = d; nearest = z; }
    }
    return nearest;
  }

  update(scaledTime, dt, zombies, bullets) {
    if (scaledTime - this.lastFire < this.fireRate) return;
    const target = this._findNearest(zombies);
    if (!target) return;

    this.lastFire = scaledTime;
    bullets.push(new Bullet(this.x, this.y, target, this.damage));
    audioSynth.shoot();
  }

  draw(g) {
    const s = CELL / 2 - 4;

    // レンジ円（淡く常時表示）
    g.lineStyle(1, this.color, this.selected ? 0.6 : 0.18);
    g.strokeCircle(this.x, this.y, this.range);

    // 選択時：レンジを塗りつぶし
    if (this.selected) {
      g.fillStyle(this.color, 0.07);
      g.fillCircle(this.x, this.y, this.range);
    }

    // 本体の四角
    g.fillStyle(this.color, 0.9);
    g.fillRect(this.x - s, this.y - s, s * 2, s * 2);
    g.lineStyle(2, this.selected ? 0xffffff : 0xaaaacc, 1);
    g.strokeRect(this.x - s, this.y - s, s * 2, s * 2);

    // 種別アイコン（白い図形）
    g.fillStyle(0xffffff, 1);
    if (this.type === 'basic') {
      g.fillCircle(this.x, this.y, 5);
    } else if (this.type === 'rapid') {
      g.fillRect(this.x - 8, this.y - 4, 16, 3);
      g.fillRect(this.x - 8, this.y + 1, 16, 3);
    } else {  // sniper
      g.fillTriangle(this.x, this.y - 7, this.x - 6, this.y + 5, this.x + 6, this.y + 5);
    }
  }
}
