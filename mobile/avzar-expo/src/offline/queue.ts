import * as SecureStore from 'expo-secure-store';
import { ApiError, api } from '@/api/client';

export type TaskActionName = 'start' | 'pause' | 'resume' | 'complete';

export type QueuedAction = {
  id: number;
  taskId: string;
  action: TaskActionName;
  note?: string;
  queuedAt: string;
};

export type SyncResult = { sent: number; rejected: string[]; remaining: number };

// Only task ids, the action name and the user's own note are stored. No customer data.
// Each action has its own key so no single stored value grows large; the index is just a list of numbers.
const INDEX_KEY = 'avzar.queue.index';
const ITEM_PREFIX = 'avzar.queue.item.';
const MAX_ITEMS = 200;

// Runs one queue operation at a time so a sync and a new tap cannot overwrite each other.
let chain: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<number[]> {
  try {
    const raw = await SecureStore.getItemAsync(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

async function writeIndex(index: number[]): Promise<void> {
  if (index.length === 0) await SecureStore.deleteItemAsync(INDEX_KEY);
  else await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify(index));
}

async function readItem(id: number): Promise<QueuedAction | null> {
  try {
    const raw = await SecureStore.getItemAsync(`${ITEM_PREFIX}${id}`);
    return raw ? (JSON.parse(raw) as QueuedAction) : null;
  } catch {
    return null;
  }
}

export function listPending(): Promise<QueuedAction[]> {
  return locked(async () => {
    const items: QueuedAction[] = [];
    for (const id of await readIndex()) {
      const item = await readItem(id);
      if (item) items.push(item);
    }
    return items;
  });
}

function enqueue(taskId: string, action: TaskActionName, note?: string): Promise<void> {
  return locked(async () => {
    const index = await readIndex();
    if (index.length >= MAX_ITEMS) throw new Error('Too many unsent actions. Connect to the internet to send them first.');
    const id = (index.length ? Math.max(...index) : 0) + 1;
    const item: QueuedAction = { id, taskId, action, note, queuedAt: new Date().toISOString() };
    await SecureStore.setItemAsync(`${ITEM_PREFIX}${id}`, JSON.stringify(item));
    await writeIndex([...index, id]);
  });
}

// The server understood the request and said no (for example the task was already completed).
// Retrying would never succeed, so these are dropped instead of blocking the queue.
function isPermanentRejection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status);
}

/** Sends queued actions in order. Stops at the first one that fails for a temporary reason (no network, server down, signed out). */
export function syncQueue(): Promise<SyncResult> {
  return locked(async () => {
    const index = await readIndex();
    const remaining = [...index];
    const rejected: string[] = [];
    let sent = 0;

    for (const id of index) {
      const item = await readItem(id);
      if (!item) {
        remaining.shift();
        continue;
      }
      try {
        await api.taskAction(item.taskId, item.action, item.note);
        sent += 1;
      } catch (error) {
        if (isPermanentRejection(error)) rejected.push(`${item.action}: ${error.message}`);
        else break; // temporary problem: keep this one and everything after it
      }
      await SecureStore.deleteItemAsync(`${ITEM_PREFIX}${id}`);
      remaining.shift();
    }

    await writeIndex(remaining);
    return { sent, rejected, remaining: remaining.length };
  });
}

/** Tries the action now. If there is no connection, saves it on the phone to send later. */
export async function performTaskAction(taskId: string, action: TaskActionName, note?: string): Promise<'sent' | 'queued'> {
  try {
    await api.taskAction(taskId, action, note);
    return 'sent';
  } catch (error) {
    // ApiError means the server answered, so show that message. Anything else is a network failure.
    if (error instanceof ApiError) throw error;
    await enqueue(taskId, action, note);
    return 'queued';
  }
}
