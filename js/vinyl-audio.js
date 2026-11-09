// 轻微旧唱片质感：柔和高频 + 低电平底噪 + 稀疏针噪。原 MP3 不做修改。
// 所有声音都经过 master，暂停和音量为零时不会留下单独的噪声。
export function createVinylAudio(audio, volume, enabled) {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const master = context.createGain();
  master.gain.value = volume;
  master.connect(context.destination);

  const dry = context.createGain(), wet = context.createGain();
  dry.gain.value = enabled ? 0 : 1;
  wet.gain.value = enabled ? 1 : 0;
  dry.connect(master);
  wet.connect(master);
  const lowCut = context.createBiquadFilter();
  lowCut.type = 'highpass'; lowCut.frequency.value = 45; lowCut.Q.value = 0.7;
  const warmth = context.createBiquadFilter();
  warmth.type = 'highshelf'; warmth.frequency.value = 2800; warmth.gain.value = -4;
  const highCut = context.createBiquadFilter();
  highCut.type = 'lowpass'; highCut.frequency.value = 8500; highCut.Q.value = 0.7;
  lowCut.connect(warmth).connect(highCut).connect(wet);

  // 12 秒随机纹理，循环接缝淡入淡出；不引入持续变化的音高，保留钢琴的稳定音准。
  const buffer = context.createBuffer(2, context.sampleRate * 12, context.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const samples = buffer.getChannelData(ch);
    let soft = 0;
    for (let i = 0; i < samples.length; i++) {
      soft = 0.65 * soft + 0.35 * (Math.random() * 2 - 1);
      samples[i] = soft * 0.004;
    }
    for (let t = 0.4; t < 11.8; t += 0.5 + Math.random() * 1.8) {
      const start = Math.floor(t * context.sampleRate);
      const length = Math.floor(context.sampleRate * (0.002 + Math.random() * 0.004));
      const amplitude = 0.012 + Math.random() * 0.014;
      for (let k = 0; k < length; k++) {
        samples[start + k] += (Math.random() * 2 - 1) * amplitude * Math.exp(-6 * k / length);
      }
    }
    const fade = Math.floor(context.sampleRate * 0.025);
    for (let i = 0; i < fade; i++) {
      samples[i] *= i / fade;
      samples[samples.length - 1 - i] *= i / fade;
    }
  }
  const noise = context.createBufferSource(), noiseGain = context.createGain();
  noise.buffer = buffer;
  noise.loop = true;
  noiseGain.gain.value = 0;
  noise.connect(noiseGain).connect(master);
  noise.start();

  const source = context.createMediaElementSource(audio);
  source.connect(dry);
  source.connect(lowCut);
  audio.volume = 1; // Web Audio 总音量同时控制歌曲与底噪。
  let playing = false;
  function ramp(param, value) {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, 0.025);
  }
  return {
    context,
    resume: () => context.resume(),
    suspend: () => context.suspend(),
    setVolume(value) { ramp(master.gain, value); },
    setEnabled(value) {
      enabled = value;
      ramp(dry.gain, enabled ? 0 : 1);
      ramp(wet.gain, enabled ? 1 : 0);
      ramp(noiseGain.gain, enabled && playing ? 1 : 0);
    },
    setPlaying(value) {
      playing = value;
      ramp(noiseGain.gain, enabled && playing ? 1 : 0);
    },
    dispose() { noise.stop(); source.disconnect(); context.close(); },
  };
}
