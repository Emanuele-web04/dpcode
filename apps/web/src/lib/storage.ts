import { Debouncer } from "@tanstack/react-pacer";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

let fallbackLocalStorage: StateStorage | undefined;

function isStateStorage(value: unknown): value is StateStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<StateStorage>).getItem === "function" &&
    typeof (value as Partial<StateStorage>).setItem === "function" &&
    typeof (value as Partial<StateStorage>).removeItem === "function"
  );
}

export function getLocalStateStorage(): StateStorage {
  try {
    if (isStateStorage(globalThis.localStorage)) {
      return globalThis.localStorage;
    }
  } catch {
    // Some runtimes expose localStorage behind a throwing accessor.
  }

  fallbackLocalStorage ??= createMemoryStorage();
  return fallbackLocalStorage;
}

export function createDebouncedStorage(
  baseStorage: StateStorage,
  debounceMs: number = 300,
): DebouncedStorage {
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      baseStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      baseStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
