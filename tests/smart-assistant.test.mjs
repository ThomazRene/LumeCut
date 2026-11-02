import test from "node:test";
import assert from "node:assert/strict";
import { addClip, createClip, createProject } from "../editor-core.mjs";
import { analyzePrompt, applySmartEdit, smartSuggestions } from "../smart-assistant.mjs";

test("entende formato, estilo e título em português", () => {
  const plan = analyzePrompt("Vídeo rápido para Reels, título: Minha viagem");
  assert.equal(plan.aspectRatio, "9:16");
  assert.equal(plan.style, "dynamic");
  assert.equal(plan.title, "Minha viagem");
});

test("aplica montagem sem remover mídia", () => {
  let project = createProject({ aspectRatio: "16:9" });
  project = addClip(project, createClip({ sourceId: "foto", mediaType: "image", duration: 5 }));
  const result = applySmartEdit(project, "Cinematográfico vertical, título: Olá");
  assert.equal(result.project.clips.length, 1);
  assert.equal(result.project.aspectRatio, "9:16");
  assert.equal(result.project.overlays[0].text, "Olá");
  assert.ok(result.project.clips[0].transition.duration > 0);
});

test("oferece ajuda contextual", () => {
  assert.ok(smartSuggestions(createProject()).length > 0);
});
