import test from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION_CODE, checkForUpdate } from "../update-check.mjs";

test("informa se há versão mais recente", async () => {
  const response = (versionCode) => async () => ({ ok: true, json: async () => ({ version: "2.1", versionCode }) });
  assert.equal((await checkForUpdate(response(APP_VERSION_CODE + 1))).available, true);
  assert.equal((await checkForUpdate(response(APP_VERSION_CODE))).available, false);
});

test("trata falha de rede e dados de versão inválidos", async () => {
  await assert.rejects(() => checkForUpdate(async () => ({ ok: false })));
  await assert.rejects(() => checkForUpdate(async () => ({ ok: true, json: async () => ({ version: "<script>", versionCode: 3 }) })));
});
