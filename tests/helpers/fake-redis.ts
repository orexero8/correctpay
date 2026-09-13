export function buildFakeRedis(): {
  redis: ReturnType<typeof createFakeRedis>;
} {
  return { redis: createFakeRedis() };
}

export function createFakeRedis(): {
  store: Map<string, string>;
  set: (
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
    nx?: string
  ) => Promise<string | null>;
  eval: (script: string, numKeys: number, ...args: string[]) => Promise<number>;
  del: (key: string) => Promise<number>;
  ping: () => Promise<"PONG">;
} {
  const store = new Map<string, string>();

  return {
    store,
    async set(
      key: string,
      value: string,
      _mode?: string,
      _ttl?: number,
      nx?: string
    ): Promise<string | null> {
      if (nx === "NX" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return "OK";
    },
    async eval(_script: string, numKeys: number, ...args: string[]): Promise<number> {
      const key = args[0];
      const token = args[numKeys];
      if (key !== undefined && token !== undefined && store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async ping(): Promise<"PONG"> {
      return "PONG";
    },
  };
}
