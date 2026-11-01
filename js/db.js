export const DATABASE_NAME = "mihwar";
export const DATABASE_VERSION = 2;
export const STORE_NAMES = [
  "lifeAreas",
  "objectives",
  "keyResults",
  "projects",
  "tasks",
  "habits",
  "sessions",
  "journal",
  "reviews",
  "device",
  "profile",
  "sharedWith",
  "syncLog",
  "syncTombstones",
];

let databasePromise;

function openDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("هذا المتصفح لا يدعم التخزين المحلي IndexedDB."));
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        for (const storeName of STORE_NAMES) {
          if (!database.objectStoreNames.contains(storeName)) {
            database.createObjectStore(storeName, { keyPath: "id" });
          }
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error("تعذّر فتح قاعدة البيانات."));
      request.onblocked = () => reject(new Error("قاعدة البيانات مشغولة في نافذة أخرى. أغلق النوافذ الأخرى ثم أعد المحاولة."));
    }).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
  }

  return databasePromise;
}

function assertStore(storeName) {
  if (!STORE_NAMES.includes(storeName)) {
    throw new Error(`مخزن بيانات غير معروف: ${storeName}`);
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذّرت عملية قاعدة البيانات."));
  });
}

function transactionCompletion(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error ?? new Error("أُلغيت عملية قاعدة البيانات."));
    transaction.onerror = () => reject(transaction.error ?? new Error("تعذّرت عملية قاعدة البيانات."));
  });
}

export async function getRecord(storeName, id) {
  assertStore(storeName);
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(id));
}

export async function getAllRecords(storeName) {
  assertStore(storeName);
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).getAll());
}

export async function addRecord(storeName, record) {
  assertStore(storeName);
  if (record?.id === undefined || record?.id === null) {
    throw new Error("يجب أن يحتوي السجل على معرّف id.");
  }
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionCompletion(transaction);
  const result = requestResult(transaction.objectStore(storeName).add(record));
  await Promise.all([result, completion]);
  return record;
}

export async function updateRecord(storeName, record) {
  assertStore(storeName);
  if (record?.id === undefined || record?.id === null) {
    throw new Error("يجب أن يحتوي السجل على معرّف id.");
  }
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionCompletion(transaction);
  const result = requestResult(transaction.objectStore(storeName).put(record));
  await Promise.all([result, completion]);
  return record;
}

export async function deleteRecord(storeName, id) {
  assertStore(storeName);
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionCompletion(transaction);
  const result = requestResult(transaction.objectStore(storeName).delete(id));
  await Promise.all([result, completion]);
}

export async function getAllData() {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAMES, "readonly");
  const completion = transactionCompletion(transaction);
  const entries = await Promise.all(STORE_NAMES.map(async (storeName) => {
    const records = await requestResult(transaction.objectStore(storeName).getAll());
    return [storeName, records];
  }));
  await completion;
  return Object.fromEntries(entries);
}

export async function replaceAllData(data) {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAMES, "readwrite");
  const completion = transactionCompletion(transaction);

  for (const storeName of STORE_NAMES) {
    const objectStore = transaction.objectStore(storeName);
    objectStore.clear();
    for (const record of data[storeName] ?? []) {
      objectStore.put(record);
    }
  }

  await completion;
}
