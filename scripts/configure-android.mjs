import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "android", "app", "src", "main", "AndroidManifest.xml");
const gradlePath = join(root, "android", "app", "build.gradle");

await access(manifestPath);
await access(gradlePath);

let manifest = await readFile(manifestPath, "utf8");
if (!manifest.includes("android.hardware.touchscreen")) {
  manifest = manifest.replace(
    /(<manifest[^>]*>)/,
    `$1\n\n    <!-- LumeCut Android é otimizado e distribuído somente para celulares. -->\n    <uses-feature android:name="android.hardware.touchscreen" android:required="true" />\n    <supports-screens\n        android:smallScreens="true"\n        android:normalScreens="true"\n        android:largeScreens="false"\n        android:xlargeScreens="false"\n        android:anyDensity="true" />`,
  );
}

if (!manifest.includes("android:largeHeap")) {
  manifest = manifest.replace(
    /<application\s/,
    `<application\n        android:hardwareAccelerated="true"\n        android:largeHeap="true"\n        android:usesCleartextTraffic="false"\n        `,
  );
}
await writeFile(manifestPath, manifest, "utf8");

let gradle = await readFile(gradlePath, "utf8");
if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+["'][^"']+["']/.test(gradle)) {
  throw new Error("Não foi possível localizar a versão do Android no Gradle.");
}
gradle = gradle.replace(/versionCode\s+\d+/, "versionCode 2");
gradle = gradle.replace(/versionName\s+["'][^"']+["']/, 'versionName "2.0"');
if (!gradle.includes("ANDROID_KEYSTORE_PATH")) {
  gradle = gradle.replace(
    "    buildTypes {",
    `    signingConfigs {\n        release {\n            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))\n            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")\n            keyAlias System.getenv("ANDROID_KEY_ALIAS")\n            keyPassword System.getenv("ANDROID_KEY_PASSWORD")\n            storeType "pkcs12"\n        }\n    }\n    buildTypes {`,
  );
  gradle = gradle.replace(
    /release\s*\{\s*minifyEnabled\s+false/,
    `release {\n            signingConfig signingConfigs.release\n            minifyEnabled true\n            shrinkResources true`,
  );
}
await writeFile(gradlePath, gradle, "utf8");
console.log("Android configurado para celulares, aceleração por hardware e build release otimizado.");
