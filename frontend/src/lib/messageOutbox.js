const DATABASE_NAME = "whisper-messaging";
const DATABASE_VERSION = 1;
const STORE_NAME = "message-outbox";

const openDatabase = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, {
          keyPath: "clientMessageId",
        });
        store.createIndex("senderId", "senderId");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const runRequest = async (mode, createRequest) => {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = createRequest(store);
    let result;

    request.onsuccess = () => {
      result = request.result;
    };

    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };

    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };

    transaction.onabort = () => {
      database.close();
      reject(transaction.error);
    };
  });
};

export const saveOutboxMessage = (message) =>
  runRequest("readwrite", (store) => store.put(message));

export const removeOutboxMessage = (clientMessageId) =>
  runRequest("readwrite", (store) => store.delete(clientMessageId));

export const getOutboxMessagesForUser = (senderId) =>
  runRequest("readonly", (store) =>
    store.index("senderId").getAll(senderId)
  );
