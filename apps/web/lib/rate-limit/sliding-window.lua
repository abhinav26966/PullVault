-- Sliding-window-log rate limiter — Part B §10.
--
-- Atomic in Redis (Lua scripts run as a single uninterrupted unit), so a
-- burst of N concurrent requests against the same key sees a fully
-- serialised state — no GET-then-SET race window. This is the property the
-- "100 simultaneous requests" reviewer test verifies.
--
-- Storage: a sorted set per (scope, scope_id, endpoint), where each request
-- is stored as a zset entry with score = request timestamp (ms) and member
-- = a unique request id. Window enforcement = ZREMRANGEBYSCORE older than
-- now - window. Throttle = ZCARD against limit.
--
-- KEYS[1]: rate-limit zset key, e.g. "rl:{user:abc}:buy_drop"
-- ARGV[1]: now (ms, integer)
-- ARGV[2]: window_ms
-- ARGV[3]: limit
-- ARGV[4]: unique request member id
--
-- Returns:
--   {1, remaining}      on allow (remaining = limit - count_after_add)
--   {0, retry_after_ms} on block (ms until the oldest entry expires)

local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- Drop entries older than the window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  -- TTL = window + 1s safety so the key auto-purges on idle.
  redis.call('PEXPIRE', key, window + 1000)
  return {1, limit - count - 1}
end

-- Blocked. Compute retry-after = (oldest_score + window) - now.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = window
if #oldest >= 2 then
  retry = (tonumber(oldest[2]) + window) - now
  if retry < 0 then retry = 0 end
end
return {0, retry}
