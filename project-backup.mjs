import { createId, parseProject, serializeProject } from "./editor-core.mjs";

const magic = "LUMEBK01";
export async function createProjectBackup(project, store) {
  const ids = [...new Set([...project.clips, ...project.audioTracks].map((item) => item.sourceId))];
  const records = [];
  for (const id of ids) {
    const source = await store.get(id);
    if (!source?.blob) throw new Error(`Arquivo ausente: ${id}. Não foi possível criar o backup completo.`);
    const { blob, ...metadata } = source;
    records.push({ metadata, blob });
  }
  const manifest = new TextEncoder().encode(JSON.stringify({ project: JSON.parse(serializeProject(project)), sources: records.map(({ metadata, blob }) => ({ ...metadata, size: blob.size })) }));
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(magic));
  new DataView(header.buffer).setUint32(8, manifest.length, false);
  return new Blob([header, manifest, ...records.map((item) => item.blob)], { type: "application/octet-stream" });
}

export async function restoreProjectBackup(file, store) {
  if (file.size < 12) throw new Error("Backup inválido ou incompleto.");
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(header.slice(0, 8)) !== magic) throw new Error("Este arquivo não é um backup do LumeCut.");
  const length = new DataView(header.buffer).getUint32(8, false);
  if (length > 10_000_000 || 12 + length > file.size) throw new Error("Backup inválido ou incompleto.");
  const manifest = JSON.parse(await file.slice(12, 12 + length).text());
  const project = parseProject(JSON.stringify(manifest.project));
  if (!Array.isArray(manifest.sources)) throw new Error("Lista de mídias inválida.");
  let offset = 12 + length;
  const mapping = new Map();
  const records = [];
  for (const source of manifest.sources) {
    if (!source.id || mapping.has(source.id) || !Number.isSafeInteger(source.size) || source.size < 0 || offset + source.size > file.size) throw new Error("Mídia inválida ou incompleta no backup.");
    const id = createId("media");
    mapping.set(source.id, id);
    records.push({ ...source, id, blob: file.slice(offset, offset + source.size, source.type || "application/octet-stream") });
    offset += source.size;
  }
  if (offset !== file.size || [...project.clips, ...project.audioTracks].some((item) => !mapping.has(item.sourceId))) throw new Error("Backup incompleto ou com mídias ausentes.");
  for (const record of records) await store.put(record);
  project.id = createId("project");
  project.clips = project.clips.map((item) => ({ ...item, sourceId: mapping.get(item.sourceId) }));
  project.audioTracks = project.audioTracks.map((item) => ({ ...item, sourceId: mapping.get(item.sourceId) }));
  return project;
}
