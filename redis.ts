import Redis from "ioredis";

// Redis client for caching — connects using REDIS_URL env var
// All cache operations are wrapped in try/catch so Redis failures
// never break the application (graceful fallback to DB)
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

// Upstash requires TLS — auto-enable if the URL contains "upstash.io"
const isUpstash = redisUrl.includes("upstash.io");

const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    keepAlive: 10000,
    ...(isUpstash && { tls: { rejectUnauthorized: false } }),
    retryStrategy(times) {
        // Retry with exponential backoff, max 3 seconds, stop after 10 retries
        if (times > 10) return null;
        return Math.min(times * 200, 3000);
    },
});

redis.on("connect", () => {
    console.log("[REDIS] Connected to Redis");
});

redis.on("error", (err) => {
    console.warn("[REDIS] Connection error:", err.message);
});

redis.on("close", () => {
    console.log("[REDIS] Connection closed");
});

/**
 * Get a cached value by key.
 * Returns parsed JSON or null if not found / Redis unavailable.
 */
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
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
