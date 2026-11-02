import { addOverlay, projectDuration, setAspectRatio } from "./editor-core.mjs";

const has = (text, words) => words.some((word) => text.includes(word));

export const analyzePrompt = (prompt = "") => {
  const text = prompt.toLocaleLowerCase("pt-BR");
  const titleMatch = prompt.match(/(?:t[ií]tulo|texto)\s*:\s*([^\n,;]+)/i);
  let aspectRatio = null;
  if (has(text, ["tiktok", "reels", "shorts", "vertical", "story", "stories"])) aspectRatio = "9:16";
  else if (has(text, ["youtube", "horizontal", "paisagem", "cinema"])) aspectRatio = "16:9";
  else if (has(text, ["quadrado", "instagram feed", "1:1"])) aspectRatio = "1:1";

  let style = "balanced";
  if (has(text, ["rápido", "rapido", "dinâmico", "dinamico", "energético", "energetico", "ação", "acao"])) style = "dynamic";
  else if (has(text, ["cinematográfico", "cinematografico", "filme", "dramático", "dramatico", "elegante"])) style = "cinematic";
  else if (has(text, ["suave", "calmo", "romântico", "romantico", "lento"])) style = "soft";
  else if (has(text, ["limpo", "minimalista", "profissional", "produto"])) style = "clean";

  let effectPreset = "none";
  if (has(text, ["jogo", "gaming", "gameplay"])) effectPreset = "gaming";
  else if (has(text, ["fogo", "chama", "incêndio", "incendio"])) effectPreset = "fire";
  else if (has(text, ["glitch", "falha digital"])) effectPreset = "glitch";
  else if (has(text, ["vhs", "retrô", "retro"])) effectPreset = "vhs";
  else if (has(text, ["stop motion", "stop-motion"])) effectPreset = "stopMotion";
  else if (has(text, ["cinema", "cinematográfico", "cinematografico", "filme"])) effectPreset = "cinematic";
  else if (has(text, ["jardim", "natureza", "flores"])) effectPreset = "garden";

  return {
    aspectRatio,
    style,
    effectPreset,
    title: titleMatch?.[1]?.trim() || null,
    wantsText: Boolean(titleMatch),
  };
};

export const applySmartEdit = (project, prompt = "") => {
  const plan = analyzePrompt(prompt);
  let next = plan.aspectRatio ? setAspectRatio(project, plan.aspectRatio) : project;
  const presets = {
    dynamic: { speed: 1.15, transition: 0.18, brightness: 104, contrast: 112, saturation: 118, temperature: 4, imageDuration: 1.6 },
    cinematic: { speed: 0.92, transition: 0.7, brightness: 96, contrast: 116, saturation: 92, temperature: 12, imageDuration: 4 },
    soft: { speed: 0.95, transition: 0.8, brightness: 106, contrast: 94, saturation: 96, temperature: 9, imageDuration: 4.5 },
    clean: { speed: 1, transition: 0.3, brightness: 103, contrast: 106, saturation: 100, temperature: 0, imageDuration: 3 },
    balanced: { speed: 1, transition: 0.35, brightness: 100, contrast: 104, saturation: 104, temperature: 2, imageDuration: 3 },
  };
  const preset = presets[plan.style];
  next = {
    ...next,
    clips: next.clips.map((clip) => ({
      ...clip,
      speed: clip.mediaType === "video" ? preset.speed : 1,
      trimEnd: clip.mediaType === "image" ? Math.min(clip.duration, clip.trimStart + preset.imageDuration) : clip.trimEnd,
      transition: { ...clip.transition, type: "fade", duration: preset.transition },
      effect: {
        preset: plan.effectPreset,
        intensity: plan.effectPreset === "none" ? .55 : .65,
        beatSync: ["gaming", "zoomPulse", "shake"].includes(plan.effectPreset),
        bpm: plan.effectPreset === "gaming" ? 128 : 120,
      },
      filter: {
        ...clip.filter,
        brightness: preset.brightness,
        contrast: preset.contrast,
        saturation: preset.saturation,
        temperature: preset.temperature,
      },
    })),
    updatedAt: new Date().toISOString(),
  };

  if (plan.title) {
    next = addOverlay(next, {
      text: plan.title,
      start: 0,
      end: Math.min(3.5, Math.max(1.5, projectDuration(next))),
      y: 0.78,
      size: 74,
      background: "#000000",
      shadow: true,
    });
  }

  const styleNames = { dynamic: "dinâmico", cinematic: "cinematográfico", soft: "suave", clean: "limpo", balanced: "equilibrado" };
  return {
    project: next,
    plan,
    summary: `Estilo ${styleNames[plan.style]} aplicado a ${next.clips.length} clipe${next.clips.length === 1 ? "" : "s"}${plan.aspectRatio ? ` em ${plan.aspectRatio}` : ""}.`,
  };
};

export const smartSuggestions = (project) => {
  const suggestions = [];
  const duration = projectDuration(project);
  if (!project.clips.length) suggestions.push({ title: "Comece pelas referências", command: "Monte um vídeo dinâmico vertical usando minhas fotos e vídeos" });
  if (project.clips.length > 1 && project.clips.every((clip) => (clip.transition?.duration || 0) === 0)) suggestions.push({ title: "Suavizar trocas", command: "Aplique transições suaves e um visual equilibrado" });
  if (duration > 60) suggestions.push({ title: "Deixar mais dinâmico", command: "Deixe o vídeo mais rápido e dinâmico" });
  if (!project.overlays.length && project.clips.length) suggestions.push({ title: "Criar abertura", command: "Estilo profissional, título: Meu vídeo" });
  if (project.aspectRatio === "16:9") suggestions.push({ title: "Versão para Reels", command: "Adapte para Reels vertical com ritmo dinâmico" });
  if (!suggestions.length) suggestions.push({ title: "Acabamento cinematográfico", command: "Dê um acabamento cinematográfico elegante" });
  return suggestions.slice(0, 4);
};
