import { locateAtTime } from "./editor-core.mjs";

const waitFor = (target, event) => new Promise((resolve, reject) => {
  if ((target.tagName === "VIDEO" && target.readyState >= 2) || (target.tagName === "IMG" && target.complete)) {
    resolve();
    return;
  }
  target.addEventListener(event, resolve, { once: true });
  target.addEventListener("error", () => reject(new Error("Falha ao carregar mídia")), { once: true });
});

const hexToRgba = (hex, alpha = 1) => {
  if (!hex || hex === "transparent") return "transparent";
  if (!hex.startsWith("#")) return hex;
  const value = hex.slice(1);
  const full = value.length === 3 ? value.split("").map((part) => part + part).join("") : value;
  const number = Number.parseInt(full, 16);
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`;
};

const preciseSeek = (element, time) => new Promise((resolve) => {
  let settled = false;
  const done = () => { if (!settled) { settled = true; resolve(); } };
  element.addEventListener("seeked", done, { once: true });
  try { element.currentTime = time; } catch { done(); }
  setTimeout(done, 280);
});

export class CanvasRenderer {
  constructor(canvas, mediaStore) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.mediaStore = mediaStore;
    this.cache = new Map();
    this.activeSourceId = null;
  }

  async ensureSource(sourceId) {
    if (this.cache.has(sourceId)) return this.cache.get(sourceId);
    const source = await this.mediaStore.get(sourceId);
    if (!source) throw new Error("Mídia não encontrada");
    const url = await this.mediaStore.getUrl(sourceId);
    let element;
    if (source.mediaType === "image") {
      element = new Image();
      element.src = url;
      await waitFor(element, "load");
    } else {
      element = document.createElement(source.mediaType === "audio" ? "audio" : "video");
      element.preload = "auto";
      element.playsInline = true;
      element.crossOrigin = "anonymous";
      element.src = url;
      await waitFor(element, "loadeddata");
    }
    const entry = { source, url, element };
    this.cache.set(sourceId, entry);
    return entry;
  }

  resize(project, maxHeight = null) {
    let width = project.width;
    let height = project.height;
    const shortEdge = Math.min(width, height);
    if (maxHeight && shortEdge > maxHeight) {
      const scale = maxHeight / shortEdge;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  pauseAll(except = null) {
    for (const [id, item] of this.cache) {
      if (id !== except && item.element instanceof HTMLMediaElement && !item.element.paused) item.element.pause();
    }
  }

  async render(project, time, options = {}) {
    const { playing = false, silent = false, maxHeight = null, precise = false } = options;
    this.resize(project, maxHeight);
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = maxHeight && maxHeight <= 540 ? "medium" : "high";
    ctx.save();
    ctx.fillStyle = project.background || "#000000";
    ctx.fillRect(0, 0, width, height);
    const located = locateAtTime(project, time);

    if (located) {
      const { element, source } = await this.ensureSource(located.clip.sourceId);
      if (element instanceof HTMLVideoElement) {
        const effect = located.clip.effect || {};
        let targetSourceTime = located.sourceTime;
        if (located.clip.reverse) {
          targetSourceTime = Math.max(located.clip.trimStart, located.clip.trimEnd - located.localTimelineTime * located.clip.speed);
        }
        if (effect.preset === "stopMotion") {
          const step = 1 / 8;
          targetSourceTime = located.clip.trimStart + Math.floor((targetSourceTime - located.clip.trimStart) / step) * step;
        }
        element.playbackRate = located.clip.speed;
        element.volume = silent ? 0 : Math.min(1, located.clip.volume);
        if (Math.abs(element.currentTime - targetSourceTime) > (playing && !located.clip.reverse ? 0.35 : 0.04)) {
          if (precise && (located.clip.reverse || effect.preset === "stopMotion")) await preciseSeek(element, targetSourceTime);
          else try { element.currentTime = targetSourceTime; } catch { /* metadata may still be settling */ }
        }
        const frameByFrame = located.clip.reverse || effect.preset === "stopMotion";
        if (playing && !frameByFrame && element.paused) element.play().catch(() => {});
        if ((!playing || frameByFrame) && !element.paused) element.pause();
        this.pauseAll(located.clip.sourceId);
      } else {
        this.pauseAll();
      }
      this.activeSourceId = located.clip.sourceId;
      this.drawMedia(element, source, located.clip, located.localTimelineTime);
      this.drawClipEffect(located.clip, located.localTimelineTime);

      const fadeDuration = Math.min(located.clip.transition?.duration || 0, located.duration / 2);
      if (fadeDuration > 0) {
        const distanceToEdge = Math.min(located.localTimelineTime, located.duration - located.localTimelineTime);
        if (distanceToEdge < fadeDuration) {
          ctx.fillStyle = `rgba(0,0,0,${1 - distanceToEdge / fadeDuration})`;
          ctx.fillRect(0, 0, width, height);
        }
      }
    } else {
      this.pauseAll();
      this.drawEmpty();
    }

    this.drawOverlays(project, time);
    ctx.restore();
    return located;
  }

  drawMedia(element, source, clip, localTime = 0) {
    const ctx = this.context;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    const mediaWidth = source.width || element.videoWidth || element.naturalWidth || canvasWidth;
    const mediaHeight = source.height || element.videoHeight || element.naturalHeight || canvasHeight;
    const rotated = Math.abs(clip.rotation % 180) === 90;
    const targetWidth = rotated ? canvasHeight : canvasWidth;
    const targetHeight = rotated ? canvasWidth : canvasHeight;
    const scale = clip.fit === "cover"
      ? Math.max(targetWidth / mediaWidth, targetHeight / mediaHeight)
      : Math.min(targetWidth / mediaWidth, targetHeight / mediaHeight);
    const drawWidth = mediaWidth * scale;
    const drawHeight = mediaHeight * scale;
    const filter = clip.filter || {};
    const temperature = Number(filter.temperature) || 0;

    ctx.save();
    ctx.globalAlpha = clip.opacity ?? 1;
    const effect = clip.effect || {};
    const intensity = effect.intensity ?? 0.55;
    const beatPhase = ((localTime * (effect.bpm || 120) / 60) % 1 + 1) % 1;
    const beatPulse = effect.beatSync ? Math.exp(-beatPhase * 9) : 0;
    const shakes = ["shake", "gaming", "glitch"].includes(effect.preset);
    const shakeAmount = shakes ? intensity * (effect.beatSync ? beatPulse : 0.65) : 0;
    const shakeX = Math.sin(localTime * 61) * canvasWidth * 0.018 * shakeAmount;
    const shakeY = Math.cos(localTime * 47) * canvasHeight * 0.012 * shakeAmount;
    ctx.translate(
      canvasWidth / 2 + (clip.offsetX || 0) * canvasWidth / 2 + shakeX,
      canvasHeight / 2 + (clip.offsetY || 0) * canvasHeight / 2 + shakeY,
    );
    ctx.rotate((clip.rotation || 0) * Math.PI / 180);
    const pulsePreset = ["zoomPulse", "gaming"].includes(effect.preset);
    const pulse = pulsePreset ? 1 + intensity * (effect.beatSync ? beatPulse : (Math.sin(localTime * 7) + 1) / 2) * 0.12 : 1;
    const userScale = (clip.scale || 1) * pulse;
    ctx.scale((clip.flipX ? -1 : 1) * userScale, (clip.flipY ? -1 : 1) * userScale);
    ctx.filter = [
      `brightness(${filter.brightness ?? 100}%)`,
      `contrast(${filter.contrast ?? 100}%)`,
      `saturate(${filter.saturation ?? 100}%)`,
      `sepia(${Math.abs(temperature) * 0.35}%)`,
      `hue-rotate(${temperature < 0 ? 185 : -12}deg)`,
      `blur(${filter.blur ?? 0}px)`,
    ].join(" ");
    ctx.drawImage(element, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    if (effect.preset === "glitch") {
      ctx.globalAlpha = 0.22 * intensity;
      ctx.globalCompositeOperation = "screen";
      ctx.filter = "hue-rotate(145deg) saturate(180%)";
      ctx.drawImage(element, -drawWidth / 2 + Math.sin(localTime * 93) * 12 * intensity, -drawHeight / 2, drawWidth, drawHeight);
    }
    ctx.restore();
  }

  drawClipEffect(clip, localTime) {
    const effect = clip.effect || {};
    const intensity = effect.intensity ?? 0.55;
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const beatPhase = ((localTime * (effect.bpm || 120) / 60) % 1 + 1) % 1;
    const beatPulse = effect.beatSync ? Math.exp(-beatPhase * 9) : 0;
    ctx.save();
    if (effect.preset === "fire") {
      const gradient = ctx.createLinearGradient(0, height, 0, height * 0.58);
      gradient.addColorStop(0, `rgba(255,35,0,${0.72 * intensity})`);
      gradient.addColorStop(0.48, `rgba(255,145,0,${0.36 * intensity})`);
      gradient.addColorStop(1, "rgba(255,220,40,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += Math.max(8, width / 35)) {
        const flame = Math.sin(x * 0.035 + localTime * 8) * height * 0.055 + Math.sin(x * 0.081 - localTime * 13) * height * 0.025;
        ctx.lineTo(x, height * 0.74 + flame * intensity);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
    if (effect.preset === "strobe") {
      const flash = Math.max(0, Math.sin(localTime * 22)) ** 9;
      ctx.fillStyle = `rgba(255,255,255,${flash * intensity * 0.72})`;
      ctx.fillRect(0, 0, width, height);
    }
    if (effect.preset === "vhs") {
      ctx.fillStyle = `rgba(20,240,210,${0.05 * intensity})`;
      for (let y = (localTime * 80) % 7; y < height; y += 7) ctx.fillRect(0, y, width, 2);
      ctx.fillStyle = `rgba(255,0,80,${0.08 * intensity})`;
      ctx.fillRect(0, (localTime * 173) % height, width, Math.max(2, height * 0.008));
    }
    if (effect.preset === "cinematic") {
      const bar = height * 0.09 * intensity;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, bar);
      ctx.fillRect(0, height - bar, width, bar);
    }
    if (effect.preset === "garden") {
      ctx.fillStyle = `rgba(70,190,80,${0.08 * intensity})`;
      ctx.fillRect(0, 0, width, height);
      for (let index = 0; index < 14; index += 1) {
        const x = ((index * 97 + localTime * (12 + index)) % (width + 40)) - 20;
        const y = ((index * 181 + localTime * (24 + index)) % (height + 40)) - 20;
        ctx.fillStyle = `rgba(240,255,210,${0.18 * intensity})`;
        ctx.beginPath();
        ctx.arc(x, y, 2 + (index % 4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (["zoomPulse", "gaming"].includes(effect.preset) && beatPulse > 0.05) {
      ctx.strokeStyle = `rgba(255,255,255,${beatPulse * intensity * 0.45})`;
      ctx.lineWidth = Math.max(2, width * 0.008);
      ctx.strokeRect(0, 0, width, height);
    }
    ctx.restore();
  }

  drawOverlays(project, time) {
    const ctx = this.context;
    const scale = this.canvas.width / 1080;
    for (const overlay of project.overlays) {
      if (time < overlay.start || time > overlay.end) continue;
      const x = overlay.x * this.canvas.width;
      const y = overlay.y * this.canvas.height;
      const fontSize = Math.max(12, overlay.size * scale);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((overlay.rotation || 0) * Math.PI / 180);
      ctx.globalAlpha = overlay.opacity ?? 1;
      ctx.font = `${overlay.weight || 700} ${fontSize}px ${overlay.font || "system-ui"}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const text = String(overlay.text ?? "");
      const metrics = ctx.measureText(text);
      if (overlay.background && overlay.background !== "transparent") {
        const padding = fontSize * 0.3;
        ctx.fillStyle = hexToRgba(overlay.background, 0.82);
        ctx.beginPath();
        ctx.roundRect(-metrics.width / 2 - padding, -fontSize * 0.65, metrics.width + padding * 2, fontSize * 1.3, fontSize * 0.22);
        ctx.fill();
      }
      if (overlay.shadow) {
        ctx.shadowColor = "rgba(0,0,0,.7)";
        ctx.shadowBlur = fontSize * 0.12;
        ctx.shadowOffsetY = fontSize * 0.08;
      }
      ctx.fillStyle = overlay.color || "#ffffff";
      ctx.fillText(text, 0, 0, this.canvas.width * 0.9);
      ctx.restore();
    }
  }

  drawEmpty() {
    const ctx = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.fillStyle = "rgba(255,255,255,.55)";
    ctx.font = `700 ${Math.max(16, width * 0.045)}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillText("Adicione um vídeo ou uma foto", width / 2, height / 2);
  }
}
