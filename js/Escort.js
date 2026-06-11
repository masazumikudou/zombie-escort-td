// 護衛対象（グレーボックス：青い円）
// ASSET SWAP POINT: draw() をスプライト描画に差し替え可能
class Escort {
  constructor(pixelPath, def) {
    this.path    = pixelPath; // [{x, y, col, row}, ...]（A*で計算済み）
    this.wpIdx   = 0;
    this.x       = pixelPath[0]?.x ?? 0;
    this.y       = pixelPath[0]?.y ?? 0;
    this.hp      = def.hp;
    this.maxHp   = def.hp;
    this.speed   = def.speed;
    this.alive   = true;
    this.reached = false;
    this.lastDx  = 1;
    this.lastDy  = 0;
    this.hitFlash = 0;  // ヒット時フラッシュタイマー（ms）
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(dt) {
    if (!this.alive || this.reached) return;
    if (this.hitFlash > 0) this.hitFlash -= dt;

    if (this.wpIdx >= this.path.length) { this.reached = true; return; }

    const wp   = this.path[this.wpIdx];
    const dx   = wp.x - this.x;
    const dy   = wp.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this.speed * dt / 1000;

    if (dist <= step) {
      this.x = wp.x;
      this.y = wp.y;
      this.wpIdx++;
      if (this.wpIdx >= this.path.length) this.reached = true;
    } else {
      this.lastDx = dx;
      this.lastDy = dy;
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

  // g: Phaser.Graphics（dynamicGfxに描画）
  draw(g) {
    if (!this.alive || this.reached) return;

    const r         = 22;
    const isFlash   = this.hitFlash > 0;
    const bodyColor = isFlash ? 0xff6666 : 0x4488ff;
    const rimColor  = isFlash ? 0xff0000 : 0x2244cc;

    // 本体
    g.fillStyle(bodyColor, 1);
    g.fillCircle(this.x, this.y, r);
    g.lineStyle(2.5, rimColor, 1);
    g.strokeCircle(this.x, this.y, r);

    // 向き表示（白い小円）
    const norm  = Math.sqrt(this.lastDx ** 2 + this.lastDy ** 2) || 1;
    const fx    = this.x + (this.lastDx / norm) * r * 0.5;
    const fy    = this.y + (this.lastDy / norm) * r * 0.5;
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(fx, fy, 5);

    // HPバー
    const barW  = 44, barH = 5;
    const ratio = this.hp / this.maxHp;
    const barC  = ratio > 0.5 ? 0x00ee00 : ratio > 0.25 ? 0xffaa00 : 0xff2222;
    g.fillStyle(0x111122, 1);
    g.fillRect(this.x - barW / 2, this.y - r - 11, barW, barH);
    g.fillStyle(barC, 1);
    g.fillRect(this.x - barW / 2, this.y - r - 11, barW * ratio, barH);
  }
}
