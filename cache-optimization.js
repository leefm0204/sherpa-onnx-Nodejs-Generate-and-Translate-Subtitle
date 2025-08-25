// cache-optimization.js - LRU and Redis caching optimizations
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

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

// Create require function for ES modules
const require = createRequire(import.meta.url);

// Initialize Redis server and client
async function initializeRedis() {
  try {
    // Start Redis server using the npm package
    const redisServerPath = require.resolve('/usr/bin/redis-server');
    const redisConfig = {
      port: 6380, // Use a different port to avoid conflicts
      // You can add more Redis configuration options here
    };
    
    console.log('Starting Redis server...');
    
    // Start Redis server
    redisServer = new RedisServer({
      port: redisConfig.port,
      bin: redisServerPath,
      config: {
        // Optional Redis configuration
        'maxmemory': '100mb',
        'maxmemory-policy': 'allkeys-lru',
        'appendonly': 'no',
        'save': '' // Disable RDB persistence for better performance
      }
    });
    
    // Start the Redis server
    await redisServer.open();
    console.log(`Redis server started on port ${redisConfig.port}`);
    
    // Configure Redis client
    redisClient = createClient({
      socket: {
        host: '127.0.0.1',
        port: redisConfig.port,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.error('Too many retries on Redis connection. Giving up.');
            return new Error('Too many retries');
          }
          // Exponential backoff
          return Math.min(retries * 100, 5000);
        }
      },
      // Disable offline queue to fail fast if Redis is down
      disableOfflineQueue: true
    });
    
    // Set up event handlers
    redisClient.on('error', (error) => {
      console.warn('Redis client error:', error.message);
      isRedisConnected = false;
    });
    
    redisClient.on('connect', () => {
      console.log('Redis client connected');
      isRedisConnected = true;
    });
    
    redisClient.on('ready', () => {
      console.log('Redis client ready');
      isRedisConnected = true;
    });
    
    redisClient.on('reconnecting', () => {
      console.log('Redis client reconnecting...');
      isRedisConnected = false;
    });
    
    // Connect the client
    await redisClient.connect();
    console.log('Redis client connected successfully');
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
  console.error('Failed to initialize Redis:', error);
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down Redis client...');
  if (redisClient && redisClient.isOpen) {
    try {
      // Try to save data before quitting (if persistence is enabled)
      await redisClient.save();
      await redisClient.quit();
      console.log('Redis client disconnected');
    } catch (error) {
      console.error('Error during Redis client shutdown:', error);
    }
  }
  
  if (redisServer) {
    console.log('Stopping Redis server...');
    try {
      await redisServer.close();
      console.log('Redis server stopped');
    } catch (error) {
      console.error('Error stopping Redis server:', error);
    }
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
