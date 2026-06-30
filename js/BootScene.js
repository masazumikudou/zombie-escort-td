// BootScene: ステージJSON + スプライト/音声を試し読み込み
// ファイルが存在しなくてもエラーにならず、ゲームは単色図形で動く
class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  init(data) {
    this.stageFile = data.stageFile || 'stages/stage_01.json';
  }

  preload() {
    // 404エラーをコンソールに出さない（未配置は正常状態）
    this.load.on('loaderror', () => {});

    this.load.json('stageData', this.stageFile);
    this.load.json('balance', 'balance.json');
    this._tryLoadSprites();
    this._tryLoadAudio();

    // ローディング表示
    const w = this.cameras.main.width, h = this.cameras.main.height;
    this.add.text(w / 2, h / 2, 'Loading...', {
      fontSize: '22px', color: '#aaaaaa', fontFamily: 'Arial'
    }).setOrigin(0.5);
  }

  create() {
    const stageData = this.cache.json.get('stageData');
    applyBalance(this.cache.json.get('balance'));

    if (this.textures.exists('salaryman_right')) {
      this.anims.create({
        key: 'salaryman_walk_right',
        frames: this.anims.generateFrameNumbers('salaryman_right', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('salaryman_down')) {
      this.anims.create({
        key: 'salaryman_walk_down',
        frames: this.anims.generateFrameNumbers('salaryman_down', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('salaryman_up')) {
      this.anims.create({
        key: 'salaryman_walk_up',
        frames: this.anims.generateFrameNumbers('salaryman_up', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 4,
        repeat: -1,
      });
    }

    if (this.textures.exists('worker_right')) {
      this.anims.create({
        key: 'worker_walk_right',
        frames: this.anims.generateFrameNumbers('worker_right', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('worker_down')) {
      this.anims.create({
        key: 'worker_walk_down',
        frames: this.anims.generateFrameNumbers('worker_down', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('worker_up')) {
      this.anims.create({
        key: 'worker_walk_up',
        frames: this.anims.generateFrameNumbers('worker_up', { frames: [0, 1, 2, 1, 0, 1] }),
        frameRate: 4,
        repeat: -1,
      });
    }

    if (this.textures.exists('police_right')) {
      this.anims.create({
        key: 'police_walk_right',
        frames: this.anims.generateFrameNumbers('police_right', { frames: [0,1,2,3,4,5] }),
        frameRate: 6,
        repeat: -1,
      });
    }
    if (this.textures.exists('police_down')) {
      this.anims.create({
        key: 'police_walk_down',
        frames: this.anims.generateFrameNumbers('police_down', { frames: [0,1,2,3,4,5] }),
        frameRate: 6,
        repeat: -1,
      });
    }
    if (this.textures.exists('police_up')) {
      this.anims.create({
        key: 'police_walk_up',
        frames: this.anims.generateFrameNumbers('police_up', { frames: [0,1,2,3,4,5] }),
        frameRate: 6,
        repeat: -1,
      });
    }

    // DAD 護衛キャラ
    if (this.textures.exists('dad_idle')) {
      this.anims.create({
        key: 'dad_idle',
        frames: this.anims.generateFrameNumbers('dad_idle', { frames: [0, 1, 2, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('dad_right')) {
      this.anims.create({
        key: 'dad_walk_right',
        frames: this.anims.generateFrameNumbers('dad_right', { frames: [0, 1, 2, 1] }),
        frameRate: 2,
        repeat: -1,
      });
    }
    if (this.textures.exists('dad_down')) {
      this.anims.create({
        key: 'dad_walk_down',
        frames: this.anims.generateFrameNumbers('dad_down', { frames: [0, 1, 2, 3] }),
        frameRate: 4,
        repeat: -1,
      });
    }
    if (this.textures.exists('dad_up')) {
      this.anims.create({
        key: 'dad_walk_up',
        frames: this.anims.generateFrameNumbers('dad_up', { frames: [0, 1, 2, 3] }),
        frameRate: 4,
        repeat: -1,
      });
    }

    // MOM 護衛キャラ
    if (this.textures.exists('mom_right')) {
      this.anims.create({
        key: 'mom_walk_right',
        frames: this.anims.generateFrameNumbers('mom_right', { frames: [3, 2, 4, 2] }),
        frameRate: 3, repeat: -1,
      });
    }
    if (this.textures.exists('mom_down')) {
      this.anims.create({
        key: 'mom_walk_down',
        frames: this.anims.generateFrameNumbers('mom_down', { frames: [3, 2, 1, 2] }),
        frameRate: 3, repeat: -1,
      });
    }
    if (this.textures.exists('mom_up')) {
      this.anims.create({
        key: 'mom_walk_up',
        frames: this.anims.generateFrameNumbers('mom_up', { frames: [0, 2, 3, 2] }),
        frameRate: 3, repeat: -1,
      });
    }

    this.scene.start('GameScene', { stageData });
  }

  // ─── スプライット試し読み込み ─────────────────────────────
  _tryLoadSprites() {
    // ゾンビ（6種 × 3方向 × バリアント別フレーム数、left は right 反転で対応）
    ZOMBIE_TYPES.forEach(type => {
      SPRITE_DIRS.forEach(dir => {
        for (let f = 1; f <= zombieFrameCount(type); f++) {
          const key  = zombieTexKey(type, dir, f);
          const path = `assets/sprites/zombie/${type}/walk_${dir}_${_pad(f)}.png`;
          this.load.image(key, path);
        }
      });
    });

    // 護衛（3バリアント × 3方向 × バリアント別フレーム数、left は right 反転で対応）
    ESCORT_VARIANTS.forEach(variant => {
      SPRITE_DIRS.forEach(dir => {
        for (let f = 1; f <= escortFrameCount(variant); f++) {
          const key  = escortTexKey(variant, dir, f);
          const path = `assets/sprites/escort/${variant}/walk_${dir}_${_pad(f)}.png`;
          this.load.image(key, path);
        }
      });
    });

    // タワー（各1枚）
    ['basic', 'rapid', 'sniper'].forEach(type => {
      this.load.image(`tower_${type}`, `assets/sprites/tower/${type}.png`);
    });
    // サッカーボール（大砲弾・2フレーム）
    this.load.spritesheet('soccer_ball', 'assets/sprites/tower/soccer_ball.png', {
      frameWidth: 1000, frameHeight: 1000,
    });
    // バット（2フレームアニメ）タワー
    this.load.spritesheet('tower_bat', 'assets/sprites/tower/bat.png', {
      frameWidth: 1120, frameHeight: 1157,
    });
    // パンチタワー（2フレームスプライトシート）
    this.load.spritesheet('tower_punch', 'assets/sprites/tower/boxing.png', {
      frameWidth: 1128, frameHeight: 485,
    });
    // パンチタワー（上方向・背面）
    this.load.spritesheet('tower_punch_back', 'assets/sprites/tower/boxing_back.png', {
      frameWidth: 402, frameHeight: 858,
    });

    // 遮蔽物
    this.load.image('obstacle_building', 'assets/sprites/obstacle/building.png');

    // プロップ
    Object.keys(PROP_DEFS).forEach(type => {
      this.load.image(`prop_${type}`, `assets/sprites/prop/${type}.png`);
    });

    // デカール（地面装飾、当たり判定なし）
    Object.keys(DECAL_DEFS).forEach(type => {
      this.load.image(`decal_${type}`, `assets/sprites/decal/${type}.png`);
    });

    // DAD 護衛キャラ
    this.load.spritesheet('dad_idle', 'assets/sprites/zombie/DAD/dad_idle_sheet.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('dad_right', 'assets/sprites/zombie/DAD/dad_142_sheet.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('dad_down', 'assets/sprites/zombie/DAD/dad_down.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('dad_up', 'assets/sprites/zombie/DAD/dad_up.png', {
      frameWidth: 256, frameHeight: 256,
    });

    // MOM 護衛キャラ
    this.load.spritesheet('mom_right', 'assets/sprites/zombie/MAM/walk_right.png', {
      frameWidth: 410, frameHeight: 689,  // 横歩き、足=(196,660)、setOrigin(0.478,0.958)
    });
    this.load.spritesheet('mom_down', 'assets/sprites/zombie/MAM/walk_down.png', {
      frameWidth: 368, frameHeight: 780,  // 正面歩き、足=(184,780)、setOrigin(0.5,1.0)
    });
    this.load.spritesheet('mom_up', 'assets/sprites/zombie/MAM/walk_up.png', {
      frameWidth: 340, frameHeight: 600,  // 背面歩き、足=(195,600)、setOrigin(0.574,1.0)
    });

    // 地面・道路テクスチャ
    ['grass', 'dirt', 'road', 'asphalt'].forEach(type => {
      this.load.image(`ground_${type}`, `assets/sprites/ground/${type}.png`);
    });

    // サラリーマンゾンビ
    this.load.spritesheet('salaryman_right', 'assets/sprites/zombie/salaryman/walk_right.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('salaryman_down', 'assets/sprites/zombie/salaryman/walk_down.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('salaryman_up', 'assets/sprites/zombie/salaryman/walk_up.png', {
      frameWidth: 256, frameHeight: 256,
    });

    // 作業員ゾンビ（ファイルが存在すれば読み込む）
    this.load.spritesheet('worker_right', 'assets/sprites/zombie/worker/walk_right.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('worker_down', 'assets/sprites/zombie/worker/walk_down.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('worker_up', 'assets/sprites/zombie/worker/walk_up.png', {
      frameWidth: 256, frameHeight: 256,
    });

    // 警察ゾンビ（6フレーム）
    this.load.spritesheet('police_right', 'assets/sprites/zombie/police/walk_right.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('police_down', 'assets/sprites/zombie/police/walk_down.png', {
      frameWidth: 256, frameHeight: 256,
    });
    this.load.spritesheet('police_up', 'assets/sprites/zombie/police/walk_up.png', {
      frameWidth: 256, frameHeight: 256,
    });
  }

  // ─── 音声試し読み込み ────────────────────────────────────
  _tryLoadAudio() {
    [
      'shoot', 'hit', 'escort_hit', 'groan', 'coin', 'clear', 'gameover'
    ].forEach(name => {
      this.load.audio(`sfx_${name}`, `assets/audio/${name}.wav`);
    });
  }
}
