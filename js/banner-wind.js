// 每面旗帜独立选择下一阵风：方向、幅度和持续时间都随机，帧间只做平滑插值。
export const BANNER_WIND_RANGE = Object.freeze({
  amplitude: [0.055, 0.105], // 左 / 右目标位移，米；换向时会自然经过零点。
  duration: [1.8, 3.6],
  strength: [0.78, 1],
});

export class BannerWind {
  constructor(random = Math.random) {
    this.random = random;
    this.start = 0;
    this.from = { sway: 0, strength: 0.85 };
    this.to = this.nextTarget();
    this.duration = this.range(BANNER_WIND_RANGE.duration);
    this.speed = this.range([1.1, 1.8]);
    this.phase = this.range([0, Math.PI * 2]);
  }

  range([min, max]) { return min + (max - min) * this.random(); }

  nextTarget() {
    const direction = this.random() < 0.5 ? -1 : 1;
    return {
      sway: direction * this.range(BANNER_WIND_RANGE.amplitude),
      strength: this.range(BANNER_WIND_RANGE.strength),
    };
  }

  sample(time) {
    // 按模拟时间推进，不按帧数抽签；同一阵风在不同帧率下保持同样的轨迹。
    while (time >= this.start + this.duration) {
      this.start += this.duration;
      this.from = this.to;
      this.to = this.nextTarget();
      this.duration = this.range(BANNER_WIND_RANGE.duration);
    }
    const k = Math.min(1, Math.max(0, (time - this.start) / this.duration));
    const ease = k * k * k * (k * (6 * k - 15) + 10); // 端点速度、加速度为零，换向不跳动。
    return {
      sway: this.from.sway + (this.to.sway - this.from.sway) * ease,
      strength: this.from.strength + (this.to.strength - this.from.strength) * ease,
      swell: time * this.speed + this.phase,
      fold: time * this.speed * 1.73 + this.phase * 1.29,
    };
  }
}
