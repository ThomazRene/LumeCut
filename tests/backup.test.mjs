import test from "node:test";
import assert from "node:assert/strict";
import { createProject, createClip } from "../editor-core.mjs";
import { createProjectBackup, restoreProjectBackup } from "../project-backup.mjs";

test("backup restaura mídia e projeto com novos identificadores", async () => {
  const records = new Map([["original", { id: "original", name: "foto.png", type: "image/png", mediaType: "image", blob: new Blob(["foto"]) }]]);
  const store = { get: async (id) => records.get(id), put: async (record) => records.set(record.id, record) };
  const project = createProject({ clips: [createClip({ sourceId: "original", name: "foto", mediaType: "image", duration: 5 })] });
  const backup = await createProjectBackup(project, store);
  const restored = await restoreProjectBackup(backup, store);
  assert.notEqual(restored.id, project.id);
  assert.notEqual(restored.clips[0].sourceId, "original");
  assert.equal(await records.get(restored.clips[0].sourceId).blob.text(), "foto");
  await assert.rejects(() => restoreProjectBackup(backup.slice(0, backup.size - 1), store));
});
