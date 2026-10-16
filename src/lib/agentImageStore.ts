import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
} from "@/types/agent";

interface StoredAgentImages {
  requestId: string;
  savedAt: number;
  attachments?: AgentImageAttachment[];
  documents?: AgentDocumentAttachment[];
}

const DATABASE_NAME = "lolicode-agent-images";
const STORE_NAME = "sent-images";
const MAX_STORED_MESSAGES = 24;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "requestId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("图片缓存不可用"));
  });
  databasePromise = opening.catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });
  return databasePromise;
}

async function saveAgentAttachmentPatch(
  requestId: string,
  patch: Partial<Pick<StoredAgentImages, "attachments" | "documents">>,
) {
  if (typeof indexedDB === "undefined") return;
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const existingRequest = store.get(requestId);
  existingRequest.onsuccess = () => {
    const existing = (existingRequest.result as
      | StoredAgentImages
      | undefined) || {
      requestId,
      savedAt: Date.now(),
    };
    store.put({ ...existing, ...patch, savedAt: Date.now() });
    const request = store.getAll();
    request.onsuccess = () => {
      const records = (request.result as StoredAgentImages[]).sort(
        (a, b) => b.savedAt - a.savedAt,
      );
      let totalBytes = 0;
      for (const [index, record] of records.entries()) {
        const bytes = [
          ...(record.attachments || []),
          ...(record.documents || []),
        ].reduce((sum, attachment) => sum + attachment.bytes, 0);
        if (
          index >= MAX_STORED_MESSAGES ||
          totalBytes + bytes > MAX_STORED_BYTES
        ) {
          store.delete(record.requestId);
          continue;
        }
        totalBytes += bytes;
      }
    };
    request.onerror = () => transaction.abort();
  };
  existingRequest.onerror = () => transaction.abort();
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("图片缓存写入失败"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("图片缓存写入失败"));
  });
}

export async function saveAgentImageAttachments(
  requestId: string,
  attachments: AgentImageAttachment[],
) {
  if (!attachments.length) return;
  await saveAgentAttachmentPatch(requestId, { attachments });
}

export async function saveAgentDocumentAttachments(
  requestId: string,
  documents: AgentDocumentAttachment[],
) {
  if (!documents.length) return;
  await saveAgentAttachmentPatch(requestId, { documents });
}

export async function readAgentImageAttachments(requestId: string) {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openDatabase();
  return await new Promise<AgentImageAttachment[] | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(requestId);
      request.onsuccess = () =>
        resolve((request.result as StoredAgentImages | undefined)?.attachments);
      request.onerror = () =>
        reject(request.error || new Error("图片缓存读取失败"));
    },
  );
}

export async function readAgentDocumentAttachments(requestId: string) {
  if (typeof indexedDB === "undefined") return undefined;
  const database = await openDatabase();
  return await new Promise<AgentDocumentAttachment[] | undefined>(
    (resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(requestId);
      request.onsuccess = () =>
        resolve((request.result as StoredAgentImages | undefined)?.documents);
      request.onerror = () =>
        reject(request.error || new Error("文档缓存读取失败"));
    },
  );
}
