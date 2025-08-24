// cache-optimization.js - LRU and Redis caching optimizations
import { promises as fs } from 'node:fs';

import { createClient } from 'redis';
import { LRUCache } from 'lru-cache';
import RedisServer from 'redis-server';

// LRU Cache Configuration for frequently accessed data
const lruCache = new LRUCache({
  max: 500, // Maximum number of items in cache
  ttl: 1000 * 60 * 60, // TTL: 1 hour in milliseconds
  updateAgeOnGet: true, // Refresh TTL on access
  allowStale: false, // Don't return stale items
});

// Redis Server Configuration
let redisServer = null;
let redisClient = null;
let isRedisConnected = false;

// Initialize Redis connection with embedded server
async function initializeRedis() {
  try {
    // Start embedded Redis server
    redisServer = new RedisServer(6379);
    await redisServer.open();
    console.log('Embedded Redis server started on port 6379');

    // Connect Redis client
    redisClient = createClient({
      socket: {
        host: '127.0.0.1',
        port: 6379,
      },
      retryStrategy: (times) => {
        // Retry connection with exponential backoff
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    redisClient.on('error', (error) => {
      console.warn('Redis connection error:', error.message);
      isRedisConnected = false;
    });

    redisClient.on('connect', () => {
      console.log('Redis connected successfully');
      isRedisConnected = true;
    });

    redisClient.on('ready', () => {
      console.log('Redis client ready');
    });

    redisClient.on('reconnecting', () => {
      console.log('Redis reconnecting...');
    });

    await redisClient.connect();
  } catch (error) {
    console.warn('Failed to initialize Redis client:', error.message);
    isRedisConnected = false;
  }
}

// LRU Caching Functions
export function getFromLRU(key) {
  return lruCache.get(key);
}

export function setInLRU(key, value, ttl = null) {
  lruCache.set(key, value, {
    ttl: ttl || 1000 * 60 * 60 // Default 1 hour
  });
}

export function deleteFromLRU(key) {
  lruCache.delete(key);
}

export function clearLRU() {
  lruCache.clear();
}

export function getLRUStats() {
  return {
    size: lruCache.size,
    max: lruCache.max,
  };
}

// Redis Caching Functions
export async function getFromRedis(key) {
  if (!isRedisConnected || !redisClient) {
    return null;
  }

  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.warn('Redis get error:', error.message);
    return null;
  }
}

export async function setInRedis(key, value, ttl = 3600) {
  if (!isRedisConnected || !redisClient) {
    return false;
  }

  try {
    const serializedValue = JSON.stringify(value);
    await redisClient.set(key, serializedValue, {
      EX: ttl
    });
    return true;
  } catch (error) {
    console.warn('Redis set error:', error.message);
    return false;
  }
}

export async function deleteFromRedis(key) {
  if (!isRedisConnected || !redisClient) {
    return false;
  }

  try {
    await redisClient.del(key);
    return true;
  } catch (error) {
    console.warn('Redis delete error:', error.message);
    return false;
  }
}

export async function clearRedis() {
  if (!isRedisConnected || !redisClient) {
    return false;
  }

  try {
    await redisClient.flushAll();
    return true;
  } catch (error) {
    console.warn('Redis flush error:', error.message);
    return false;
  }
}

// Hybrid Caching: LRU + Redis
export async function getFromCache(key) {
  // First check LRU cache (fastest)
  let value = getFromLRU(key);
  
  if (value !== undefined) {
    return value;
  }

  // If not in LRU, check Redis
  value = await getFromRedis(key);
  
  if (value !== null) {
    // Promote to LRU cache for faster access next time
    setInLRU(key, value);
    return value;
  }

  return null;
}

export async function setInCache(key, value, ttl = 3600) {
  // Set in both LRU and Redis for consistency
  setInLRU(key, value, ttl * 1000); // LRU TTL is in milliseconds
  await setInRedis(key, value, ttl); // Redis TTL is in seconds
}

export async function deleteFromCache(key) {
  // Delete from both caches
  deleteFromLRU(key);
  await deleteFromRedis(key);
}

// Optimized Database Query Caching
export async function cachedQuery(queryKey, queryFunction, ttl = 3600) {
  // Try to get from cache first
  let result = await getFromCache(queryKey);
  
  if (result !== null) {
    return result;
  }

  // If not in cache, execute the query
  try {
    result = await queryFunction();
    
    // Cache the result
    await setInCache(queryKey, result, ttl);
    
    return result;
  } catch (error) {
    console.error('Query execution error:', error.message);
    throw error;
  }
}

// System Information Caching
export async function getCachedSystemInfo() {
  const cacheKey = 'system_info';
  const cacheTTL = 30; // 30 seconds for system info
  
  return await cachedQuery(cacheKey, async () => {
    // This would typically be a database query or expensive operation
    // For now, we'll simulate system info retrieval
    const memInfo = await fs.readFile('/proc/meminfo', 'utf8');
    const lines = memInfo.split('\n');
    const object = {};
    for (const line of lines) {
      const [k, v] = line.split(':');
      if (k && v) object[k.trim()] = Number.parseInt(v.trim().replace(' kB', ''), 10);
    }
    
    const ramTotal = object['MemTotal'] || 0;
    const ramAvailable = object['MemAvailable'] || 0;
    const ramUsed = ramTotal - ramAvailable;
    const swapTotal = object['SwapTotal'] || 0;
    const swapFree = object['SwapFree'] || 0;
    const swapUsed = swapTotal - swapFree;
    
    return {
      ram: { 
        total: ramTotal, 
        used: ramUsed, 
        available: ramAvailable, 
        usagePercent: ramTotal ? Math.round((ramUsed / ramTotal) * 100) : 0 
      },
      swap: { 
        total: swapTotal, 
        used: swapUsed, 
        usagePercent: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0 
      },
      timestamp: Date.now()
    };
  }, cacheTTL);
}

// Translation Cache Optimization
export async function getTranslationCache() {
  const cacheKey = 'translation_cache';
  return await getFromCache(cacheKey);
}

export async function setTranslationCache(cacheData) {
  const cacheKey = 'translation_cache';
  const ttl = 86_400; // 24 hours for translation cache
  await setInCache(cacheKey, cacheData, ttl);
}

// Initialize Redis on module load
initializeRedis().catch(error => {
  console.warn('Failed to initialize Redis:', error.message);
});

// Graceful shutdown
async function shutdown() {
  try {
    if (redisClient && isRedisConnected) {
      await redisClient.quit();
    }
    if (redisServer) {
      await redisServer.close();
      console.log('Embedded Redis server stopped');
    }
  } catch (error) {
    console.warn('Error during Redis shutdown:', error.message);
  }
}

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

// Export all functions
export {
  lruCache,
  redisClient,
  redisServer,
  isRedisConnected,
  initializeRedis,
  shutdown
};