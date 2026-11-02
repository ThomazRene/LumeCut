export const APP_VERSION = "2.0";
export const APP_VERSION_CODE = 2;
export const DOWNLOAD_PAGE = "https://thomazrene.github.io/LumeCut/baixar.html";
const VERSION_URL = "https://thomazrene.github.io/LumeCut/version.json";

export async function checkForUpdate(fetcher = fetch) {
  const response = await fetcher(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Não foi possível consultar as atualizações.");
  const data = await response.json();
  if (!Number.isSafeInteger(data.versionCode) || data.versionCode < 1 || typeof data.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(data.version)) {
    throw new Error("Informações de atualização inválidas.");
  }
  return { version: data.version, available: data.versionCode > APP_VERSION_CODE };
}
