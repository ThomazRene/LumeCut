import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { authenticateProfile, createProfile, listProfiles } from "../local-profiles.mjs";

test("perfil local usa senha derivada e recusa senha incorreta", async () => {
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const profile = await createProfile("Pessoa", "minha-senha-segura");
  assert.equal((await authenticateProfile("pessoa", "minha-senha-segura")).id, profile.id);
  await assert.rejects(() => authenticateProfile("Pessoa", "senha-errada"));
  await assert.rejects(() => createProfile("PESSOA", "outra-senha-segura"));
  assert.equal(listProfiles().length, 1);
  assert.equal([...values.values()][0].includes("minha-senha-segura"), false);
  delete globalThis.localStorage;
});
