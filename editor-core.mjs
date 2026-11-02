const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));

export const createId = (prefix = "item") => {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
};

export const createProject = (overrides = {}) => ({
  version: 1,
  id: createId("project"),
  name: "Meu vídeo",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  aspectRatio: "9:16",
  width: 1080,
  height: 1920,
  fps: 30,
  background: "#050507",
  clips: [],
  overlays: [],
  audioTracks: [],
  ...overrides,
});

export const createClip = ({ sourceId, name, mediaType = "video", duration, ...overrides }) => {
  const safeDuration = Math.max(0.1, Number(duration) || 5);
  return {
    id: createId("clip"),
    sourceId,
    name: name || "Clipe",
    mediaType,
    duration: safeDuration,
    trimStart: 0,
    trimEnd: safeDuration,
    speed: 1,
    volume: 1,
    rotation: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    opacity: 1,
    flipX: false,
    flipY: false,
    reverse: false,
    fit: "contain",
    filter: {
      brightness: 100,
      contrast: 100,
      saturation: 100,
      temperature: 0,
      blur: 0,
    },
    transition: { type: "fade", duration: 0 },
    effect: { preset: "none", intensity: 0.55, beatSync: false, bpm: 120 },
    ...overrides,
  };
};

export const clipTimelineDuration = (clip) => {
  const sourceDuration = Math.max(0, Number(clip.trimEnd) - Number(clip.trimStart));
  return sourceDuration / Math.max(0.1, Number(clip.speed) || 1);
};

export const timeline = (project) => {
  let cursor = 0;
  return project.clips.map((clip, index) => {
    const duration = clipTimelineDuration(clip);
    const entry = { clip, index, start: cursor, end: cursor + duration, duration };
    cursor += duration;
    return entry;
  });
};

export const projectDuration = (project) => timeline(project).at(-1)?.end ?? 0;

export const locateAtTime = (project, time) => {
  const entries = timeline(project);
  if (!entries.length) return null;
  const safeTime = clamp(time, 0, projectDuration(project));
  const entry = entries.find((item) => safeTime >= item.start && safeTime < item.end) ?? entries.at(-1);
  const localTimelineTime = clamp(safeTime - entry.start, 0, entry.duration);
  return {
    ...entry,
    localTimelineTime,
    sourceTime: entry.clip.trimStart + localTimelineTime * entry.clip.speed,
  };
};

const stamp = (project) => ({ ...project, updatedAt: new Date().toISOString() });

export const addClip = (project, clip, index = project.clips.length) => {
  const clips = [...project.clips];
  clips.splice(clamp(index, 0, clips.length), 0, clip);
  return stamp({ ...project, clips });
};

export const updateClip = (project, clipId, updates) => stamp({
  ...project,
  clips: project.clips.map((clip) => {
    if (clip.id !== clipId) return clip;
    const next = {
      ...clip,
      ...updates,
      filter: updates.filter ? { ...clip.filter, ...updates.filter } : clip.filter,
      transition: updates.transition ? { ...clip.transition, ...updates.transition } : clip.transition,
      effect: updates.effect
        ? { preset: "none", intensity: 0.55, beatSync: false, bpm: 120, ...clip.effect, ...updates.effect }
        : { preset: "none", intensity: 0.55, beatSync: false, bpm: 120, ...clip.effect },
    };
    next.trimStart = clamp(next.trimStart, 0, Math.max(0, next.duration - 0.05));
    next.trimEnd = clamp(next.trimEnd, next.trimStart + 0.05, next.duration);
    next.speed = clamp(next.speed, 0.1, 8);
    next.volume = clamp(next.volume, 0, 2);
    next.scale = clamp(next.scale, 0.25, 4);
    next.offsetX = clamp(next.offsetX, -1, 1);
    next.offsetY = clamp(next.offsetY, -1, 1);
    next.opacity = clamp(next.opacity, 0, 1);
    next.effect.intensity = clamp(next.effect.intensity, 0, 1);
    next.effect.bpm = clamp(next.effect.bpm, 40, 240);
    return next;
  }),
});

export const removeClip = (project, clipId) => stamp({
  ...project,
  clips: project.clips.filter((clip) => clip.id !== clipId),
});

export const moveClip = (project, clipId, direction) => {
  const clips = [...project.clips];
  const index = clips.findIndex((clip) => clip.id === clipId);
  const target = clamp(index + direction, 0, clips.length - 1);
  if (index < 0 || index === target) return project;
  [clips[index], clips[target]] = [clips[target], clips[index]];
  return stamp({ ...project, clips });
};

export const duplicateClip = (project, clipId) => {
  const index = project.clips.findIndex((clip) => clip.id === clipId);
  if (index < 0) return project;
  const original = project.clips[index];
  const copy = { ...structuredClone(original), id: createId("clip"), name: `${original.name} cópia` };
  return addClip(project, copy, index + 1);
};

export const splitClip = (project, projectTime) => {
  const located = locateAtTime(project, projectTime);
  if (!located || located.localTimelineTime < 0.05 || located.duration - located.localTimelineTime < 0.05) {
    return project;
  }
  const sourceSplit = located.sourceTime;
  const first = { ...structuredClone(located.clip), trimEnd: sourceSplit };
  const second = { ...structuredClone(located.clip), id: createId("clip"), trimStart: sourceSplit, name: `${located.clip.name} (2)` };
  const clips = [...project.clips];
  clips.splice(located.index, 1, first, second);
  return stamp({ ...project, clips });
};

export const addOverlay = (project, overlay) => stamp({
  ...project,
  overlays: [...project.overlays, {
    id: createId("overlay"),
    type: "text",
    text: "Novo texto",
    start: 0,
    end: Math.max(3, projectDuration(project)),
    x: 0.5,
    y: 0.5,
    size: 64,
    color: "#ffffff",
    background: "transparent",
    font: "system-ui",
    weight: 800,
    rotation: 0,
    opacity: 1,
    shadow: true,
    ...overlay,
  }],
});

export const updateOverlay = (project, overlayId, updates) => stamp({
  ...project,
  overlays: project.overlays.map((overlay) => overlay.id === overlayId ? { ...overlay, ...updates } : overlay),
});

export const removeOverlay = (project, overlayId) => stamp({
  ...project,
  overlays: project.overlays.filter((overlay) => overlay.id !== overlayId),
});

export const addAudioTrack = (project, track) => stamp({
  ...project,
  audioTracks: [...project.audioTracks, {
    id: createId("audio"),
    sourceId: track.sourceId,
    name: track.name || "Áudio",
    duration: Number(track.duration) || 0,
    start: 0,
    trimStart: 0,
    volume: 0.8,
    loop: false,
    ...track,
  }],
});

export const updateAudioTrack = (project, trackId, updates) => stamp({
  ...project,
  audioTracks: project.audioTracks.map((track) => track.id === trackId ? { ...track, ...updates } : track),
});

export const removeAudioTrack = (project, trackId) => stamp({
  ...project,
  audioTracks: project.audioTracks.filter((track) => track.id !== trackId),
});

export const setAspectRatio = (project, ratio) => {
  const dimensions = {
    "9:16": [1080, 1920],
    "16:9": [1920, 1080],
    "1:1": [1080, 1080],
    "4:5": [1080, 1350],
    "4:3": [1440, 1080],
  };
  const [width, height] = dimensions[ratio] ?? dimensions["9:16"];
  return stamp({ ...project, aspectRatio: ratio, width, height });
};

export const serializeProject = (project) => JSON.stringify(project, null, 2);

export const parseProject = (json) => {
  const parsed = JSON.parse(json);
  if (!parsed || !Array.isArray(parsed.clips) || !Array.isArray(parsed.overlays)) {
    throw new Error("Projeto inválido");
  }
  return createProject(parsed);
};

export class HistoryStore {
  constructor(initialState, limit = 60) {
    this.present = structuredClone(initialState);
    this.past = [];
    this.future = [];
    this.limit = limit;
  }

  commit(nextState) {
    if (JSON.stringify(nextState) === JSON.stringify(this.present)) return this.present;
    this.past.push(structuredClone(this.present));
    if (this.past.length > this.limit) this.past.shift();
    this.present = structuredClone(nextState);
    this.future = [];
    return this.present;
  }

  undo() {
    if (!this.past.length) return this.present;
    this.future.unshift(structuredClone(this.present));
    this.present = this.past.pop();
    return structuredClone(this.present);
  }

  redo() {
    if (!this.future.length) return this.present;
    this.past.push(structuredClone(this.present));
    this.present = this.future.shift();
    return structuredClone(this.present);
  }
}

export const formatTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenths}`;
};
