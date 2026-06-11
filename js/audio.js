// Web Audio API による効果音合成
// ASSET SWAP POINT: 実音声ファイルが揃ったら loadFile() に差し替え可能
class AudioSynth {
  constructor() {
    this._ctx = null;
    this._enabled = true;
  }

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // iOS/Chrome の自動再生制限を回避
    if (this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
    return this._ctx;
  }

  _play(type, freq, duration, gainVal = 0.3, detune = 0) {
    if (!this._enabled) return;
    try {
      const ctx  = this._getCtx();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type       = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      if (detune) osc.detune.setValueAtTime(detune, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (_) {}
  }

  shoot() {
    this._play('square', 880, 0.08, 0.15);
  }

  hit() {
    this._play('sawtooth', 220, 0.12, 0.25, -600);
  }

  escortHit() {
    this._play('sawtooth', 120, 0.18, 0.4, -200);
  }

  zombieGroan() {
    this._play('triangle', 80, 0.4, 0.2, 300);
  }

  coin() {
    this._play('sine', 660, 0.1, 0.2);
    setTimeout(() => this._play('sine', 880, 0.1, 0.15), 80);
  }

  stageClear() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      setTimeout(() => this._play('sine', f, 0.3, 0.4), i * 120);
    });
  }

  gameOver() {
    this._play('sawtooth', 220, 0.5, 0.4);
    setTimeout(() => this._play('sawtooth', 165, 0.6, 0.4), 200);
    setTimeout(() => this._play('sawtooth', 110, 0.8, 0.4), 450);
  }

  setEnabled(v) { this._enabled = v; }
}

const audioSynth = new AudioSynth();
