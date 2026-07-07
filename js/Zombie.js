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
    this.skin          = def.skin ?? 'salaryman';
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
    this._spawnTimer   = 2000;  // スポーン後2秒は移動・攻撃しない（タワー被弾は有効）
    // トレイル（リーダーのみ記録、フォロワーはリーダーのcellTrailを参照）
    this.cellTrail     = (leader === null) ? [cellCenter(spawnCol, spawnRow)] : null;
    this._lastTrailCol = spawnCol;
    this._lastTrailRow = spawnRow;
    this._trailIdx     = 0;
    this.leashTarget   = def.leashTo ?? null;  // {col,row} 到達後護衛まで待機
    this._leashWaiting = false;
    this._leashWaitMs  = 0;
    // 隊列（フォーメーション）
    this._formation  = null;   // FormationGroup 参照（null = 非隊列 or 解除済み）
    this._fmIdx      = 0;      // 隊列内インデックス（0 = 先頭）
    this._fmReleased = false;  // FormationGroup による解除済みフラグ
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  update(scaledTime, dt, escort) {
    if (!this.alive) return;
    if (this._spawnTimer > 0) { this._spawnTimer -= dt; return; }
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

    if (this.leader !== null && !this.leader.alive) {
      this.leader = null;
      if (this.cellTrail === null) this.cellTrail = [];  // フォロワー→リーダー昇格時に初期化
    }

    // ─── 隊列フォロワー（先頭以外・未解除）────────────────────────────────
    if (this._formation && this._fmIdx > 0) {
      const prev = this._formation.members[this._fmIdx - 1];
      if (!prev || !prev.alive) return;  // 前が死亡 → 次tickで繰り上がり反映

      if (this._leashWaiting) {
        // 整列着座中: アニメ停止して待機
        this._animTime = 0; this._animFrame = 1;
        return;
      }

      const moved = FormationGroup.followerMove(this, prev, dt);
      if (!moved && prev._leashWaiting) {
        // pitch以内かつ前も着座 → 自分も整列着座
        this._leashWaiting = true;
        this._leashWaitMs  = 0;
      }
      return;
    }
    // ───────────────────────────────────────────────────────────────────────

    // ─── leashTo: 指定座標へ向かい、護衛が近接するまで待機 ──────────────
    if (this.leashTarget) {
      // リーダーのみ移動トレイルを記録（leash中も継続）
      if (this.leader === null) {
        if (this.col !== this._lastTrailCol || this.row !== this._lastTrailRow) {
          this._lastTrailCol = this.col;
          this._lastTrailRow = this.row;
          this.cellTrail.push(cellCenter(this.col, this.row));
        }
      }
      if (this._leashWaiting) {
        // 待機中：アニメ停止
        this._animTime = 0; this._animFrame = 1;
        this._leashWaitMs += dt;
        // 隊列先頭は FormationGroup.tick() が解除を管理（タイムアウトのみ個別処理）
        if (this._formation) {
          if (this._leashWaitMs > 15000) {
            this.leashTarget   = null;
            this._leashWaiting = false;
            this._formation    = null;
          }
          return;
        }
        // 非隊列: 護衛 CELL*1.5 以内 or タイムアウトで解除
        if (distToEscort < CELL * 1.5 || this._leashWaitMs > 15000) {
          this.leashTarget   = null;
          this._leashWaiting = false;
          // leash後はリーダートレイルをスキップしてFlowFieldへ直接移行
          if (this.leader !== null && this.leader.cellTrail) {
            this._trailIdx = this.leader.cellTrail.length;
          }
        }
        return;
      }
      // leashTo セルに到達したか判定
      if (this.col === this.leashTarget.col && this.row === this.leashTarget.row) {
        this._leashWaiting = true;
        this._leashWaitMs  = 0;
        return;
      }
      // leashTo へ直線ウェイポイントで移動（設計側が障害物なしを保証）
      if (this.wpIdx >= this.path.length) {
        this.path  = [cellCenter(this.leashTarget.col, this.leashTarget.row)];
        this.wpIdx = 0;
      }
      this._advancePath(dt);
      return;
    }
    // ───────────────────────────────────────────────────────────────────

    if (this.leader !== null) {
      // フォロワー：リーダーの実際に歩いたトレイルを追う
      if (this.wpIdx >= this.path.length) {
        const trail = this.leader.cellTrail;
        if (trail && this._trailIdx < trail.length) {
          this.path  = [trail[this._trailIdx++]];
          this.wpIdx = 0;
        } else {
          // トレイルが追いついていない場合はFlowFieldでフォールバック
          const ff = this.scene.flowField;
          const next = ff.getNextCell(this.col, this.row);
          if (next) { this.path = [cellCenter(next.col, next.row)]; this.wpIdx = 0; }
        }
      }
    } else {
      // リーダー：FlowFieldで経路取得 + 通過セルをトレイルに記録
      if (this.col !== this._lastTrailCol || this.row !== this._lastTrailRow) {
        this._lastTrailCol = this.col;
        this._lastTrailRow = this.row;
        this.cellTrail.push(cellCenter(this.col, this.row));
      }
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

  takeDamage(amount, source = null) {
    if (!this.alive) return false;
    if (source) this._lastHitBy = source;
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

    const skinKey = (this.skin === 'police' && this.scene.textures.exists('police_right')) ? 'police'
      : (this.skin === 'worker' && this.scene.textures.exists('worker_right')) ? 'worker'
      : 'salaryman';

    if (this.scene.textures.exists('salaryman_right')) {
      // ─── スプライトシートモード ───────────────────────────
      let sheetKey, animKey;
      if (dir === 'down' && this.scene.textures.exists(`${skinKey}_down`)) {
        sheetKey = `${skinKey}_down`; animKey = `${skinKey}_walk_down`;
      } else if (dir === 'up' && this.scene.textures.exists(`${skinKey}_up`)) {
        sheetKey = `${skinKey}_up`;   animKey = `${skinKey}_walk_up`;
      } else {
        sheetKey = `${skinKey}_right`; animKey = `${skinKey}_walk_right`;
      }

      if (!this._sprite || !this._sprite.anims || this._spriteKey !== sheetKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.sprite(this.x, this.y, sheetKey).setDepth(3);
        this._spriteKey = sheetKey;
        if (this.scene.anims.exists(animKey)) this._sprite.play(animKey);
      }
      const scl = 156 / 256;
      this._sprite.setScale(scl);
      this._sprite.setOrigin(0.5, 0.75);
      this._sprite.setPosition(this.x, this.y + 15).setVisible(true);
      this._sprite.setFlipX(dir === 'left');
      this._sprite.setAlpha(1);
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
