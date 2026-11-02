import test from "node:test";
import assert from "node:assert/strict";
import { MediaStore } from "../media-store.mjs";

test("guarda mais de um projeto local sem apagar o atual anterior", async () => {
  const values = new Map();
  globalThis.localStorage = {
    setItem(key, value) { values.set(key, value); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    get length() { return values.size; },
  };
  const store = new MediaStore();
  await store.saveProject({ id: "one", name: "Primeiro" });
  await store.saveProject({ id: "two", name: "Segundo" });
  assert.deepEqual((await store.listProjects()).map((p) => p.name), ["Primeiro", "Segundo"]);
  assert.equal((await store.loadProject()).name, "Segundo");
  store.profileId = "outro";
  assert.deepEqual(await store.listProjects(), []);
  await store.saveProject({ id: "three", name: "Privado" });
  assert.deepEqual((await store.listProjects()).map((p) => p.name), ["Privado"]);
  store.profileId = null;
  assert.equal((await store.listProjects()).length, 2);
  delete globalThis.localStorage;
});
