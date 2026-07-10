// ─── バリアント別スプライト設定 ────────────────────────────────
// foot が this.y + ESCORT_GROUND_OFFSET に揃うよう posY を自動計算する
const ESCORT_GROUND_OFFSET = 40;

const ESCORT_SPR = {
  dad: {
    base:       { frameH: 256, scale: 156 / 256, ox: 0.5,   oy: 0.75  },
    flipRight:  true,
  },
  mom: {
    right:      { frameH: 689, scale: 164 / 689, ox: 0.478, oy: 0.958 },
    down:       { frameH: 780, scale: 180 / 780, ox: 0.5,   oy: 1.0   },
    up:         { frameH: 600, scale: 164 / 600, ox: 0.574, oy: 1.0   },
    flipRight:  false,
  },
  // ★ son/grandma/cat はアセット入手後にframeH・scale・ox・oyを実測値に更新すること
  son: {
    base:       { frameH: 256, scale: 156 / 256, ox: 0.5,   oy: 0.75  },
    flipRight:  true,
  },
  grandma: {
    base:       { frameH: 256, scale: 156 / 256, ox: 0.5,   oy: 0.75  },
    flipRight:  true,
  },
  cat: {
    base:       { frameH: 256, scale: 156 / 256, ox: 0.5,   oy: 0.75  },
    flipRight:  true,
  },
};

function _escortSprCfg(variant, sprDir) {
  const v = ESCORT_SPR[variant] ?? ESCORT_SPR.dad;
  return v[sprDir] ?? v.base ?? ESCORT_SPR.dad.base;
}

function _escortFlipX(variant, sprDir, dir) {
  if (sprDir !== 'right') return false;
  const flipRight = (ESCORT_SPR[variant] ?? ESCORT_SPR.dad).flipRight ?? true;
  return flipRight ? dir !== 'left' : dir === 'left';
}

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

    // 寄り道(Y)システム
    this.state            = 'walking';  // 'walking'|'detouring'|'waiting'|'returning'|'exiting'
    this._exitDx          = 0;
    this._exitDy          = 0;
    this._detourDef       = def.detour ?? null;
    this._detourDone      = false;
    this._detourWpIdx     = 0;
    this._waitTimer       = 0;
    this._detourPixelPath = null;
    this.onDetourStart    = null;  // Y到達時コールバック（カード表示用）
    this.onDetourActivate = null;  // 2秒後Y発動コールバック（スポーン加速用）
    this.onDetourEnd      = null;  // Y出発時コールバック（GameScene用）
    this._announceTimer   = 0;
    this._waitText        = null;
    // 時刻ベース位置計算
    this._walkOriginTime  = this.scene?.scaledTime ?? 0;
    this._pauseStart      = null;  // detour一時停止開始時刻（_finishDetourで補正に使用）
    if (this._detourDef?.path?.length > 0) {
      this._detourPixelPath = this._detourDef.path.map(p => cellCenter(p.col, p.row));
    }
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

    // Yアナウンス中（2秒停止・カード表示）
    if (this.state === 'announcing') {
      this._announceTimer += dt;
      if (this._announceTimer >= 2000) {
        this.state = 'waiting';
        this._waitTimer = 0;
        if (this.onDetourActivate) this.onDetourActivate();
      }
      return;
    }

    // Y待機中：移動しない（カウントダウンのみ）
    if (this.state === 'waiting') {
      this._waitTimer += dt;
      if (this._waitTimer >= (this._detourDef.waitTime ?? 30000)) {
        this.state = 'returning';
        this._detourWpIdx = this._detourPixelPath.length - 2;
        if (this._detourWpIdx < 0) this._finishDetour();
      }
      return;
    }

    // 歩行アニメ
    this._animTime  += dt;
    this._animFrame  = Math.floor(this._animTime / (1000 / escortFps(this.variant))) % escortFrameCount(this.variant) + 1;

    if (this.state === 'walking') {
      const now       = this.scene?.scaledTime ?? 0;
      const traveled  = Math.max(0, this.speed * (now - this._walkOriginTime) / 1000);
      const pos       = this._posOnPath(traveled);
      const prevWpIdx = this.wpIdx;

      const ddx = pos.x - this.x, ddy = pos.y - this.y;
      if (Math.abs(ddx) + Math.abs(ddy) > 0) { this.lastDx = ddx; this.lastDy = ddy; }
      this.x     = pos.x;
      this.y     = pos.y;
      this.wpIdx = pos.wpIdx;

      // Y分岐チェック（branchIdx通過時にdetour開始）
      if (!this._detourDone && this._detourPixelPath &&
          prevWpIdx < this._detourDef.branchIdx &&
          this.wpIdx >= this._detourDef.branchIdx) {
        this.x = this.path[this._detourDef.branchIdx].x;
        this.y = this.path[this._detourDef.branchIdx].y;
        this._enterDetour();
        return;
      }

      if (pos.done) { this._enterExit(); }

    } else if (this.state === 'detouring') {
      const wp   = this._detourPixelPath[this._detourWpIdx];
      const dx   = wp.x - this.x, dy = wp.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = this.speed * dt / 1000;

      if (dist <= step) {
        this.x = wp.x; this.y = wp.y;
        this._detourWpIdx++;
        if (this._detourWpIdx >= this._detourPixelPath.length) {
          // Y到達 → アナウンス（2秒後に待機開始）
          this.state = 'announcing';
          this._announceTimer = 0;
          if (this.onDetourStart) this.onDetourStart();
        }
      } else {
        this.lastDx = dx; this.lastDy = dy;
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }

    } else if (this.state === 'exiting') {
      this.x += this._exitDx * this.speed * dt / 1000;
      this.y += this._exitDy * this.speed * dt / 1000;
      this.lastDx = this._exitDx; this.lastDy = this._exitDy;
      if (this.x < -CELL || this.x > MAP_W + CELL || this.y < -CELL || this.y > MAP_H + CELL) {
        this.reached = true;
      }

    } else if (this.state === 'returning') {
      const wp   = this._detourPixelPath[this._detourWpIdx];
      const dx   = wp.x - this.x, dy = wp.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = this.speed * dt / 1000;

      if (dist <= step) {
        this.x = wp.x; this.y = wp.y;
        this._detourWpIdx--;
        if (this._detourWpIdx < 0) this._finishDetour();
      } else {
        this.lastDx = dx; this.lastDy = dy;
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
    }
  }

  // C5到達 → detour開始
  _enterDetour() {
    this._pauseStart = this.scene?.scaledTime ?? 0;
    this.state = 'detouring';
    this._detourWpIdx = 1;  // detourPath[0]=C5には既にいる
    if (this._detourWpIdx >= this._detourPixelPath.length) {
      // Y=C5の縮退ケース
      this.state = 'waiting';
      this._waitTimer = 0;
      if (this.onDetourStart) this.onDetourStart();
    }
  }

  // G到達 → 最寄りのMAP端へ向かって退場
  _enterExit() {
    const cx = this.x, cy = this.y;
    const dL = cx, dR = MAP_W - cx, dU = cy, dD = MAP_H - cy;
    const min = Math.min(dL, dR, dU, dD);
    if      (min === dL) { this._exitDx = -1; this._exitDy =  0; }
    else if (min === dR) { this._exitDx =  1; this._exitDy =  0; }
    else if (min === dU) { this._exitDx =  0; this._exitDy = -1; }
    else                 { this._exitDx =  0; this._exitDy =  1; }
    this.state = 'exiting';
  }

  // Y滞在終了 → C5に戻りメイン導線再開
  _finishDetour() {
    if (this._waitText) { this._waitText.destroy(); this._waitText = null; }
    this._detourDone = true;
    // detour/wait/returning 中に経過した時間を _walkOriginTime へ加算（時刻ベース計算の補正）
    if (this._pauseStart !== null) {
      this._walkOriginTime += (this.scene?.scaledTime ?? 0) - this._pauseStart;
      this._pauseStart = null;
    }
    this.state = 'walking';
    this.wpIdx = this._detourDef.branchIdx + 1;
    if (this.onDetourEnd) this.onDetourEnd();
  }

  // path上の累積距離 dist に対応する座標と wpIdx を返す
  _posOnPath(dist) {
    let remain = dist;
    for (let i = 1; i < this.path.length; i++) {
      const dx     = this.path[i].x - this.path[i - 1].x;
      const dy     = this.path[i].y - this.path[i - 1].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (remain < segLen) {
        const f = segLen > 0 ? remain / segLen : 0;
        return { x: this.path[i - 1].x + dx * f, y: this.path[i - 1].y + dy * f, wpIdx: i - 1, done: false };
      }
      remain -= segLen;
      if (remain <= 0) {
        return { x: this.path[i].x, y: this.path[i].y, wpIdx: i, done: i >= this.path.length - 1 };
      }
    }
    const last = this.path[this.path.length - 1];
    return { x: last.x, y: last.y, wpIdx: this.path.length - 1, done: true };
  }

  takeDamage(amount) {
    if (!this.alive || this.defeated) return;
    const prevHp = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    this.hitFlash = 200;
    audioSynth.escortHit();
    if (this.scene?._playLog) this.scene._playLog.push(`[HIT]    t=${Math.round(this.scene.scaledTime)}ms  護衛被弾  damage=${amount}  護衛HP: ${prevHp}→${this.hp}`);
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

    // Y待機中タイマーテキスト
    if (this.state === 'waiting' && this._detourDef) {
      const waitTime  = this._detourDef.waitTime ?? 30000;
      const remaining = Math.max(0, Math.ceil((waitTime - this._waitTimer) / 1000));
      const ratio     = (waitTime - this._waitTimer) / waitTime;
      const color     = ratio > 0.5 ? '#00ff88' : ratio > 0.25 ? '#ffaa00' : '#ff4444';
      if (!this._waitText) {
        this._waitText = this.scene.add.text(0, 0, '', {
          fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '20px', fontStyle: 'bold',
          stroke: '#000000', strokeThickness: 3,
        }).setDepth(5).setOrigin(0.5, 1);
      }
      this._waitText.setText(`⏱ ${remaining}`).setPosition(this.x, this.y - 52).setStyle({ color });
    } else if (this._waitText) {
      this._waitText.destroy();
      this._waitText = null;
    }

    // 待機中はidleアニメ（正面固定）
    const idleKey = `${this.variant}_idle`;
    const isWaiting = this.state === 'waiting';
    if (isWaiting && this.scene.textures.exists(idleKey)) {
      if (!this._sprite || this._spriteKey !== idleKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.sprite(this.x, this.y, idleKey).setDepth(3);
        this._spriteKey = idleKey;
        if (this.scene.anims.exists(idleKey)) this._sprite.play(idleKey);
      }
      const idleCfg  = _escortSprCfg(this.variant, 'idle');
      const idlePosY = (this.y + ESCORT_GROUND_OFFSET) - (1 - idleCfg.oy) * idleCfg.frameH * idleCfg.scale;
      this._sprite.setScale(idleCfg.scale);
      this._sprite.setOrigin(idleCfg.ox, idleCfg.oy);
      this._sprite.setPosition(this.x, idlePosY).setVisible(true);
      this._sprite.setFlipX(false);
      this._sprite.setTint(this.hitFlash > 0 ? 0xff8888 : 0xffffff);
      // HPバーへ続く
    } else {

    // 方向別シートキー
    let sheetKey, animKey, sprDir;
    if (dir === 'down' && this.scene.textures.exists(`${this.variant}_down`)) {
      sheetKey = `${this.variant}_down`;
      animKey  = `${this.variant}_walk_down`;
      sprDir   = 'down';
    } else if (dir === 'up' && this.scene.textures.exists(`${this.variant}_up`)) {
      sheetKey = `${this.variant}_up`;
      animKey  = `${this.variant}_walk_up`;
      sprDir   = 'up';
    } else {
      sheetKey = `${this.variant}_right`;
      animKey  = `${this.variant}_walk_right`;
      sprDir   = 'right';
    }

    if (this.scene.textures.exists(sheetKey)) {
      // ─── スプライットシートモード ────────────────────
      if (!this._sprite || this._spriteKey !== sheetKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.sprite(this.x, this.y, sheetKey).setDepth(3);
        this._spriteKey = sheetKey;
        if (this.scene.anims.exists(animKey)) this._sprite.play(animKey);
      }
      const cfg  = _escortSprCfg(this.variant, sprDir);
      const posY = (this.y + ESCORT_GROUND_OFFSET) - (1 - cfg.oy) * cfg.frameH * cfg.scale;
      this._sprite.setScale(cfg.scale);
      this._sprite.setOrigin(cfg.ox, cfg.oy);
      this._sprite.setPosition(this.x, posY).setVisible(true);
      this._sprite.setFlipX(_escortFlipX(this.variant, sprDir, dir));
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
    } // end idle/walk branch

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
    if (this._sprite)   { this._sprite.destroy();   this._sprite   = null; }
    if (this._waitText) { this._waitText.destroy();  this._waitText = null; }
  }
}
