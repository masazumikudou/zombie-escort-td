// BootScene: ステージJSONを読み込んで GameScene に渡す
class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  init(data) {
    this.stageFile = data.stageFile || 'stages/stage_01.json';
  }

  preload() {
    this.load.json('stageData', this.stageFile);

    // ローディング表示
    const w = this.cameras.main.width, h = this.cameras.main.height;
    this.add.text(w / 2, h / 2, 'Loading...', {
      fontSize: '22px', color: '#aaaaaa'
    }).setOrigin(0.5);
  }

  create() {
    const stageData = this.cache.json.get('stageData');
    this.scene.start('GameScene', { stageData });
  }
}
