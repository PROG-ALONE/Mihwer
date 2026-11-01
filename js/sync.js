import { getAllData, replaceAllData } from "./db.js";
import { getRecords, update } from "./store.js";

const GITHUB_API = "https://api.github.com";
const GIST_FILENAME = "mihwar-data.json";
const BACKUP_FIELDS = /token|secret|password|credential/i;

function cloneWithoutSecrets(value) {
  if (Array.isArray(value)) return value.map(cloneWithoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !BACKUP_FIELDS.test(key))
    .map(([key, item]) => [key, cloneWithoutSecrets(item)]));
}

async function githubRequest(path, token, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || `تعذّر الاتصال بـ GitHub (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function profileToken(profile) {
  const token = profile?.githubToken?.trim();
  if (!token) throw new Error("أضف توكن GitHub من الإعدادات أولاً.");
  return token;
}

export async function testGitHubConnection(token) {
  const result = await githubRequest("/user", token);
  return { login: result.login, name: result.name ?? result.login };
}

async function findOrCreateGist(profile, token) {
  if (profile.gistId) {
    const existing = await githubRequest(`/gists/${encodeURIComponent(profile.gistId)}`, token);
    if (existing.public) throw new Error("الـ Gist المرتبط عام. أنشئ Gist خاصاً جديداً من الإعدادات.");
    return existing;
  }
  let page = 1;
  while (page <= 5) {
    const gists = await githubRequest(`/gists?per_page=100&page=${page}`, token);
    const match = gists.find((gist) => gist.files?.[GIST_FILENAME]);
    if (match) {
      if (match.public) throw new Error("عُثر على Gist عام باسم بيانات مِحوَر. لن تتم مزامنته حفاظاً على الخصوصية.");
      return match;
    }
    if (gists.length < 100) break;
    page += 1;
  }
  return githubRequest("/gists", token, {
    method: "POST",
    body: JSON.stringify({
      description: "مِحوَر — بيانات مزامنة شخصية",
      public: false,
      files: { [GIST_FILENAME]: { content: JSON.stringify({ version: 1, stores: {} }) } },
    }),
  });
}

function recordTimestamp(record) {
  const value = record.updatedAt ?? record.deletedAt ?? record.completedAt ?? record.createdAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeStores(local, remote) {
  const merged = {};
  for (const [storeName, localRecords] of Object.entries(local)) {
    const recordsById = new Map(localRecords.map((record) => [String(record.id), record]));
    const remoteRecords = Array.isArray(remote[storeName]) ? remote[storeName] : [];
    for (const remoteRecord of remoteRecords) {
      if (!remoteRecord || remoteRecord.id === undefined || remoteRecord.id === null) continue;
      const id = String(remoteRecord.id);
      const localRecord = recordsById.get(id);
      if (!localRecord || recordTimestamp(remoteRecord) > recordTimestamp(localRecord)) {
        recordsById.set(id, remoteRecord);
      }
    }
    merged[storeName] = [...recordsById.values()];
  }

  const tombstones = new Map();
  for (const record of [...(merged.syncTombstones ?? []), ...(remote.syncTombstones ?? [])]) {
    if (!record?.id) continue;
    const existing = tombstones.get(record.id);
    if (!existing || recordTimestamp(record) > recordTimestamp(existing)) tombstones.set(record.id, record);
  }
  merged.syncTombstones = [...tombstones.values()];

  for (const tombstone of merged.syncTombstones) {
    if (!merged[tombstone.storeName]) continue;
    const record = merged[tombstone.storeName].find((item) => String(item.id) === String(tombstone.recordId));
    if (!record) continue;
    if (recordTimestamp(tombstone) >= recordTimestamp(record)) {
      merged[tombstone.storeName] = merged[tombstone.storeName].filter((item) => String(item.id) !== String(tombstone.recordId));
    } else {
      merged.syncTombstones = merged.syncTombstones.filter((item) => item.id !== tombstone.id);
    }
  }
  return merged;
}

async function gistContents(gist, token) {
  const file = gist?.files?.[GIST_FILENAME];
  let content = file?.content;
  if (file?.truncated) {
    if (typeof file.raw_url !== "string") throw new Error("رابط ملف المزامنة الخام مفقود.");
    const rawUrl = new URL(file.raw_url);
    if (rawUrl.protocol !== "https:" || rawUrl.hostname !== "gist.githubusercontent.com") {
      throw new Error("رابط ملف المزامنة الخام غير موثوق.");
    }
    const response = await fetch(rawUrl, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`تعذّرت قراءة ملف Gist الكبير (HTTP ${response.status}).`);
    content = await response.text();
  }
  if (!content) return { version: 1, stores: {} };
  try {
    const payload = JSON.parse(content);
    if (payload.version !== 1 || !payload.stores || typeof payload.stores !== "object") {
      throw new Error("صيغة ملف المزامنة في Gist غير مدعومة.");
    }
    return payload;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("ملف المزامنة في Gist ليس JSON صالحاً.");
    throw error;
  }
}

async function saveGist(gistId, token, stores) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    stores: cloneWithoutSecrets(stores),
  };
  const gist = await githubRequest(`/gists/${encodeURIComponent(gistId)}`, token, {
    method: "PATCH",
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content: JSON.stringify(payload) } } }),
  });
  return gist;
}

async function sync(profile) {
  const token = profileToken(profile);
  const gist = await findOrCreateGist(profile, token);
  const payload = await gistContents(gist, token);
  const localData = await getAllData();
  const mergedData = mergeStores(localData, payload.stores);
  const localProfile = mergedData.profile?.find((item) => item.id === profile.id) ?? profile;
  if (localProfile.githubToken !== token) {
    mergedData.profile = (mergedData.profile ?? []).map((item) =>
      item.id === profile.id ? { ...item, githubToken: token } : item);
  }
  await replaceAllData(mergedData);

  const profileRecords = await getRecords("profile");
  const refreshedProfile = profileRecords.find((item) => item.id === profile.id) ?? profile;
  const nextProfile = { ...refreshedProfile, gistId: gist.id, updatedAt: new Date().toISOString() };
  await update("profile", nextProfile);
  const savedGist = await saveGist(gist.id, token, await getAllData());
  const recordCount = Object.entries(mergedData)
    .filter(([name]) => name !== "profile" && name !== "syncTombstones")
    .reduce((total, [, items]) => total + items.length, 0);
  return { gistId: savedGist.id, recordsCount: recordCount };
}

export async function syncAll(profile) {
  return sync(profile);
}

export async function logSync(action, status, recordsCount = 0, error = null) {
  const { add } = await import("./store.js");
  const entry = {
    id: crypto.randomUUID(),
    action,
    store: "all",
    recordsCount,
    timestamp: new Date().toISOString(),
    status,
    error: error ? String(error).slice(0, 500) : null,
  };
  await add("syncLog", entry);
  return entry;
}
