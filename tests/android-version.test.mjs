import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("configura versão e assinatura em projeto Android gerado", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lumecut-version-test-"));
  try {
    await mkdir(join(dir, "scripts"), { recursive: true });
    await mkdir(join(dir, "android", "app", "src", "main"), { recursive: true });
    await copyFile("scripts/configure-android.mjs", join(dir, "scripts", "configure-android.mjs"));
    await writeFile(join(dir, "android", "app", "src", "main", "AndroidManifest.xml"), '<manifest><application android:label="LumeCut" /></manifest>');
    const gradle = join(dir, "android", "app", "build.gradle");
    await writeFile(gradle, 'android {\n    defaultConfig {\n        versionCode 1\n        versionName "1.0"\n    }\n    buildTypes {\n        release {\n            minifyEnabled false\n        }\n    }\n}');
    await promisify(execFile)(process.execPath, [join(dir, "scripts", "configure-android.mjs")]);
    const output = await readFile(gradle, "utf8");
    assert.match(output, /versionCode 2/);
    assert.match(output, /versionName "2\.0"/);
    assert.match(output, /signingConfig signingConfigs\.release/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
