import { createId } from "./editor-core.mjs";

const DB_NAME = "lumecut-db";
const DB_VERSION = 1;

const openDatabase = () => new Promise((resolve, reject) => {
  if (!("indexedDB" in globalThis)) {
    resolve(null);
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("sources")) db.createObjectStore("sources", { keyPath: "id" });
    if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

export const probeFile = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const cleanup = () => URL.revokeObjectURL(url);
  if (file.type.startsWith("image/")) {
    const image = new Image();
    image.onload = () => {
      resolve({ mediaType: "image", duration: 5, width: image.naturalWidth, height: image.naturalHeight });
      cleanup();
    };
    image.onerror = () => { cleanup(); reject(new Error(`Não foi possível abrir ${file.name}`)); };
    image.src = url;
    return;
  }

  const media = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
  media.preload = "metadata";
  media.onloadedmetadata = () => {
    resolve({
      mediaType: file.type.startsWith("audio/") ? "audio" : "video",
      duration: Number.isFinite(media.duration) ? media.duration : 0,
      width: media.videoWidth || 0,
      height: media.videoHeight || 0,
    });
    cleanup();
  };
  media.onerror = () => { cleanup(); reject(new Error(`Formato não suportado: ${file.name}`)); };
  media.src = url;
});

export class MediaStore {
  constructor() {
    this.database = openDatabase();
    this.memory = new Map();
    this.urls = new Map();
  }

  async addFile(file, metadata = null) {
    const info = metadata ?? await probeFile(file);
    const record = {
      id: createId("media"),
      name: file.name,
      type: file.type,
      size: file.size,
      blob: file,
      ...info,
    };
    await this.put(record);
    return record;
  }

  async put(record) {
    this.memory.set(record.id, record);
    const db = await this.database;
    if (!db) return;
    const transaction = db.transaction("sources", "readwrite");
    transaction.objectStore("sources").put(record);
    await transactionDone(transaction);
  }

  async get(id) {
    if (this.memory.has(id)) return this.memory.get(id);
    const db = await this.database;
    if (!db) return null;
    const transaction = db.transaction("sources", "readonly");
    const result = await requestResult(transaction.objectStore("sources").get(id));
    if (result) this.memory.set(id, result);
    return result ?? null;
  }

  async getUrl(id) {
    if (this.urls.has(id)) return this.urls.get(id);
    const source = await this.get(id);
    if (!source?.blob) throw new Error("Arquivo de mídia ausente");
    const url = URL.createObjectURL(source.blob);
    this.urls.set(id, url);
    return url;
  }

  async saveProject(project) {
    const db = await this.database;
    if (!db) {
      localStorage.setItem("lumecut-project", JSON.stringify(project));
      return;
    }
    const transaction = db.transaction("projects", "readwrite");
    transaction.objectStore("projects").put({ id: "current", project });
    await transactionDone(transaction);
  }

  async loadProject() {
    const db = await this.database;
    if (!db) {
      const raw = localStorage.getItem("lumecut-project");
      return raw ? JSON.parse(raw) : null;
    }
    const transaction = db.transaction("projects", "readonly");
    const result = await requestResult(transaction.objectStore("projects").get("current"));
    return result?.project ?? null;
  }

  dispose() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
