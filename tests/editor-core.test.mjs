import test from "node:test";
import assert from "node:assert/strict";
import {
  HistoryStore,
  addClip,
  clipTimelineDuration,
  createClip,
  createProject,
  duplicateClip,
  locateAtTime,
  moveClip,
  parseProject,
  projectDuration,
  serializeProject,
  setAspectRatio,
  splitClip,
  updateClip,
} from "../editor-core.mjs";

const makeProject = () => {
  let project = createProject({ id: "test", createdAt: "now", updatedAt: "now" });
  project = addClip(project, createClip({ sourceId: "a", name: "A", duration: 10 }));
  project = addClip(project, createClip({ sourceId: "b", name: "B", duration: 6, speed: 2 }));
  return project;
};

test("calcula duração respeitando corte e velocidade", () => {
  const clip = createClip({ sourceId: "a", duration: 10, trimStart: 2, trimEnd: 8, speed: 2 });
  assert.equal(clipTimelineDuration(clip), 3);
});

test("localiza clipe e tempo de mídia na linha do tempo", () => {
  const project = makeProject();
  const located = locateAtTime(project, 11);
  assert.equal(located.clip.name, "B");
  assert.equal(located.localTimelineTime, 1);
  assert.equal(located.sourceTime, 2);
  assert.equal(projectDuration(project), 13);
});

test("divide clipe sem mudar a duração total", () => {
  const project = makeProject();
  const split = splitClip(project, 4);
  assert.equal(split.clips.length, 3);
  assert.equal(split.clips[0].trimEnd, 4);
  assert.equal(split.clips[1].trimStart, 4);
  assert.equal(projectDuration(split), projectDuration(project));
});

test("limita valores inválidos ao atualizar", () => {
  const project = makeProject();
  const next = updateClip(project, project.clips[0].id, { speed: 50, volume: -2, trimStart: 9.99, trimEnd: 2 });
  assert.equal(next.clips[0].speed, 8);
  assert.equal(next.clips[0].volume, 0);
  assert.ok(next.clips[0].trimEnd > next.clips[0].trimStart);
});

test("duplica e move clipes", () => {
  let project = makeProject();
  project = duplicateClip(project, project.clips[0].id);
  assert.equal(project.clips.length, 3);
  assert.notEqual(project.clips[0].id, project.clips[1].id);
  const copyId = project.clips[1].id;
  project = moveClip(project, copyId, 1);
  assert.equal(project.clips[2].id, copyId);
});

test("histórico desfaz e refaz", () => {
  const original = makeProject();
  const store = new HistoryStore(original);
  const changed = setAspectRatio(original, "16:9");
  store.commit(changed);
  assert.equal(store.present.aspectRatio, "16:9");
  assert.equal(store.undo().aspectRatio, "9:16");
  assert.equal(store.redo().aspectRatio, "16:9");
});

test("serializa e reabre projeto", () => {
  const project = makeProject();
  const reopened = parseProject(serializeProject(project));
  assert.equal(reopened.id, project.id);
  assert.equal(reopened.clips.length, 2);
});
