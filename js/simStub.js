'use strict';
// Escort/Zombie が real Phaser scene に期待する add/textures/anims の最小スタブ。
// run_sim.js（Node vm）と simulator.html（ブラウザ）の両方から読み込む共通定義。
// 片方だけ更新すると「CLIは通るがブラウザは落ちる」の再発が起きるため、必ずここを直す。
var createMockSceneAdd = function () {
  var _noop = {
    setDepth: function () { return this; },
    setAlpha: function () { return this; },
    setScale: function () { return this; },
    setFlipX: function () { return this; },
    setOrigin: function () { return this; },
    setVisible: function () { return this; },
    setPosition: function () { return this; },
    setX: function () { return this; },
    setY: function () { return this; },
    setTexture: function () { return this; },
    setFrame: function () { return this; },
    fillStyle: function () { return this; },
    fillRect: function () {},
    clear: function () {},
    destroy: function () {},
    play: function () {},
  };
  return {
    graphics: function () { return Object.assign({}, _noop); },
    sprite: function () { return Object.assign({}, _noop); },
    image: function () { return Object.assign({}, _noop); },
    text: function () { return Object.assign({}, _noop); },
    ellipse: function () { return Object.assign({}, _noop); },
    particles: function () { return Object.assign({}, _noop); },
  };
};
var MOCK_TEXTURES = { exists: function () { return false; } };
var MOCK_ANIMS    = { exists: function () { return false; } };
