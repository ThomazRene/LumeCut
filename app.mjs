import {
  HistoryStore,
  addAudioTrack,
  addClip,
  addOverlay,
  createClip,
  createProject,
  duplicateClip,
  formatTime,
  moveClip,
  parseProject,
  projectDuration,
  removeAudioTrack,
  removeClip,
  removeOverlay,
  serializeProject,
  setAspectRatio,
  splitClip,
  timeline,
  updateAudioTrack,
  updateClip,
  updateOverlay,
} from "./editor-core.mjs";
import { MediaStore } from "./media-store.mjs";
import { CanvasRenderer } from "./renderer.mjs";
import { exportProject } from "./export-engine.mjs";
import { applySmartEdit, smartSuggestions } from "./smart-assistant.mjs";
import { createProceduralTrack, estimateBpm, freeTracks } from "./music-library.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const numberValue = (element) => Number.parseFloat(element.value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const elements = {
  canvas: $("#preview"),
  previewStage: $("#preview-stage"),
  emptyImport: $("#empty-import"),
  mediaInput: $("#media-input"),
  audioInput: $("#audio-input"),
  aiReferenceInput: $("#ai-reference-input"),
  projectInput: $("#project-input"),
  projectName: $("#project-name"),
  play: $("#play"),
  previous: $("#previous"),
  next: $("#next"),
  timeDisplay: $("#time-display"),
  timelineContent: $("#timeline-content"),
  timelineScroll: $("#timeline-scroll"),
  timeRuler: $("#time-ruler"),
  videoTrack: $("#video-track"),
  overlayTrack: $("#overlay-track"),
  audioTrack: $("#audio-track"),
  playhead: $("#playhead"),
  timelineSummary: $("#timeline-summary"),
  inspector: $("#inspector"),
  toast: $("#toast"),
  exportModal: $("#export-modal"),
  exportProgress: $("#export-progress"),
  exportStatus: $("#export-status"),
};

const mediaStore = new MediaStore();
const renderer = new CanvasRenderer(elements.canvas, mediaStore);
let project = createProject();
let history = new HistoryStore(project);
let selectedClipId = null;
let selectedOverlayId = null;
let selectedAudioId = null;
let activeTool = "edit";
let currentTime = 0;
let playing = false;
let animationFrame = null;
let lastFrameAt = 0;
let renderVersion = 0;
let toastTimer = null;
let saveTimer = null;
let exportQuality = "1080p";
let exportDestination = "share";
let exportExperimental = false;
let exportController = null;
let aiReferenceFiles = [];
let aiPrompt = "Monte um vídeo dinâmico vertical com começo forte e transições suaves";
const audioElements = new Map();
const PX_PER_SECOND = 44;
const LOW_END_DEVICE = (navigator.deviceMemory && navigator.deviceMemory <= 4)
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
const PREVIEW_SHORT_EDGE = LOW_END_DEVICE ? 360 : 540;
const PREVIEW_FRAME_INTERVAL = 1000 / (LOW_END_DEVICE ? 24 : 30);
let previewRenderPending = false;
let previewRenderQueued = false;
let lastPreviewRenderAt = 0;

const selectedClip = () => project.clips.find((clip) => clip.id === selectedClipId) ?? null;
const selectedOverlay = () => project.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
const selectedAudio = () => project.audioTracks.find((track) => track.id === selectedAudioId) ?? null;

const resolutionShortEdge = { "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, "4K": 2160, "8K": 4320 };
const resolutionRank = { "480p": 1, "720p": 2, "1080p": 3, "1440p": 4, "4K": 5, "8K": 6 };

function exportCapability(quality = exportQuality, fps = project.fps) {
  const memory = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  let maxQuality = "1080p";
  let maxFps = 30;
  if (memory >= 6 && cores >= 6) { maxQuality = "1440p"; maxFps = 60; }
  if (memory >= 8 && cores >= 8) { maxQuality = "4K"; maxFps = 60; }
  if (memory >= 12 && cores >= 10) { maxQuality = "4K"; maxFps = 120; }
  const safe = resolutionRank[quality] <= resolutionRank[maxQuality] && fps <= maxFps;
  return {
    safe,
    allowed: safe || exportExperimental,
    recommended: `${maxQuality} ${maxFps} fps`,
    memory,
    cores,
  };
}

function estimatedExportSize() {
  const baseMbps = { "480p": 1.8, "720p": 4, "1080p": 8, "1440p": 16, "4K": 35, "8K": 80 }[exportQuality] || 8;
  const fpsFactor = Math.min(3.5, Math.max(1, project.fps / 30));
  return Math.max(1, Math.round(baseMbps * fpsFactor * projectDuration(project) / 8));
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => mediaStore.saveProject(project).catch(() => {
    toast("Não foi possível salvar automaticamente.", true);
  }), 500);
}

function commit(nextProject, message = null) {
  project = history.commit(nextProject);
  currentTime = clamp(currentTime, 0, projectDuration(project));
  if (selectedClipId && !selectedClip()) selectedClipId = project.clips[0]?.id ?? null;
  if (selectedOverlayId && !selectedOverlay()) selectedOverlayId = null;
  if (selectedAudioId && !selectedAudio()) selectedAudioId = null;
  scheduleSave();
  renderAll();
  if (message) toast(message);
}

function replaceProject(nextProject) {
  project = nextProject;
  history = new HistoryStore(project);
  selectedClipId = project.clips[0]?.id ?? null;
  selectedOverlayId = null;
  selectedAudioId = null;
  currentTime = 0;
  pause();
  scheduleSave();
  renderAll();
}

async function renderPreview(force = false) {
  const now = performance.now();
  if (previewRenderPending) {
    if (force || !playing) previewRenderQueued = true;
    return;
  }
  if (!force && playing && now - lastPreviewRenderAt < PREVIEW_FRAME_INTERVAL) return;
  previewRenderPending = true;
  lastPreviewRenderAt = now;
  const version = ++renderVersion;
  try {
    await renderer.render(project, currentTime, { playing, silent: false, maxHeight: PREVIEW_SHORT_EDGE });
    if (version !== renderVersion) return;
    elements.emptyImport.hidden = project.clips.length > 0;
  } catch (error) {
    console.error(error);
  } finally {
    previewRenderPending = false;
    if (previewRenderQueued) {
      previewRenderQueued = false;
      renderPreview(true);
    }
  }
}

function updateTimeUi() {
  const duration = projectDuration(project);
  elements.timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  elements.playhead.style.left = `${52 + currentTime * PX_PER_SECOND}px`;
}

function renderTimeline() {
  const entries = timeline(project);
  const duration = projectDuration(project);
  const contentWidth = Math.max(elements.timelineScroll.clientWidth - 2, 52 + duration * PX_PER_SECOND + 100);
  elements.timelineContent.style.width = `${contentWidth}px`;
  elements.timelineSummary.textContent = `${project.clips.length} ${project.clips.length === 1 ? "clipe" : "clipes"} · ${formatTime(duration)}`;

  const rulerInterval = duration > 180 ? 30 : duration > 60 ? 10 : 5;
  let ruler = "";
  for (let second = 0; second <= Math.max(duration + rulerInterval, 20); second += rulerInterval) {
    ruler += `<span class="ruler-label" style="left:${52 + second * PX_PER_SECOND}px">${formatTime(second).slice(0, 5)}</span>`;
  }
  elements.timeRuler.innerHTML = ruler;

  elements.videoTrack.innerHTML = '<span class="track-label">VÍDEO</span>' + entries.map(({ clip, start, duration: clipDuration }) => `
    <button class="clip-block ${clip.mediaType === "image" ? "image" : ""} ${clip.id === selectedClipId ? "selected" : ""}"
      data-select-clip="${clip.id}" style="left:${start * PX_PER_SECOND}px;width:${Math.max(18, clipDuration * PX_PER_SECOND)}px"
      title="${escapeHtml(clip.name)} · ${formatTime(clipDuration)}">
      <span>${clip.mediaType === "image" ? "▧" : "▶"} ${escapeHtml(clip.name)}</span>
    </button>`).join("");

  elements.overlayTrack.innerHTML = '<span class="track-label">TEXTO</span>' + project.overlays.map((overlay) => `
    <button class="clip-block overlay-block ${overlay.id === selectedOverlayId ? "selected" : ""}"
      data-select-overlay="${overlay.id}" style="left:${overlay.start * PX_PER_SECOND}px;width:${Math.max(18, (overlay.end - overlay.start) * PX_PER_SECOND)}px">
      <span>T ${escapeHtml(overlay.text)}</span>
    </button>`).join("");

  elements.audioTrack.innerHTML = '<span class="track-label">ÁUDIO</span>' + project.audioTracks.map((track) => {
    const audibleDuration = Math.max(0.1, Math.min(track.duration - track.trimStart, duration - track.start));
    return `<button class="clip-block audio-block ${track.id === selectedAudioId ? "selected" : ""}"
      data-select-audio="${track.id}" style="left:${track.start * PX_PER_SECOND}px;width:${Math.max(18, audibleDuration * PX_PER_SECOND)}px">
      <span>♫ ${escapeHtml(track.name)}</span>
    </button>`;
  }).join("");
  updateTimeUi();
}

function slider({ label, value, min, max, step = 1, data, suffix = "" }) {
  return `<div class="field"><label class="field-label">${label}<span>${value}${suffix}</span></label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" ${data}></div>`;
}

function inspectorHeader(title, description) {
  return `<h2>${title}</h2><p class="inspector-description">${description}</p>`;
}

function renderEditInspector() {
  const clip = selectedClip();
  if (!clip) return inspectorHeader("Editar", "Corte, organize e transforme seus clipes.") + '<div class="empty-state">Selecione ou adicione um vídeo ou uma foto.</div>';
  return inspectorHeader("Editar clipe", escapeHtml(clip.name)) + `
    <div class="field-row">
      <div class="field"><label>Início (s)</label><input type="number" min="0" max="${clip.trimEnd - .05}" step="0.05" value="${clip.trimStart.toFixed(2)}" data-clip-prop="trimStart"></div>
      <div class="field"><label>Fim (s)</label><input type="number" min="${clip.trimStart + .05}" max="${clip.duration}" step="0.05" value="${clip.trimEnd.toFixed(2)}" data-clip-prop="trimEnd"></div>
    </div>
    ${slider({ label: "Velocidade", value: clip.speed, min: .1, max: 8, step: .1, data: 'data-clip-prop="speed"', suffix: "×" })}
    ${slider({ label: "Volume", value: Math.round(clip.volume * 100), min: 0, max: 200, data: 'data-clip-special="volume"', suffix: "%" })}
    ${slider({ label: "Zoom", value: clip.scale ?? 1, min: .25, max: 4, step: .05, data: 'data-clip-prop="scale"', suffix: "×" })}
    ${slider({ label: "Posição horizontal", value: Math.round((clip.offsetX || 0) * 100), min: -100, max: 100, data: 'data-clip-special="offsetX"', suffix: "%" })}
    ${slider({ label: "Posição vertical", value: Math.round((clip.offsetY || 0) * 100), min: -100, max: 100, data: 'data-clip-special="offsetY"', suffix: "%" })}
    ${slider({ label: "Opacidade", value: Math.round((clip.opacity ?? 1) * 100), min: 0, max: 100, data: 'data-clip-special="opacity"', suffix: "%" })}
    <div class="field"><label>Preenchimento</label><div class="segmented">
      <button data-clip-value="fit:contain" class="${clip.fit === "contain" ? "active" : ""}">Ajustar</button>
      <button data-clip-value="fit:cover" class="${clip.fit === "cover" ? "active" : ""}">Preencher</button>
    </div></div>
    <h3>Transformar</h3>
    <div class="button-grid three">
      <button class="secondary-button" data-action="rotate">↻ Girar</button>
      <button class="secondary-button ${clip.flipX ? "active" : ""}" data-action="flip-x">↔ Espelhar</button>
      <button class="secondary-button ${clip.flipY ? "active" : ""}" data-action="flip-y">↕ Inverter</button>
    </div>
    <h3>Transição</h3>
    ${slider({ label: "Fade", value: clip.transition?.duration || 0, min: 0, max: 2, step: .1, data: 'data-transition-prop="duration"', suffix: "s" })}
    <h3>Organizar</h3>
    <div class="button-grid">
      <button class="secondary-button" data-action="move-left">← Anterior</button>
      <button class="secondary-button" data-action="move-right">Próximo →</button>
      <button class="secondary-button" data-action="split">✂ Dividir aqui</button>
      <button class="secondary-button" data-action="duplicate">▣ Duplicar</button>
      <button class="danger-button" data-action="delete-clip">Excluir clipe</button>
    </div>`;
}

function renderAdjustInspector() {
  const clip = selectedClip();
  if (!clip) return inspectorHeader("Ajustar", "Cor e aparência do clipe selecionado.") + '<div class="empty-state">Selecione um clipe.</div>';
  const filter = clip.filter;
  return inspectorHeader("Ajustes", "Os efeitos aparecem na prévia e na exportação.") + `
    ${slider({ label: "Brilho", value: filter.brightness, min: 0, max: 200, data: 'data-filter-prop="brightness"', suffix: "%" })}
    ${slider({ label: "Contraste", value: filter.contrast, min: 0, max: 200, data: 'data-filter-prop="contrast"', suffix: "%" })}
    ${slider({ label: "Saturação", value: filter.saturation, min: 0, max: 200, data: 'data-filter-prop="saturation"', suffix: "%" })}
    ${slider({ label: "Temperatura", value: filter.temperature, min: -100, max: 100, data: 'data-filter-prop="temperature"' })}
    ${slider({ label: "Desfoque", value: filter.blur, min: 0, max: 20, step: .5, data: 'data-filter-prop="blur"', suffix: "px" })}
    <button class="secondary-button" data-action="reset-adjust">Restaurar ajustes</button>`;
}

function renderEffectsInspector() {
  const clip = selectedClip();
  if (!clip) return inspectorHeader("Efeitos", "Efeitos visuais para Shorts, jogos e vídeos cinematográficos.") + '<div class="empty-state">Selecione um clipe.</div>';
  const effect = { preset: "none", intensity: .55, beatSync: false, bpm: 120, ...clip.effect };
  const effects = [
    ["none", "Sem efeito", "Original"],
    ["shake", "Tremor", "Impacto e ação"],
    ["zoomPulse", "Zoom pulse", "Pulso no ritmo"],
    ["gaming", "Gaming", "Tremor + zoom"],
    ["glitch", "Glitch", "Falha digital"],
    ["fire", "Fogo", "Chamas animadas"],
    ["strobe", "Flash", "Luz pulsante"],
    ["vhs", "VHS", "Fita e scanlines"],
    ["stopMotion", "Stop-motion", "Quadros saltados"],
    ["cinematic", "Cinema", "Barras de filme"],
    ["garden", "Jardim", "Brilho orgânico"],
  ];
  return inspectorHeader("Efeitos", escapeHtml(clip.name)) + `
    <div class="effect-grid">${effects.map(([id, name, description]) => `<button class="effect-card ${effect.preset === id ? "active" : ""}" data-effect="${id}"><strong>${name}</strong><small>${description}</small></button>`).join("")}</div>
    <h3>Presets completos</h3>
    <div class="button-grid three">
      <button class="secondary-button" data-style-preset="gaming">🎮 Jogo</button>
      <button class="secondary-button" data-style-preset="cinematic">🎬 Filme</button>
      <button class="secondary-button" data-style-preset="garden">🌿 Jardim</button>
    </div>
    <h3>Controle</h3>
    ${slider({ label: "Intensidade", value: Math.round(effect.intensity * 100), min: 0, max: 100, data: 'data-effect-special="intensity"', suffix: "%" })}
    <label class="switch-row">Sincronizar com batida <input type="checkbox" ${effect.beatSync ? "checked" : ""} data-effect-check="beatSync"></label>
    ${slider({ label: "Batidas por minuto", value: effect.bpm, min: 40, max: 240, data: 'data-effect-prop="bpm"', suffix: " BPM" })}
    <button class="secondary-button" data-action="detect-beat" ${project.audioTracks.length ? "" : "disabled"}>♫ Detectar BPM da primeira música</button>
    <h3>Tempo</h3>
    <label class="switch-row">Reproduzir ao contrário <input type="checkbox" ${clip.reverse ? "checked" : ""} data-clip-check="reverse" ${clip.mediaType === "video" ? "" : "disabled"}></label>
    <p class="inspector-description">Reverso e stop-motion usam busca quadro a quadro e podem exportar mais devagar em vídeos longos.</p>`;
}

function renderTextInspector() {
  const overlay = selectedOverlay();
  const list = project.overlays.map((item) => `<div class="list-item ${item.id === selectedOverlayId ? "selected" : ""}">
    <button class="list-item-main" data-select-overlay="${item.id}"><strong>${escapeHtml(item.text)}</strong><small>${formatTime(item.start)} – ${formatTime(item.end)}</small></button>
    <button class="icon-button" data-delete-overlay="${item.id}" aria-label="Excluir">×</button></div>`).join("");
  return inspectorHeader("Texto", "Títulos, legendas e chamadas sem marca-d’água.") + `
    <button class="primary-button" data-action="add-text">＋ Adicionar texto</button>
    <div class="item-list" style="margin-top:12px">${list || '<div class="empty-state">Nenhum texto adicionado.</div>'}</div>
    ${overlay ? `<h3>Texto selecionado</h3>
      <div class="field"><label>Conteúdo</label><input type="text" value="${escapeHtml(overlay.text)}" data-overlay-prop="text"></div>
      <div class="field-row">
        <div class="field"><label>Início (s)</label><input type="number" min="0" step=".1" value="${overlay.start}" data-overlay-prop="start"></div>
        <div class="field"><label>Fim (s)</label><input type="number" min=".1" step=".1" value="${overlay.end}" data-overlay-prop="end"></div>
      </div>
      ${slider({ label: "Tamanho", value: overlay.size, min: 18, max: 180, data: 'data-overlay-prop="size"', suffix: "px" })}
      ${slider({ label: "Horizontal", value: Math.round(overlay.x * 100), min: 0, max: 100, data: 'data-overlay-special="x"', suffix: "%" })}
      ${slider({ label: "Vertical", value: Math.round(overlay.y * 100), min: 0, max: 100, data: 'data-overlay-special="y"', suffix: "%" })}
      ${slider({ label: "Rotação", value: overlay.rotation, min: -180, max: 180, data: 'data-overlay-prop="rotation"', suffix: "°" })}
      <div class="field-row"><div class="field"><label>Cor</label><input type="color" value="${overlay.color}" data-overlay-prop="color"></div>
      <div class="field"><label>Fundo</label><input type="color" value="${overlay.background === "transparent" ? "#000000" : overlay.background}" data-overlay-prop="background"></div></div>
      <label class="switch-row">Sombra <input type="checkbox" ${overlay.shadow ? "checked" : ""} data-overlay-check="shadow"></label>` : ""}`;
}

function renderStickerInspector() {
  const stickers = ["🔥", "✨", "❤️", "😂", "😎", "💥", "⭐", "🎉", "👀", "✅", "🚀", "🎮", "⚡", "💎", "🏆"];
  return inspectorHeader("Stickers", "Toque em um sticker para colocá-lo na posição atual.") + `<div class="emoji-grid">${stickers.map((emoji) => `<button data-sticker="${emoji}">${emoji}</button>`).join("")}</div>
    <h3>Dica</h3><p class="inspector-description">Depois de adicionar, use a aba Texto para mudar tamanho, posição, rotação e duração.</p>`;
}

function renderAudioInspector() {
  const track = selectedAudio();
  const list = project.audioTracks.map((item) => `<div class="list-item ${item.id === selectedAudioId ? "selected" : ""}">
    <button class="list-item-main" data-select-audio="${item.id}"><strong>♫ ${escapeHtml(item.name)}</strong><small>${formatTime(item.duration)} · volume ${Math.round(item.volume * 100)}%</small></button>
    <button class="icon-button" data-delete-audio="${item.id}" aria-label="Excluir">×</button></div>`).join("");
  return inspectorHeader("Áudio", "Adicione músicas e efeitos armazenados no seu aparelho.") + `
    <button class="primary-button" data-action="add-audio">＋ Importar áudio</button>
    <h3>Músicas gratuitas originais</h3>
    <div class="free-music-grid">${freeTracks.map((item) => `<button class="effect-card" data-free-track="${item.id}"><strong>♫ ${escapeHtml(item.name)}</strong><small>${item.bpm} BPM · loop livre</small></button>`).join("")}</div>
    <h3>Link direto autorizado</h3>
    <div class="field"><input id="music-url" type="text" placeholder="https://site.com/musica.mp3"></div>
    <button class="secondary-button" data-action="add-audio-url">Adicionar link .mp3/.wav</button>
    <p class="inspector-description" style="margin-top:8px">Links do YouTube não são extraídos. Baixe faixas permitidas pela Biblioteca de Áudio do YouTube ou pelo autor e importe o arquivo.</p>
    <div class="item-list" style="margin-top:12px">${list || '<div class="empty-state">Nenhuma faixa de áudio.</div>'}</div>
    ${track ? `<h3>Faixa selecionada</h3>
      ${slider({ label: "Volume", value: Math.round(track.volume * 100), min: 0, max: 200, data: 'data-audio-special="volume"', suffix: "%" })}
      ${slider({ label: "Início no vídeo", value: track.start, min: 0, max: Math.max(projectDuration(project), 1), step: .1, data: 'data-audio-prop="start"', suffix: "s" })}
      ${slider({ label: "Cortar início", value: track.trimStart, min: 0, max: Math.max(track.duration - .1, .1), step: .1, data: 'data-audio-prop="trimStart"', suffix: "s" })}
      <label class="switch-row">Repetir áudio <input type="checkbox" ${track.loop ? "checked" : ""} data-audio-check="loop"></label>` : ""}`;
}

function renderAiInspector() {
  const suggestions = smartSuggestions(project);
  return inspectorHeader("Assistente inteligente", "Montagem automática e ajuda contextual executadas no aparelho, sem assinatura e sem enviar seus arquivos para servidores.") + `
    <div class="ai-card">
      <strong>✦ Descreva o resultado</strong>
      <textarea id="ai-prompt" rows="5" placeholder="Ex.: Faça um vídeo rápido para Reels, título: Minha viagem">${escapeHtml(aiPrompt)}</textarea>
      <div class="ai-reference-row">
        <button class="secondary-button" data-action="choose-ai-references">＋ Fotos e vídeos</button>
        <span>${aiReferenceFiles.length ? `${aiReferenceFiles.length} referência${aiReferenceFiles.length === 1 ? "" : "s"} pronta${aiReferenceFiles.length === 1 ? "" : "s"}` : "Use o projeto atual ou adicione referências"}</span>
      </div>
      <button class="primary-button" style="width:100%;height:48px" data-action="run-ai">✦ Montar com assistência</button>
    </div>
    <h3>Sugestões para este projeto</h3>
    <div class="item-list">${suggestions.map((suggestion) => `<button class="list-item list-item-main ai-suggestion" data-ai-command="${escapeHtml(suggestion.command)}"><strong>${escapeHtml(suggestion.title)}</strong><small>${escapeHtml(suggestion.command)}</small></button>`).join("")}</div>
    <p class="inspector-description" style="margin-top:14px">Esta versão usa análise inteligente offline de ritmo, formato e estilo. Geração criativa por modelos externos poderá ser conectada depois, mas exigiria um serviço de IA e possivelmente custos do provedor.</p>`;
}

function renderFormatInspector() {
  const ratios = ["9:16", "16:9", "1:1", "4:5", "4:3"];
  return inspectorHeader("Formato", "Escolha o enquadramento para redes sociais ou tela cheia.") + `
    <div class="ratio-grid">${ratios.map((ratio) => `<button class="ratio-card ${project.aspectRatio === ratio ? "active" : ""}" data-ratio="${ratio}">${ratio}</button>`).join("")}</div>
    <h3>Fundo</h3><div class="field"><input type="color" value="${project.background}" data-project-prop="background"></div>
    <h3>Projeto</h3>
    <div class="button-grid">
      <button class="secondary-button" data-action="download-project">Baixar projeto</button>
      <button class="secondary-button" data-action="open-project">Abrir projeto</button>
      <button class="danger-button" data-action="new-project">Novo projeto</button>
    </div>`;
}

function renderExportInspector() {
  const duration = projectDuration(project);
  const capability = exportCapability();
  const resolutions = ["480p", "720p", "1080p", "1440p", "4K", "8K"];
  const frameRates = [24, 30, 60, 120, 144];
  return inspectorHeader("Exportar", "O vídeo é processado neste aparelho; seus arquivos não são enviados para servidores.") + `
    <div class="export-card"><strong>${escapeHtml(project.name)}</strong><small>${project.aspectRatio} · ${project.fps} fps · ${formatTime(duration)}<br>Sem assinatura e sem marca-d’água.</small></div>
    <div class="field"><label>Resolução</label><div class="button-grid three export-options">
      ${resolutions.map((quality) => `<button data-quality="${quality}" class="secondary-button ${exportQuality === quality ? "active" : ""}">${quality === "1440p" ? "2K (1440p)" : quality}${quality === "8K" ? " · EXP" : ""}</button>`).join("")}
    </div></div>
    <div class="field"><label>Quadros por segundo</label><div class="button-grid three export-options">
      ${frameRates.map((fps) => `<button data-fps="${fps}" class="secondary-button ${project.fps === fps ? "active" : ""}">${fps} fps${fps > 60 ? " · EXP" : ""}</button>`).join("")}
    </div></div>
    <div class="field"><label>Destino</label><div class="segmented">
      <button data-export-destination="share" class="${exportDestination === "share" ? "active" : ""}">Galeria / compartilhar</button>
      <button data-export-destination="download" class="${exportDestination === "download" ? "active" : ""}">Baixar arquivo</button>
    </div></div>
    <div class="export-capability ${capability.safe ? "safe" : "warning"}">
      <strong>${capability.safe ? "✓ Configuração recomendada" : "⚠ Configuração extrema"}</strong>
      <small>Estimativa para este aparelho: até ${capability.recommended}; não garante compatibilidade. Estimativa do arquivo: ${estimatedExportSize()} MB.</small>
    </div>
    ${capability.safe ? "" : `<label class="switch-row experimental-switch">Permitir modo experimental <input type="checkbox" ${exportExperimental ? "checked" : ""} data-export-experimental></label>`}
    <button class="primary-button" style="width:100%;height:48px" data-action="export" ${project.clips.length && capability.allowed ? "" : "disabled"}>Exportar ${exportQuality} · ${project.fps} fps</button>
    <p class="inspector-description" style="margin-top:12px">A resolução e os fps reais dependem do codificador, da memória e do desempenho do aparelho. Em especial, 120 fps e opções superiores são experimentais e podem gerar menos quadros ou falhar. O modo experimental permite tentar configurações acima da estimativa.</p>`;
}

function renderInspector() {
  const renderers = {
    edit: renderEditInspector,
    adjust: renderAdjustInspector,
    effects: renderEffectsInspector,
    text: renderTextInspector,
    stickers: renderStickerInspector,
    audio: renderAudioInspector,
    ai: renderAiInspector,
    format: renderFormatInspector,
    export: renderExportInspector,
  };
  elements.inspector.innerHTML = renderers[activeTool]();
}

function renderAll() {
  elements.projectName.value = project.name;
  elements.previewStage.className = `preview-stage ratio-${project.aspectRatio.replace(":", "-")}`;
  $("#undo").disabled = history.past.length === 0;
  $("#redo").disabled = history.future.length === 0;
  renderTimeline();
  renderInspector();
  renderPreview(true);
}

async function updateBackgroundAudio() {
  for (const track of project.audioTracks) {
    let audio = audioElements.get(track.id);
    if (!audio) {
      try {
        audio = new Audio(await mediaStore.getUrl(track.sourceId));
        audio.preload = "auto";
        audio.playsInline = true;
        audioElements.set(track.id, audio);
      } catch { continue; }
    }
    const local = currentTime - track.start + track.trimStart;
    const available = track.duration - track.trimStart;
    const active = local >= track.trimStart && (track.loop || local < track.duration) && available > 0;
    if (!active || !playing) {
      audio.pause();
      continue;
    }
    const target = track.loop ? track.trimStart + ((local - track.trimStart) % available) : local;
    audio.loop = false;
    audio.volume = Math.min(1, track.volume);
    if (Math.abs(audio.currentTime - target) > .35) audio.currentTime = target;
    audio.play().catch(() => {});
  }
}

function pause() {
  playing = false;
  elements.play.textContent = "▶";
  elements.play.classList.remove("playing");
  renderer.pauseAll();
  for (const audio of audioElements.values()) audio.pause();
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  renderPreview(true);
}

function playbackTick(timestamp) {
  if (!playing) return;
  const delta = Math.min(.1, (timestamp - lastFrameAt) / 1000);
  lastFrameAt = timestamp;
  currentTime += delta;
  if (currentTime >= projectDuration(project)) {
    currentTime = projectDuration(project);
    pause();
    updateTimeUi();
    return;
  }
  updateTimeUi();
  renderPreview();
  updateBackgroundAudio();
  animationFrame = requestAnimationFrame(playbackTick);
}

function togglePlay() {
  if (!project.clips.length) {
    elements.mediaInput.click();
    return;
  }
  if (playing) { pause(); return; }
  if (currentTime >= projectDuration(project)) currentTime = 0;
  playing = true;
  elements.play.textContent = "❚❚";
  elements.play.classList.add("playing");
  lastFrameAt = performance.now();
  renderPreview();
  updateBackgroundAudio();
  animationFrame = requestAnimationFrame(playbackTick);
}

function seekTo(time) {
  currentTime = clamp(time, 0, projectDuration(project));
  updateTimeUi();
  renderPreview();
  updateBackgroundAudio();
}

async function importMedia(files) {
  if (!files.length) return;
  toast(`Importando ${files.length} arquivo${files.length > 1 ? "s" : ""}…`);
  let next = project;
  try {
    for (const file of files) {
      const source = await mediaStore.addFile(file);
      const clip = createClip({ sourceId: source.id, name: source.name, mediaType: source.mediaType, duration: source.duration });
      next = addClip(next, clip);
      selectedClipId = clip.id;
    }
    commit(next, "Mídia adicionada");
  } catch (error) {
    toast(error.message || "Falha ao importar mídia", true);
  }
  elements.mediaInput.value = "";
}

async function importAudio(files) {
  if (!files.length) return;
  let next = project;
  try {
    for (const file of files) {
      const source = await mediaStore.addFile(file);
      next = addAudioTrack(next, { sourceId: source.id, name: source.name, duration: source.duration, start: currentTime });
      selectedAudioId = next.audioTracks.at(-1).id;
    }
    commit(next, "Áudio adicionado");
  } catch (error) {
    toast(error.message || "Falha ao importar áudio", true);
  }
  elements.audioInput.value = "";
}

async function addFreeTrack(trackId) {
  try {
    toast("Criando música original no aparelho…");
    const generated = createProceduralTrack(trackId);
    const file = new File([generated.blob], `${generated.name}.wav`, { type: "audio/wav" });
    const source = await mediaStore.addFile(file, { mediaType: "audio", duration: generated.duration, width: 0, height: 0 });
    const next = addAudioTrack(project, {
      sourceId: source.id,
      name: generated.name,
      duration: generated.duration,
      start: currentTime,
      loop: true,
    });
    selectedAudioId = next.audioTracks.at(-1).id;
    commit(next, `${generated.name} adicionada`);
  } catch (error) {
    toast(error.message || "Não foi possível criar a música.", true);
  }
}

async function addAudioFromUrl() {
  const input = $("#music-url");
  const value = input?.value.trim();
  if (!value) return;
  if (/youtu(?:\.be|be\.com)/i.test(value)) {
    toast("Use uma faixa baixada legalmente da Biblioteca de Áudio do YouTube.", true);
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("Use um link HTTPS direto para .mp3, .wav, .m4a ou .ogg.");
    toast("Baixando áudio autorizado…");
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`O servidor respondeu ${response.status}.`);
    const blob = await response.blob();
    if (!blob.type.startsWith("audio/") && !/\.(mp3|wav|m4a|ogg)(?:\?|$)/i.test(url.pathname)) throw new Error("O endereço não aponta para um arquivo de áudio direto.");
    if (blob.size > 150 * 1024 * 1024) throw new Error("O áudio ultrapassa o limite de 150 MB para importação por link.");
    const filename = decodeURIComponent(url.pathname.split("/").pop() || "audio-importado.mp3");
    await importAudio([new File([blob], filename, { type: blob.type || "audio/mpeg" })]);
  } catch (error) {
    toast(error.message || "Não foi possível importar esse link. O servidor precisa permitir acesso CORS.", true);
  }
}

async function detectSelectedBeat() {
  const clip = selectedClip();
  const track = project.audioTracks[0];
  if (!clip || !track) return;
  try {
    toast("Analisando batidas no aparelho…");
    const source = await mediaStore.get(track.sourceId);
    const bpm = await estimateBpm(source.blob);
    commit(updateClip(project, clip.id, { effect: { beatSync: true, bpm } }), `Batida detectada: ${bpm} BPM`);
  } catch (error) {
    toast(error.message || "Não foi possível analisar essa música.", true);
  }
}

async function runSmartAssistant() {
  const promptInput = $("#ai-prompt");
  aiPrompt = promptInput?.value.trim() || aiPrompt;
  let next = project;
  try {
    if (aiReferenceFiles.length) {
      toast(`Analisando ${aiReferenceFiles.length} referência${aiReferenceFiles.length === 1 ? "" : "s"}…`);
      for (const file of aiReferenceFiles) {
        const source = await mediaStore.addFile(file);
        next = addClip(next, createClip({
          sourceId: source.id,
          name: source.name,
          mediaType: source.mediaType,
          duration: source.duration,
        }));
      }
    }
    if (!next.clips.length) {
      toast("Adicione fotos ou vídeos de referência para a montagem.", true);
      return;
    }
    const result = applySmartEdit(next, aiPrompt);
    selectedClipId = result.project.clips[0]?.id ?? null;
    aiReferenceFiles = [];
    commit(result.project, result.summary);
  } catch (error) {
    toast(error.message || "Não foi possível concluir a montagem inteligente.", true);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
}

async function deliverExport(blob, filename, destination = "share") {
  const file = new File([blob], filename, { type: blob.type, lastModified: Date.now() });
  if (destination === "share" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: filename,
        text: "Vídeo criado no LumeCut",
      });
      return "shared";
    } catch (error) {
      if (error.name === "AbortError") return "cancelled";
    }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}

function safeName() {
  return (project.name || "video").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
}

async function runExport() {
  if (!project.clips.length || exportController) return;
  const capability = exportCapability();
  if (!capability.allowed) {
    selectTool("export");
    toast(`Use até ${capability.recommended} ou ative o modo experimental.`, true);
    return;
  }
  pause();
  exportController = new AbortController();
  elements.exportModal.hidden = false;
  elements.exportProgress.value = 0;
  elements.exportStatus.textContent = `Preparando ${exportQuality} a ${project.fps} fps…`;
  try {
    const result = await exportProject({
      project,
      mediaStore,
      quality: exportQuality,
      signal: exportController.signal,
      onProgress: (progress) => {
        elements.exportProgress.value = progress;
        elements.exportStatus.textContent = `${Math.round(progress * 100)}% · mantenha o app aberto`;
      },
    });
    const filename = `${safeName()}.${result.extension}`;
    const delivery = await deliverExport(result.blob, filename, exportDestination);
    if (delivery === "cancelled") toast("Vídeo criado; compartilhamento cancelado.");
    else toast(delivery === "shared" ? "Vídeo pronto para compartilhar" : "Vídeo exportado com sucesso");
  } catch (error) {
    if (error.name !== "AbortError") toast(error.message || "Falha na exportação", true);
  } finally {
    exportController = null;
    elements.exportModal.hidden = true;
  }
}

function selectTool(tool) {
  activeTool = tool;
  $$(".tool-tab").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
  renderInspector();
  if (window.innerWidth <= 850) $(".tools-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function selectClip(id) {
  selectedClipId = id;
  selectedOverlayId = null;
  selectedAudioId = null;
  const entry = timeline(project).find((item) => item.clip.id === id);
  if (entry) seekTo(entry.start);
  renderTimeline();
  renderInspector();
}

function selectOverlay(id) {
  selectedOverlayId = id;
  selectedClipId = null;
  selectedAudioId = null;
  const overlay = selectedOverlay();
  if (overlay) seekTo(overlay.start);
  activeTool = "text";
  $$(".tool-tab").forEach((button) => button.classList.toggle("active", button.dataset.tool === "text"));
  renderTimeline();
  renderInspector();
}

function selectAudio(id) {
  selectedAudioId = id;
  selectedClipId = null;
  selectedOverlayId = null;
  const track = selectedAudio();
  if (track) seekTo(track.start);
  activeTool = "audio";
  $$(".tool-tab").forEach((button) => button.classList.toggle("active", button.dataset.tool === "audio"));
  renderTimeline();
  renderInspector();
}

function applyStylePreset(presetId) {
  const clip = selectedClip();
  if (!clip) return;
  const presets = {
    gaming: {
      effect: { preset: "gaming", intensity: .72, beatSync: true, bpm: 128 },
      filter: { brightness: 104, contrast: 116, saturation: 124, temperature: -3, blur: 0 },
    },
    cinematic: {
      effect: { preset: "cinematic", intensity: .72, beatSync: false, bpm: 96 },
      filter: { brightness: 96, contrast: 118, saturation: 88, temperature: 12, blur: 0 },
    },
    garden: {
      effect: { preset: "garden", intensity: .58, beatSync: false, bpm: 84 },
      filter: { brightness: 108, contrast: 96, saturation: 112, temperature: 9, blur: 0 },
    },
  };
  const preset = presets[presetId];
  if (preset) commit(updateClip(project, clip.id, preset), "Preset aplicado");
}

async function handleAction(action) {
  const clip = selectedClip();
  if (action === "split") {
    const next = splitClip(project, currentTime);
    if (next === project) toast("Posicione o cursor dentro de um clipe.", true);
    else commit(next, "Clipe dividido");
  } else if (action === "duplicate" && clip) {
    commit(duplicateClip(project, clip.id), "Clipe duplicado");
  } else if (action === "delete-clip" && clip) {
    commit(removeClip(project, clip.id), "Clipe excluído");
  } else if (action === "move-left" && clip) {
    commit(moveClip(project, clip.id, -1));
  } else if (action === "move-right" && clip) {
    commit(moveClip(project, clip.id, 1));
  } else if (action === "rotate" && clip) {
    commit(updateClip(project, clip.id, { rotation: (clip.rotation + 90) % 360 }));
  } else if (action === "flip-x" && clip) {
    commit(updateClip(project, clip.id, { flipX: !clip.flipX }));
  } else if (action === "flip-y" && clip) {
    commit(updateClip(project, clip.id, { flipY: !clip.flipY }));
  } else if (action === "reset-adjust" && clip) {
    commit(updateClip(project, clip.id, { filter: { brightness: 100, contrast: 100, saturation: 100, temperature: 0, blur: 0 } }), "Ajustes restaurados");
  } else if (action === "add-text") {
    const next = addOverlay(project, { start: currentTime, end: Math.min(projectDuration(project), currentTime + 3) || 3 });
    selectedOverlayId = next.overlays.at(-1).id;
    commit(next, "Texto adicionado");
  } else if (action === "add-audio") {
    elements.audioInput.click();
  } else if (action === "add-audio-url") {
    await addAudioFromUrl();
  } else if (action === "detect-beat") {
    await detectSelectedBeat();
  } else if (action === "choose-ai-references") {
    elements.aiReferenceInput.click();
  } else if (action === "run-ai") {
    await runSmartAssistant();
  } else if (action === "download-project") {
    downloadBlob(new Blob([serializeProject(project)], { type: "application/json" }), `${safeName()}.lumecut`);
  } else if (action === "open-project") {
    elements.projectInput.click();
  } else if (action === "new-project") {
    if (confirm("Criar um projeto novo? O projeto atual continuará salvo no arquivo se você já o baixou.")) replaceProject(createProject());
  } else if (action === "export") {
    runExport();
  }
}

elements.inspector.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.action) handleAction(target.dataset.action);
  if (target.dataset.selectOverlay) selectOverlay(target.dataset.selectOverlay);
  if (target.dataset.selectAudio) selectAudio(target.dataset.selectAudio);
  if (target.dataset.deleteOverlay) commit(removeOverlay(project, target.dataset.deleteOverlay), "Texto excluído");
  if (target.dataset.deleteAudio) commit(removeAudioTrack(project, target.dataset.deleteAudio), "Áudio excluído");
  if (target.dataset.sticker) {
    const next = addOverlay(project, { text: target.dataset.sticker, start: currentTime, end: Math.min(projectDuration(project), currentTime + 3) || 3, size: 110, shadow: true });
    selectedOverlayId = next.overlays.at(-1).id;
    commit(next, "Sticker adicionado");
  }
  if (target.dataset.freeTrack) addFreeTrack(target.dataset.freeTrack);
  if (target.dataset.effect) {
    const clip = selectedClip();
    if (clip) commit(updateClip(project, clip.id, { effect: { preset: target.dataset.effect } }));
  }
  if (target.dataset.stylePreset) applyStylePreset(target.dataset.stylePreset);
  if (target.dataset.ratio) commit(setAspectRatio(project, target.dataset.ratio));
  if (target.dataset.quality) { exportQuality = target.dataset.quality; renderInspector(); }
  if (target.dataset.fps) { commit({ ...project, fps: Number(target.dataset.fps) }); }
  if (target.dataset.exportDestination) { exportDestination = target.dataset.exportDestination; renderInspector(); }
  if (target.dataset.aiCommand) {
    aiPrompt = target.dataset.aiCommand;
    renderInspector();
  }
  if (target.dataset.clipValue) {
    const [property, value] = target.dataset.clipValue.split(":");
    const clip = selectedClip();
    if (clip) commit(updateClip(project, clip.id, { [property]: value }));
  }
});

elements.inspector.addEventListener("change", (event) => {
  const input = event.target;
  const clip = selectedClip();
  const overlay = selectedOverlay();
  const audio = selectedAudio();
  if (input.dataset.clipProp && clip) commit(updateClip(project, clip.id, { [input.dataset.clipProp]: numberValue(input) }));
  if (input.dataset.clipSpecial === "volume" && clip) commit(updateClip(project, clip.id, { volume: numberValue(input) / 100 }));
  if (input.dataset.clipSpecial === "offsetX" && clip) commit(updateClip(project, clip.id, { offsetX: numberValue(input) / 100 }));
  if (input.dataset.clipSpecial === "offsetY" && clip) commit(updateClip(project, clip.id, { offsetY: numberValue(input) / 100 }));
  if (input.dataset.clipSpecial === "opacity" && clip) commit(updateClip(project, clip.id, { opacity: numberValue(input) / 100 }));
  if (input.dataset.clipCheck && clip) commit(updateClip(project, clip.id, { [input.dataset.clipCheck]: input.checked }));
  if (input.dataset.filterProp && clip) commit(updateClip(project, clip.id, { filter: { [input.dataset.filterProp]: numberValue(input) } }));
  if (input.dataset.effectProp && clip) commit(updateClip(project, clip.id, { effect: { [input.dataset.effectProp]: numberValue(input) } }));
  if (input.dataset.effectSpecial === "intensity" && clip) commit(updateClip(project, clip.id, { effect: { intensity: numberValue(input) / 100 } }));
  if (input.dataset.effectCheck && clip) commit(updateClip(project, clip.id, { effect: { [input.dataset.effectCheck]: input.checked } }));
  if (input.dataset.transitionProp && clip) commit(updateClip(project, clip.id, { transition: { [input.dataset.transitionProp]: numberValue(input) } }));
  if (input.dataset.overlayProp && overlay) {
    const value = input.type === "text" || input.type === "color" ? input.value : numberValue(input);
    commit(updateOverlay(project, overlay.id, { [input.dataset.overlayProp]: value }));
  }
  if (input.dataset.overlaySpecial && overlay) commit(updateOverlay(project, overlay.id, { [input.dataset.overlaySpecial]: numberValue(input) / 100 }));
  if (input.dataset.overlayCheck && overlay) commit(updateOverlay(project, overlay.id, { [input.dataset.overlayCheck]: input.checked }));
  if (input.dataset.audioProp && audio) commit(updateAudioTrack(project, audio.id, { [input.dataset.audioProp]: numberValue(input) }));
  if (input.dataset.audioSpecial === "volume" && audio) commit(updateAudioTrack(project, audio.id, { volume: numberValue(input) / 100 }));
  if (input.dataset.audioCheck && audio) commit(updateAudioTrack(project, audio.id, { [input.dataset.audioCheck]: input.checked }));
  if (input.dataset.projectProp) {
    const value = input.dataset.projectProp === "fps" ? numberValue(input) : input.value;
    commit({ ...project, [input.dataset.projectProp]: value });
  }
  if (input.hasAttribute("data-export-experimental")) {
    exportExperimental = input.checked;
    renderInspector();
  }
});

elements.inspector.addEventListener("input", (event) => {
  const label = event.target.closest(".field")?.querySelector(".field-label span");
  if (label && event.target.type === "range") {
    const suffix = label.textContent.replace(/[-\d.]/g, "");
    label.textContent = `${event.target.value}${suffix}`;
  }
});

elements.timelineContent.addEventListener("click", (event) => {
  const clipButton = event.target.closest("[data-select-clip]");
  const overlayButton = event.target.closest("[data-select-overlay]");
  const audioButton = event.target.closest("[data-select-audio]");
  if (clipButton) { selectClip(clipButton.dataset.selectClip); return; }
  if (overlayButton) { selectOverlay(overlayButton.dataset.selectOverlay); return; }
  if (audioButton) { selectAudio(audioButton.dataset.selectAudio); return; }
  const bounds = elements.timelineContent.getBoundingClientRect();
  seekTo((event.clientX - bounds.left - 52) / PX_PER_SECOND);
});

$("#tool-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tool]");
  if (button) selectTool(button.dataset.tool);
});

elements.mediaInput.addEventListener("change", () => importMedia([...elements.mediaInput.files]));
elements.audioInput.addEventListener("change", () => importAudio([...elements.audioInput.files]));
elements.aiReferenceInput.addEventListener("change", () => {
  aiReferenceFiles = [...elements.aiReferenceInput.files];
  elements.aiReferenceInput.value = "";
  renderInspector();
  toast(`${aiReferenceFiles.length} referência${aiReferenceFiles.length === 1 ? "" : "s"} pronta${aiReferenceFiles.length === 1 ? "" : "s"} para a montagem`);
});
elements.projectInput.addEventListener("change", async () => {
  const file = elements.projectInput.files[0];
  if (!file) return;
  try {
    replaceProject(parseProject(await file.text()));
    toast("Projeto aberto");
  } catch (error) {
    toast(error.message || "Projeto inválido", true);
  }
  elements.projectInput.value = "";
});

elements.projectName.addEventListener("change", () => commit({ ...project, name: elements.projectName.value.trim() || "Meu vídeo" }));
elements.play.addEventListener("click", togglePlay);
elements.previous.addEventListener("click", () => seekTo(currentTime - 1));
elements.next.addEventListener("click", () => seekTo(currentTime + 1));
$("#add-media").addEventListener("click", () => elements.mediaInput.click());
elements.emptyImport.addEventListener("click", () => elements.mediaInput.click());
$("#split").addEventListener("click", () => handleAction("split"));
$("#undo").addEventListener("click", () => { project = history.undo(); renderAll(); scheduleSave(); });
$("#redo").addEventListener("click", () => { project = history.redo(); renderAll(); scheduleSave(); });
$("#save-project").addEventListener("click", () => handleAction("download-project"));
$("#quick-export").addEventListener("click", () => { selectTool("export"); if (project.clips.length) runExport(); });
$("#cancel-export").addEventListener("click", () => exportController?.abort());
$("#fullscreen").addEventListener("click", () => elements.previewStage.requestFullscreen?.());

document.addEventListener("keydown", (event) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (event.code === "Space") { event.preventDefault(); togglePlay(); }
  if (event.key === "ArrowLeft") seekTo(currentTime - (event.shiftKey ? 1 : .1));
  if (event.key === "ArrowRight") seekTo(currentTime + (event.shiftKey ? 1 : .1));
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    project = event.shiftKey ? history.redo() : history.undo();
    renderAll();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && playing) pause();
});

window.addEventListener("beforeunload", () => mediaStore.dispose());
window.addEventListener("resize", renderTimeline);

async function boot() {
  try {
    const saved = await mediaStore.loadProject();
    if (saved) {
      project = saved;
      history = new HistoryStore(project);
      selectedClipId = project.clips[0]?.id ?? null;
    }
  } catch (error) {
    console.warn("Projeto salvo não pôde ser aberto", error);
  }
  renderAll();
  const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
  if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !isNative) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

boot();
