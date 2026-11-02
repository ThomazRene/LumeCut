const STORAGE_KEY = "lumecut-local-profiles-v1";
const encoder = new TextEncoder();
const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g) || [], (value) => Number.parseInt(value, 16));

export function listProfiles() {
  const profiles = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  if (!Array.isArray(profiles)) throw new Error("Não foi possível ler os perfis locais.");
  return profiles;
}

async function derive(password, salt) {
  if (!globalThis.crypto?.subtle) throw new Error("Este navegador não oferece recursos para proteger a senha local.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, key, 256));
}

export async function createProfile(name, password, migrateLegacy = false) {
  name = name.trim();
  if (name.length < 2 || name.length > 40) throw new Error("Use um nome entre 2 e 40 caracteres.");
  if (password.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  const profiles = listProfiles();
  if (profiles.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("Já existe um perfil com esse nome neste aparelho.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt);
  const profile = { id: crypto.randomUUID(), name, salt: toHex(salt), hash: toHex(hash), migrateLegacy };
  profiles.push(profile);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  return profile;
}

export function finishLegacyMigration(profileId) {
  const profiles = listProfiles();
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error("Perfil local não encontrado.");
  profile.migrateLegacy = false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

export async function authenticateProfile(name, password) {
  const profile = listProfiles().find((item) => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  if (!profile) throw new Error("Nome ou senha incorretos.");
  const hash = await derive(password, fromHex(profile.salt));
  const expected = fromHex(profile.hash);
  let difference = hash.length ^ expected.length;
  for (let i = 0; i < hash.length; i += 1) difference |= hash[i] ^ (expected[i] ?? 0);
  if (difference) throw new Error("Nome ou senha incorretos.");
  return profile;
}
