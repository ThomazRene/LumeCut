import { CanvasRenderer } from "./renderer.mjs";
import { projectDuration } from "./editor-core.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const chooseMimeType = () => {
  const types = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
};

const seek = async (element, time) => {
  if (Math.abs(element.currentTime - time) < 0.03) return;
  await new Promise((resolve) => {
    element.addEventListener("seeked", resolve, { once: true });
    element.currentTime = Math.max(0, time);
    setTimeout(resolve, 600);
  });
};

export const exportProject = async ({
  project,
  mediaStore,
  quality = "1080p",
  onProgress = () => {},
  signal,
}) => {
  if (!("MediaRecorder" in globalThis) || !HTMLCanvasElement.prototype.captureStream) {
    throw new Error("Este navegador não oferece exportação de vídeo. Use Chrome/Edge no Android ou Safari atualizado no iPhone.");
  }
  const total = projectDuration(project);
  if (total <= 0) throw new Error("Adicione pelo menos um clipe antes de exportar.");

  const heights = { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, "4K": 2160, "8K": 4320 };
  const bitrates = { "480p": 1_800_000, "720p": 4_000_000, "1080p": 8_000_000, "1440p": 16_000_000, "4K": 35_000_000, "8K": 80_000_000 };
  const maxHeight = heights[quality] || 1080;
  const canvas = document.createElement("canvas");
  const renderer = new CanvasRenderer(canvas, mediaStore);
  renderer.resize(project, maxHeight);

  for (const clip of project.clips) await renderer.ensureSource(clip.sourceId);
  const fps = Math.min(144, Math.max(24, project.fps || 30));
  const fpsBitrateFactor = Math.min(3.5, Math.max(1, fps / 30));
  const canvasStream = canvas.captureStream(fps);
  let audioContext = null;
  let destination = null;
  let clockOscillator = null;
  const gains = new Map();
  const backgroundAudio = [];

  try {
    audioContext = new AudioContext();
    destination = audioContext.createMediaStreamDestination();
    // Mantém uma linha de tempo de áudio contínua em projetos só com fotos.
    // O ganho quase nulo evita que alguns gravadores móveis encurtem vídeos estáticos.
    clockOscillator = audioContext.createOscillator();
    const clockGain = audioContext.createGain();
    clockGain.gain.value = 0.00001;
    clockOscillator.connect(clockGain).connect(destination);
    clockOscillator.start();
    for (const clip of project.clips) {
      if (gains.has(clip.sourceId)) continue;
      const item = await renderer.ensureSource(clip.sourceId);
      if (!(item.element instanceof HTMLVideoElement)) continue;
      const sourceNode = audioContext.createMediaElementSource(item.element);
      const gain = audioContext.createGain();
      gain.gain.value = clip.volume;
      sourceNode.connect(gain).connect(destination);
      gains.set(clip.sourceId, gain);
    }
    for (const track of project.audioTracks) {
      const element = new Audio(await mediaStore.getUrl(track.sourceId));
      element.preload = "auto";
      element.playsInline = true;
      const sourceNode = audioContext.createMediaElementSource(element);
      const gain = audioContext.createGain();
      gain.gain.value = track.volume;
      sourceNode.connect(gain).connect(destination);
      backgroundAudio.push({ track, element, gain });
    }
  } catch {
    audioContext?.close().catch(() => {});
    audioContext = null;
    destination = null;
  }

  const tracks = [...canvasStream.getVideoTracks(), ...(destination?.stream.getAudioTracks() || [])];
  const stream = new MediaStream(tracks);
  const mimeType = chooseMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: Math.round((bitrates[quality] || bitrates["1080p"]) * fpsBitrateFactor),
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = () => reject(recorder.error || new Error("Falha durante a exportação"));
  });

  await audioContext?.resume();
  await renderer.render(project, 0, { playing: false, silent: false, maxHeight });
  recorder.start(1000);
  const startedAt = performance.now();
  let lastSource = null;

  while (true) {
    if (signal?.aborted) {
      recorder.stop();
      renderer.pauseAll();
      await stopped;
      throw new DOMException("Exportação cancelada", "AbortError");
    }
    const elapsed = (performance.now() - startedAt) / 1000;
    const time = Math.min(total, elapsed);
    const located = await renderer.render(project, time, { playing: true, silent: false, maxHeight, precise: true });
    canvasStream.getVideoTracks()[0]?.requestFrame?.();
    if (located && located.clip.sourceId !== lastSource) {
      const item = await renderer.ensureSource(located.clip.sourceId);
      if (item.element instanceof HTMLVideoElement) {
        await seek(item.element, located.sourceTime);
        item.element.playbackRate = located.clip.speed;
        gains.get(located.clip.sourceId)?.gain.setValueAtTime(located.clip.volume, audioContext?.currentTime || 0);
        await item.element.play().catch(() => {});
      }
      lastSource = located.clip.sourceId;
    }
    for (const item of backgroundAudio) {
      const { track, element, gain } = item;
      const available = track.duration - track.trimStart;
      const elapsedTrack = time - track.start;
      const active = elapsedTrack >= 0 && available > 0 && (track.loop || elapsedTrack < available);
      if (!active) {
        element.pause();
        continue;
      }
      const target = track.trimStart + (track.loop ? elapsedTrack % available : elapsedTrack);
      gain.gain.setValueAtTime(track.volume, audioContext?.currentTime || 0);
      if (Math.abs(element.currentTime - target) > .35) await seek(element, target);
      if (element.paused) await element.play().catch(() => {});
    }
    onProgress(time / total);
    if (elapsed >= total) break;
    await wait(1000 / fps);
  }

  renderer.pauseAll();
  backgroundAudio.forEach(({ element }) => element.pause());
  try { clockOscillator?.stop(); } catch { /* já encerrado */ }
  recorder.stop();
  await stopped;
  canvasStream.getTracks().forEach((track) => track.stop());
  await audioContext?.close();
  const type = recorder.mimeType || mimeType || "video/webm";
  return {
    blob: new Blob(chunks, { type }),
    extension: type.includes("mp4") ? "mp4" : "webm",
    mimeType: type,
  };
};
