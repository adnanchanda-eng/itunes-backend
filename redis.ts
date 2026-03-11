import Redis from "ioredis";

// Redis client for caching — connects using REDIS_URL env var
// All cache operations are wrapped in try/catch so Redis failures
// never break the application (graceful fallback to DB)
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
        // Retry with exponential backoff, max 3 seconds, stop after 10 retries
        if (times > 10) return null;
        return Math.min(times * 200, 3000);
    },
    lazyConnect: true,
});

let isConnected = false;

redis.on("connect", () => {
    isConnected = true;
    console.log("[REDIS] Connected to Redis");
});

redis.on("error", (err) => {
    isConnected = false;
    console.warn("[REDIS] Connection error:", err.message);
});

redis.on("close", () => {
    isConnected = false;
});

// Connect eagerly (but don't block server startup)
redis.connect().catch(() => {
    console.warn("[REDIS] Initial connection failed — caching disabled");
});

/**
 * Get a cached value by key.
 * Returns parsed JSON or null if not found / Redis unavailable.
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
    if (!isConnected) return null;
    try {
        const val = await redis.get(key);
        if (val === null) {
            console.log(`[CACHE MISS] ${key}`);
            return null;
        }
        console.log(`[CACHE HIT] ${key}`);
        return JSON.parse(val) as T;
    } catch {
        return null;
    }
}

/**
 * Set a cached value with a TTL in seconds.
 */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!isConnected) return;
    try {
        await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    } catch {
        // Silently fail — caching is best-effort
    }
}

/**
 * Delete a single cache key.
 */
export async function cacheDel(key: string): Promise<void> {
    if (!isConnected) return;
    try {
        await redis.del(key);
    } catch {
        // Silently fail
    }
}

/**
 * Delete all keys matching a glob pattern (e.g. "playlist:42:*").
 * Uses SCAN to avoid blocking Redis.
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
    if (!isConnected) return;
    try {
        let cursor = "0";
        do {
            const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = nextCursor;
            if (keys.length > 0) {
                await redis.del(...keys);
            }
        } while (cursor !== "0");
    } catch {
        // Silently fail
    }
}

export { redis };
export default redis;
