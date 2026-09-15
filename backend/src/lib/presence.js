import { randomUUID } from "node:crypto";

// One atomic snapshot: use Redis's clock, expire old leases, remove closed
// connections, renew live connections, and return a revisioned online-user list.
const SYNC_PRESENCE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttl = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local removeCount = tonumber(ARGV[3])
for i = 1, removeCount do
  redis.call('ZREM', KEYS[1], ARGV[3 + i])
end
for i = 4 + removeCount, #ARGV do
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[i])
end
if redis.call('ZCARD', KEYS[1]) > 0 then
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
end
redis.call('SET', KEYS[2], ARGV[2], 'NX')
local revision = redis.call('INCR', KEYS[3])
local result = {redis.call('GET', KEYS[2]), tostring(revision)}
local users = {}
for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
  local user = string.match(member, '^([^:]+):')
  if user and not users[user] then
    users[user] = true
    table.insert(result, user)
  end
end
return result
`;

export const presenceMember = (userId, socketId) => `${userId}:${socketId}`;

export const syncPresence = async (client, prefix, leaseMs, activeMembers = [], removedMembers = []) => {
  // Hash tags keep these three keys together if a Redis Cluster is added later.
  const keyPrefix = `{${prefix}}:presence`;
  const [epoch, revision, ...userIds] = await client.eval(
    SYNC_PRESENCE,
    3,
    `${keyPrefix}:connections`,
    `${keyPrefix}:epoch`,
    `${keyPrefix}:revision`,
    leaseMs,
    randomUUID(),
    removedMembers.length,
    ...removedMembers,
    ...activeMembers,
  );
  return { userIds: userIds.sort(), epoch, revision: Number(revision) };
};

export const createPresenceManager = ({ client, prefix, leaseMs, heartbeatMs, io, isReady }) => {
  let timer;
  let queue = Promise.resolve();
  let stopped = false;

  const update = (removedMembers = []) => {
    if (stopped) return queue;
    // Serialize this instance's mutations and read live sockets at execution time.
    // An old heartbeat must not re-add a socket after its disconnect was processed.
    queue = queue.then(async () => {
      if (!isReady()) return;
      const activeMembers = [...io.of("/").sockets.values()].map((socket) =>
        presenceMember(socket.data.userId, socket.id)
      );
      const snapshot = await syncPresence(client, prefix, leaseMs, activeMembers, removedMembers);
      io.emit("getOnlineUsers", snapshot.userIds, {
        epoch: snapshot.epoch,
        revision: snapshot.revision,
      });
    }).catch(() => console.error("Failed to synchronize Redis presence; leases will expire"));
    return queue;
  };

  return {
    update,
    start() {
      timer = setInterval(() => { void update(); }, heartbeatMs);
      timer.unref();
      return update();
    },
    async stop() {
      clearInterval(timer);
      await queue;
      stopped = true;
    },
  };
};
