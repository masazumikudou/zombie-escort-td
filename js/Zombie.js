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
    this._spawnX       = x;  // 時刻ベースleash計算の原点
    this._spawnY       = y;
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
    this._dustEmitter  = null;
    this._speedLines   = [];
    this._lineTimer    = 0;
    this._lastDrawT    = 0;
    this._spawnTimer   = 2000;  // スポーン後2秒は移動・攻撃しない（タワー被弾は有効）
    // トレイル（リーダーのみ記録、フォロワーはリーダーのcellTrailを参照）
    this.cellTrail     = (leader === null) ? [cellCenter(spawnCol, spawnRow)] : null;
    this._lastTrailCol = spawnCol;
    this._lastTrailRow = spawnRow;
    this._trailIdx     = 0;
    this.leashTarget      = def.leashTo ?? null;  // {col,row} 到達後護衛まで待機
    this._leashWaiting    = false;
    this._leashWaitMs     = 0;
    this._leashMoveStart  = null;  // spawnTimer満了後の移動開始scaledTime（時刻ベース計算用）
    // 隊列（フォーメーション）
    this._formation  = null;   // FormationGroup 参照（null = 非隊列 or 解除済み）
    this._fmIdx      = 0;      // 隊列内インデックス（0 = 先頭）
    this._fmReleased = false;  // FormationGroup による解除済みフラグ
    this._logId      = (Zombie._seq = (Zombie._seq ?? 0) + 1);
  }

  get col() { return Math.floor(this.x / CELL); }
  get row() { return Math.floor(this.y / CELL); }

  _log(msg) {
    if (Array.isArray(this.scene?._playLog)) this.scene._playLog.push(msg);
    else console.log(msg);
  }

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
          const _r = distToEscort < CELL * 1.5 ? 'escort_near' : 'timeout';
          this._log(`[LEASH_RELEASE] t=${Math.round(scaledTime)}ms id=${this._logId} at=(${this.col},${this.row}) waitMs=${Math.round(this._leashWaitMs)} dist=${Math.round(distToEscort)} reason=${_r}`);
          this.leashTarget   = null;
          this._leashWaiting = false;
          // leash後はリーダートレイルをスキップしてFlowFieldへ直接移行
          if (this.leader !== null && this.leader.cellTrail) {
            this._trailIdx = this.leader.cellTrail.length;
          }
        }
        return;
      }
      // 時刻ベース直線移動（スポーン位置→leashTarget）
      if (this._leashMoveStart === null) this._leashMoveStart = scaledTime;
      const tgt  = cellCenter(this.leashTarget.col, this.leashTarget.row);
      const ldx  = tgt.x - this._spawnX, ldy = tgt.y - this._spawnY;
      const lLen = Math.sqrt(ldx * ldx + ldy * ldy);
      if (lLen > 0) {
        const traveled = Math.min(
          Math.max(0, this.speed * (scaledTime - this._leashMoveStart) / 1000), lLen
        );
        this.x = this._spawnX + (ldx / lLen) * traveled;
        this.y = this._spawnY + (ldy / lLen) * traveled;
        this.lastDx = ldx; this.lastDy = ldy;
        if (traveled >= lLen) {
          this._leashWaiting = true;
          this._leashWaitMs  = 0;
          this._log(`[LEASH_ARRIVE] t=${Math.round(scaledTime)}ms id=${this._logId} at=(${this.leashTarget.col},${this.leashTarget.row})`);
        }
      } else if (!this._leashWaiting) {
        this._leashWaiting = true;
        this._leashWaitMs  = 0;
      }
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
    this._log(`[HIT] t=${Math.round(this.scene?.scaledTime ?? 0)}ms id=${this._logId} hp=${Math.max(0, this.hp)}/${this.maxHp} dmg=${amount}`);
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

    if (this.skin === 'kickboard' && this.scene.textures.exists('kickboard')) {
      // ─── キックボード（3方向PNG + バウンス + 土埃） ────────
      const footY   = this.y + 54;
      const nowT    = this.scene.scaledTime ?? this._animTime;
      const bounceY = Math.sin(nowT * 0.005) * 1.0;
      const moveDir = this.lastDx >= 0 ? 1 : -1;

      // 方向別スプライト選択
      let kbKey, kbNatH, kbFlipX = false;
      if (dir === 'up') {
        kbKey = 'kickboard_up';   kbNatH = 1240;
      } else if (dir === 'down') {
        kbKey = 'kickboard_down'; kbNatH = 1180;
      } else {
        kbKey = 'kickboard';      kbNatH = 1220; kbFlipX = (moveDir < 0);
      }
      const scale = 156 / kbNatH;

      // スプライト生成（方向変化時に再生成）
      if (!this._sprite || this._spriteKey !== kbKey) {
        if (this._sprite) this._sprite.destroy();
        this._sprite    = this.scene.add.image(this.x, footY, kbKey).setDepth(3);
        this._spriteKey = kbKey;
      }
      this._sprite.setScale(scale);
      this._sprite.setOrigin(0.5, 1.0);
      this._sprite.setPosition(this.x, footY + bounceY).setVisible(true);
      this._sprite.setFlipX(kbFlipX);
      this._sprite.setTint(this.hitFlash > 0 ? 0xff8888 : 0xffffff);

      // 土埃エミッター（左右移動時のみ / 方向転換時に再生成）
      if (dir !== 'up' && dir !== 'down') {
        if (!this.scene.textures.exists('_kb_dust')) {
          const dg = this.scene.add.graphics();
          dg.fillStyle(0xccbbaa, 1);
          dg.fillCircle(4, 4, 4);
          dg.generateTexture('_kb_dust', 8, 8);
          dg.destroy();
        }
        if (this._dustEmitter && this._dustDir !== moveDir) {
          this._dustEmitter.destroy();
          this._dustEmitter = null;
        }
        this._dustDir = moveDir;
        const tireX = this.x - moveDir * (this._sprite.displayWidth * 0.42);
        if (!this._dustEmitter) {
          this._dustEmitter = this.scene.add.particles(tireX, footY, '_kb_dust', {
            speed:    { min: 15, max: 45 },
            angle:    moveDir > 0 ? { min: 150, max: 210 } : { min: -30, max: 30 },
            scale:    { start: 1.58, end: 0 },
            alpha:    { start: 0.55, end: 0 },
            lifespan: 420,
            frequency: 80,
            quantity:  1,
          }).setDepth(2);
        }
        this._dustEmitter.setPosition(tireX, footY);
      } else if (this._dustEmitter) {
        this._dustEmitter.destroy();
        this._dustEmitter = null;
      }

    } else if (this.scene.textures.exists('salaryman_right')) {
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
    if (this._sprite)       { this._sprite.destroy();       this._sprite       = null; }
    if (this._dustEmitter)  { this._dustEmitter.destroy();  this._dustEmitter  = null; }
  }
}
