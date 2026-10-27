import { Database } from "bun:sqlite";
import { mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { boundedFetch, readText, HttpError } from "./http.ts";

export type RecordValue = { readonly id: string; readonly title: string; readonly createdAt: string };
export interface RecordStore {
  list(owner: string): Promise<RecordValue[]>;
  put(owner: string, record: RecordValue): Promise<RecordValue>;
  remove(owner: string, id: string): Promise<void>;
  ready(): Promise<void>;
  close(): void;
}

// Bound public health polling to one database request per five seconds per
// instance. Failed probes are cached too, and concurrent callers share a probe.
export function cachedReadiness(probe: () => Promise<void>): () => Promise<void> {
  let cached: { ok: boolean; until: number } | undefined;
  let pending: Promise<void> | undefined;
  return async () => {
    if (cached && performance.now() < cached.until) {
      if (!cached.ok) throw new Error("Datastore unavailable.");
      return;
    }
    pending ??= Promise.resolve().then(probe).then(
      () => { cached = { ok: true, until: performance.now() + 5000 }; },
      () => { cached = { ok: false, until: performance.now() + 5000 }; throw new Error("Datastore unavailable."); },
    ).finally(() => { pending = undefined; });
    await pending;
  };
}
function recordValue(record: RecordValue): void {
  recordId(record.id);
  if(typeof record.title!=="string" || typeof record.createdAt!=="string" || record.createdAt.length>64 || new TextEncoder().encode(JSON.stringify(record)).byteLength>2048) throw new HttpError(400,"Record is too large or invalid.");
}
export function memoryStore(): RecordStore {
  const records = new Map<string, RecordValue>();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  return {
    async list(owner) { ownerId(owner); return [...records.entries()].filter(([id]) => JSON.parse(id)[0] === owner).map(([, record]) => ({ ...record })).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)).slice(0,100); },
    async put(owner, record) {
      ownerId(owner); recordValue(record); const id = key(owner, record.id); const previous = records.get(id);
      if (previous && previous.title !== record.title) throw new HttpError(409, "Operation ID already used.");
      if (!previous && records.size >= 1000) throw new HttpError(429, "Preview capacity reached.");
      records.set(id, previous ?? { ...record }); return { ...(previous ?? record) };
    },
    async remove(owner, id) { ownerId(owner); recordId(id); records.delete(key(owner, id)); },
    async ready() {}, close() { records.clear(); },
  };
}
function recordId(id: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new HttpError(400, "Invalid record ID."); }
function ownerId(owner: string): void { if (!owner || owner.length > 128) throw new HttpError(401, "Sign in required."); }

export async function sqliteStore(path: string): Promise<RecordStore> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  await chmod(path, 0o600);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (owner TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner,id))");
  return {
    async list(owner) { ownerId(owner); return db.query("SELECT id,title,created_at AS createdAt FROM records WHERE owner=? ORDER BY created_at DESC,id DESC LIMIT 100").all(owner) as RecordValue[]; },
    async put(owner, record) {
      ownerId(owner); recordValue(record);
      // A client-generated operation ID makes a lost create response safe to retry.
      db.query("INSERT OR IGNORE INTO records VALUES (?,?,?,?)").run(owner, record.id, record.title, record.createdAt);
      const saved = db.query("SELECT id,title,created_at AS createdAt FROM records WHERE owner=? AND id=?").get(owner, record.id) as RecordValue;
      if (saved.title !== record.title) throw new HttpError(409, "Operation ID already used.");
      return saved;
    },
    async remove(owner, id) { ownerId(owner); recordId(id); db.query("DELETE FROM records WHERE owner=? AND id=?").run(owner, id); },
    async ready() { db.query("SELECT 1").get(); }, close() { db.close(); },
  };
}

export function metadataTokenProvider(fetcher: typeof boundedFetch = boundedFetch) {
  let cached: { token: string; expires: number } | undefined;
  return async (): Promise<string> => {
    if (cached && cached.expires > Date.now()) return cached.token;
    const response = await fetcher("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
    if (!response.ok || response.headers.get("Metadata-Flavor") !== "Google") throw new Error("Runtime identity unavailable.");
    const value = JSON.parse(await readText(response, 262_144)) as { access_token?: unknown; expires_in?: unknown };
    if (typeof value.access_token !== "string" || typeof value.expires_in !== "number" || value.expires_in <= 60) throw new Error("Runtime identity unavailable.");
    cached = { token: value.access_token, expires: Date.now() + Math.min(value.expires_in - 60, 300) * 1000 };
    return cached.token;
  };
}

export function firestoreStore(project: string, collection = "platform_records", getToken = metadataTokenProvider()): RecordStore {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !/^[a-z][a-z0-9_]{0,62}$/.test(collection)) throw new Error("Invalid data configuration.");
  const database = `projects/${project}/databases/(default)`;
  const base = `https://firestore.googleapis.com/v1/${database}/documents`;
  const ownerPath = (owner: string) => { ownerId(owner); return `${collection}/${Bun.CryptoHasher.hash("sha256", owner, "hex")}/items`; };
  const call = async (url: string, init: RequestInit = {}) => boundedFetch(url, { ...init, headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${await getToken()}` } });
  const decode = (doc: { name?: string; fields?: Record<string, { stringValue?: string }> }): RecordValue => {
    const id = doc.name?.split("/").at(-1); const title = doc.fields?.title?.stringValue; const createdAt = doc.fields?.createdAt?.stringValue;
    if (!id || typeof title !== "string" || typeof createdAt !== "string") throw new Error("Invalid stored record.");
    recordId(id); return { id, title, createdAt };
  };
  return {
    async list(owner) {
      const response = await call(`${base}/${ownerPath(owner)}?pageSize=100&orderBy=createdAt%20desc`);
      if (!response.ok) throw new Error("Data unavailable.");
      const data = JSON.parse(await readText(response, 262_144)) as { documents?: Parameters<typeof decode>[0][] };
      return (data.documents ?? []).map(decode);
    },
    async put(owner, record) {
      recordValue(record); const url = `${base}/${ownerPath(owner)}/${record.id}`;
      const response = await call(`${url}?currentDocument.exists=false`, { method: "PATCH", body: JSON.stringify({ fields: { title: { stringValue: record.title }, createdAt: { stringValue: record.createdAt } } }) });
      if (response.status === 409 || response.status === 412) {
        const existing = await call(url); if (!existing.ok) throw new Error("Data unavailable.");
        const saved = decode(JSON.parse(await readText(existing, 262_144)) as Parameters<typeof decode>[0]);
        if (saved.title !== record.title) throw new HttpError(409, "Operation ID already used.");
        return saved;
      }
      if (!response.ok) throw new Error("Data unavailable."); return decode(JSON.parse(await readText(response, 262_144)) as Parameters<typeof decode>[0]);
    },
    async remove(owner, id) { recordId(id); const result = await call(`${base}/${ownerPath(owner)}/${id}`, { method: "DELETE" }); if (!result.ok && result.status !== 404) throw new Error("Data unavailable."); },
    ready: cachedReadiness(async () => { const response = await call(`${base}/${collection}?pageSize=1&mask.fieldPaths=createdAt`); if (!response.ok) throw new Error("Data unavailable."); await response.body?.cancel(); }), close() {},
  };
}
