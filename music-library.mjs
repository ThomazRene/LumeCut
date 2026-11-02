const tracks = {
  gaming: { name: "Gaming Pulse", bpm: 128, duration: 12 },
  neon: { name: "Neon Drive", bpm: 120, duration: 12 },
  garden: { name: "Jardim Calmo", bpm: 84, duration: 16 },
};

export const freeTracks = Object.entries(tracks).map(([id, track]) => ({ id, ...track }));

const writeAscii = (view, offset, text) => {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
};

const encodeWav = (samples, sampleRate) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, samples[index])) * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
};

export const createProceduralTrack = (id) => {
  const track = tracks[id];
  if (!track) throw new Error("Música não encontrada");
  const sampleRate = 22_050;
  const total = Math.floor(sampleRate * track.duration);
  const samples = new Float32Array(total);
  const beatLength = 60 / track.bpm;
  let randomState = 0x12345678;
  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 0xffffffff;
  };

  for (let index = 0; index < total; index += 1) {
    const time = index / sampleRate;
    const beat = time % beatLength;
    const beatIndex = Math.floor(time / beatLength);
    let value = 0;
    if (id === "gaming") {
      const kick = Math.sin(2 * Math.PI * (78 - beat * 55) * beat) * Math.exp(-beat * 18);
      const notes = [220, 277.18, 329.63, 440];
      const note = notes[beatIndex % notes.length];
      const synth = Math.sin(2 * Math.PI * note * time) * 0.18 + Math.sin(2 * Math.PI * note * 2 * time) * 0.06;
      const gate = beat < beatLength * 0.62 ? 1 : 0;
      value = kick * 0.62 + synth * gate;
    } else if (id === "neon") {
      const bassNotes = [55, 65.41, 73.42, 49];
      const bass = Math.sin(2 * Math.PI * bassNotes[Math.floor(beatIndex / 2) % 4] * time) * 0.36;
      const kick = Math.sin(2 * Math.PI * 64 * beat) * Math.exp(-beat * 22) * 0.58;
      const hatPhase = time % (beatLength / 2);
      const hat = (random() * 2 - 1) * Math.exp(-hatPhase * 85) * 0.1;
      value = bass + kick + hat;
    } else {
      const chord = [261.63, 329.63, 392].reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * time), 0) / 3;
      const pad = chord * (0.2 + Math.sin(time * Math.PI / 4) * 0.04);
      const sparkle = Math.sin(2 * Math.PI * (659.25 + Math.sin(time * 0.3) * 18) * time) * Math.max(0, Math.sin(time * 1.7)) ** 16 * 0.09;
      value = pad + sparkle;
    }
    samples[index] = Math.tanh(value * 1.25) * 0.72;
  }
  return { blob: encodeWav(samples, sampleRate), ...track };
};

export const estimateBpm = async (blob) => {
  const audioContext = new AudioContext();
  try {
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const windowSize = 1024;
    const maxSamples = Math.min(data.length, sampleRate * 75);
    const energy = [];
    for (let offset = 0; offset < maxSamples; offset += windowSize) {
      let sum = 0;
      for (let index = offset; index < Math.min(offset + windowSize, maxSamples); index += 1) sum += data[index] * data[index];
      energy.push(Math.sqrt(sum / windowSize));
    }
    const onset = energy.map((value, index) => Math.max(0, value - (energy[index - 1] || value)));
    let bestBpm = 120;
    let bestScore = -Infinity;
    for (let bpm = 60; bpm <= 200; bpm += 1) {
      const lag = Math.round((60 / bpm) * sampleRate / windowSize);
      let score = 0;
      for (let index = lag; index < onset.length; index += 1) score += onset[index] * onset[index - lag];
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }
    return bestBpm;
  } finally {
    await audioContext.close();
  }
};
