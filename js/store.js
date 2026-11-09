import {
  addRecord as dbAddRecord,
  deleteRecord as dbDeleteRecord,
  getAllData,
  getAllRecords,
  updateRecord as dbUpdateRecord,
} from "./db.js";

const listeners = new Set();
let state = {};
let initialized = false;
let initialization;

function publish(change) {
  for (const listener of listeners) {
    listener(state, change);
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function initializeStore() {
  if (initialized) return state;
  if (!initialization) {
    initialization = getAllData().then((data) => {
      state = data;
      initialized = true;
      publish({ type: "initialized" });
      return state;
    }).catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

export function getState() {
  return state;
}

export async function getRecords(storeName) {
  await initializeStore();
  const records = state[storeName];
  if (!Array.isArray(records) || typeof structuredClone !== "function") {
    return getAllRecords(storeName);
  }
  return structuredClone(records);
}

export async function add(storeName, record) {
  await initializeStore();
  await dbAddRecord(storeName, record);
  await dbDeleteRecord("syncTombstones", `${storeName}:${record.id}`);
  state = { ...state, [storeName]: [...(state[storeName] ?? []), record] };
  publish({ type: "add", storeName, record });
  return record;
}

export async function update(storeName, record) {
  await initializeStore();
  await dbUpdateRecord(storeName, record);
  await dbDeleteRecord("syncTombstones", `${storeName}:${record.id}`);
  const records = state[storeName] ?? [];
  const found = records.some((item) => item.id === record.id);
  state = {
    ...state,
    [storeName]: found
      ? records.map((item) => item.id === record.id ? record : item)
      : [...records, record],
  };
  publish({ type: "update", storeName, record });
  return record;
}

export async function remove(storeName, id) {
  await initializeStore();
  await dbDeleteRecord(storeName, id);
  await dbUpdateRecord("syncTombstones", {
    id: `${storeName}:${id}`,
    storeName,
    recordId: id,
    deletedAt: new Date().toISOString(),
  });
  state = { ...state, [storeName]: (state[storeName] ?? []).filter((item) => item.id !== id) };
  publish({ type: "delete", storeName, id });
}
