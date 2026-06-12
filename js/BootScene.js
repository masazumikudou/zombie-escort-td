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

    // 遮蔽物
    this.load.image('obstacle_building', 'assets/sprites/obstacle/building.png');
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
