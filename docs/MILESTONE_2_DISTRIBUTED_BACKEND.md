# Milestone 2 — Distributed Backend: Architecture and Interview Guide

This guide explains the implementation on `feat/distributed-backend`: what problem it solves, how each component works, which behavior was verified, and where the design still has limits.

This is a locally verified distributed-development stack, not a claim that the public Render demo now runs multiple servers. No production deployment or cloud infrastructure was changed.

## Contents

1. [The problem and the interview story](#1-the-problem-and-the-interview-story)
2. [Before and after](#2-before-and-after)
3. [Who owns each kind of data](#3-who-owns-each-kind-of-data)
4. [Redis connectivity and startup](#4-redis-connectivity-and-startup)
5. [Cross-instance Socket.IO delivery](#5-cross-instance-socketio-delivery)
6. [Message and receipt flows](#6-message-and-receipt-flows)
7. [Distributed presence in detail](#7-distributed-presence-in-detail)
8. [Load balancing and sticky sessions](#8-load-balancing-and-sticky-sessions)
9. [Distributed rate limiting](#9-distributed-rate-limiting)
10. [Failure behavior and delivery guarantees](#10-failure-behavior-and-delivery-guarantees)
11. [Verification and evidence](#11-verification-and-evidence)
12. [Local setup and demo runbook](#12-local-setup-and-demo-runbook)
13. [Source-code walkthrough](#13-source-code-walkthrough)
14. [Security and production checklist](#14-security-and-production-checklist)
15. [Scaling tradeoffs and next steps](#15-scaling-tradeoffs-and-next-steps)
16. [Interview questions and answers](#16-interview-questions-and-answers)
17. [Résumé bullets and claims](#17-résumé-bullets-and-claims)
18. [Terminology and references](#18-terminology-and-references)

## 1. The problem and the interview story

### What this actually accomplishes

The original chat application had one Node.js process. That process accepted HTTP requests, authenticated sockets, tracked online users, and emitted messages and receipts. MongoDB already stored permanent messages and receipt timestamps.

That works when everyone connects to the same process. It fails as a horizontal-scaling design because an HTTP request handled by one process cannot automatically emit to sockets owned by another process.

Example:

```text
Alice's socket → Backend 1
Bob's socket   → Backend 2

Alice's send request → Backend 1 → MongoDB save succeeds
Backend 1 emits to Bob's room → no local Bob socket → Bob misses the live event
```

The message may still exist in MongoDB. The failure is specifically real-time routing, not necessarily database persistence. Bob could later fetch the conversation and see the saved message, but the expected instant delivery and receipt experience would be broken.

The milestone removes that single-process constraint. The two backends can coordinate events and ephemeral state while using the same permanent database.

This does not mean Redis magically makes every operation faster. The main benefit is correctness when multiple backend replicas serve the same application. Increased capacity is a possible benefit of adding replicas, but actual throughput must be measured.

### A 30-second interview answer

> Whisper originally depended on one Node.js process for Socket.IO routing and online-user tracking. I made it run across two backend replicas behind NGINX, using the Socket.IO Redis adapter for cross-node events and Redis leases for multi-device presence. I also implemented shared Redis rate limits and tested messages, delivered/read receipts, polling affinity, crash cleanup, and Redis reconnection with real services.

### A two-minute interview answer

> The original limitation was process-local state. Although messages were saved to MongoDB, rooms and online-user tracking were local to the Socket.IO server that accepted the connection. Adding a second backend would cause some message and receipt events to miss their recipients and produce inconsistent online lists.
>
> I separated the responsibilities. MongoDB remains the permanent source of truth for users, messages, and receipt timestamps. The Redis adapter forwards room broadcasts across instances. A separate Redis sorted set tracks each live socket with an expiration timestamp, so closing one device does not incorrectly mark the whole user offline and a crashed process does not leave permanent stale presence.
>
> NGINX round-robins ordinary HTTP requests and hashes the authentication cookie for Socket.IO session affinity. That preserves long-polling fallback while letting different users behind the same IP reach different instances. Redis Lua scripts make presence snapshots and rate-limit increments atomic.
>
> I verified the design with real Redis and MongoDB, deliberately connected users to different servers, checked persisted receipt timestamps, and injected failures into test-owned backends. I also simulated losing Redis connectivity and verified that APIs fail closed and the existing sockets resume cross-node delivery after the clients reconnect. The current topology is a local development milestone, not a production high-availability deployment.

### What an employer can learn from this work

The important achievement is identifying a real architectural constraint and validating its solution. This demonstrates process isolation, distributed coordination, networking, authentication boundaries, concurrency handling, integration testing, and honest reasoning about failures—not merely knowing how to install Redis.

## 2. Before and after

### Before: one process

```text
Browsers
   │ HTTP + Socket.IO
   ▼
One Node.js / Express / Socket.IO backend
   ├── Local Socket.IO room membership
   ├── connectedSocketsByUser: Map<userId, Set<socketId>>
   ├── Message and receipt handlers
   └── MongoDB: permanent users/messages/receipts
```

The local map handled multiple tabs within one process, but it could not see connections on another process. Merely attaching a Redis adapter while still broadcasting that map would spread incorrect, incomplete online lists to every node.

### After: two cooperating processes

```text
                        http://localhost:8080
Browsers ───────────────► NGINX
                           │
               ┌───────────┴───────────┐
               ▼                       ▼
           Backend 1               Backend 2
           Express                 Express
           Socket.IO               Socket.IO
               │                       │
               ├─────────┬─────────────┤
               ▼         ▼             ▼
             Redis                 MongoDB
       ┌─────────┼──────────┐    Users, messages,
       ▼         ▼          ▼    receipt timestamps
    Pub/Sub   Presence    Rate-limit
    adapter   leases      counters
```

Both replicas use the same JWT signing secret, MongoDB database, Redis service, and Redis namespace. Their instance identifiers are different so logs and tests can distinguish them.

A persistent WebSocket is not passed back and forth between processes. One backend still owns each physical connection. Redis coordinates delivery to whichever backend owns the target socket.

### Original milestone mapping

| Requirement | Implementation |
| --- | --- |
| Add Redis | `ioredis` command/publisher/subscriber connections and a Compose Redis service |
| Add Socket.IO Redis adapter | `createAdapter()` in `initializeRealtime()` |
| Shared online-user presence | Redis sorted-set leases; no application-level online-user map |
| Run two backends | `backend1` and `backend2` Compose services |
| Load balancer | NGINX, HTTP round-robin, cookie-based Socket.IO affinity |
| Cross-instance messages and receipts | Real-service integration tests in both directions and through NGINX |
| Redis-backed rate limiting | Atomic shared counters for HTTP policies, socket connection attempts, and receipt events |

## 3. Who owns each kind of data

| Data | Owner | Why |
| --- | --- | --- |
| Users and password hashes | MongoDB | Persistent application records |
| Message content and IDs | MongoDB | Must survive backend restarts |
| `deliveredAt` / `readAt` | MongoDB | Receipt history belongs to the saved message |
| Live socket connections | The backend that accepted each socket | A network connection is attached to a process |
| Local room memberships | Socket.IO adapter on each backend | Determines which locally owned sockets match an event |
| Cross-node event forwarding | Redis Pub/Sub via the adapter | Lets peer backends deliver matching broadcasts |
| Online-user presence | Separate Redis keys | Shared, temporary connection leases |
| Request/event quotas | Separate Redis keys | One counter across all replicas |
| Pending outgoing messages | Existing browser IndexedDB outbox | Allows user-side retries; not introduced by this milestone |

Presence records and rate counters are actual Redis keys. Adapter broadcasts are transient Pub/Sub traffic, not stored chat-history keys. [Socket.IO Redis adapter documentation](https://socket.io/docs/v4/redis-adapter/)

Do not say “I moved the database into Redis.” The permanent database is still MongoDB.

## 4. Redis connectivity and startup

### Why three Redis connections?

`backend/src/lib/redis.js` constructs three `ioredis` clients:

1. `redis`: normal commands, presence scripts, rate-limit scripts.
2. `redisPublisher`: adapter publication and inter-server requests.
3. `redisSubscriber`: adapter subscriptions.

The subscribed connection has a distinct role and is not reused for arbitrary presence or quota commands. Separating clients also makes their readiness easier to inspect.

Connections are lazy: constructing a module does not connect to Redis immediately. Startup first validates required configuration, then explicitly connects dependencies.

### Startup sequence

```text
Validate MONGODB_URI, JWT_SECRET, REDIS_URL and configuration
   ↓
Connect MongoDB and all Redis clients
   ↓
Initialize user/message indexes
   ↓
Attach the Redis adapter and start presence synchronization
   ↓
Listen for HTTP / Socket.IO traffic
```

The original backend listened first and caught MongoDB connection failures without failing startup. The new flow does not intentionally accept application traffic before its required dependencies connect.

Initializing the message model is relevant to scaling: deduplicating concurrent sends relies on the unique `{ senderId, clientMessageId }` database index. A local JavaScript check is not sufficient when two processes can insert at the same time.

### Connection options and their purpose

| Option | Value | Reason |
| --- | --- | --- |
| `lazyConnect` | `true` | Explicit startup controls dependency connection |
| `enableOfflineQueue` | `false` | Do not silently queue application commands throughout an outage |
| `connectTimeout` | 5 seconds | Bound initial connection attempts |
| `commandTimeout` | 3 seconds | Bound individual Redis command waiting |
| `maxRetriesPerRequest` | 1 | Avoid indefinite command retries |
| `retryStrategy` | Increasing delay, capped at 2 seconds | Retry the connection after temporary connectivity loss |

These are pragmatic development defaults, not benchmark-derived optimal values. Redis command failures can still be ambiguous: the server might execute a command just before the client loses its response. A retried rate-limit increment can therefore be conservative. This design does not provide exactly-once execution of Redis commands.

### Liveness versus readiness

`GET /health` answers whether the process is alive. `GET /ready` answers whether MongoDB is connected and all three Redis clients report ready.

Both return an instance identifier. HTTP responses also include `X-Instance-Id`, and authenticated sockets receive a `serverInfo` event.

Readiness checks connection state, not every possible application permission or capacity condition. For example, a Redis ACL error or memory exhaustion can fail a command even when the TCP connection is ready. Rate-limit middleware returns 503 for those command failures.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, the backend closes Socket.IO/HTTP, waits for queued presence cleanup, closes Redis clients, and disconnects MongoDB. A ten-second deadline prevents shutdown from hanging indefinitely.

A successful graceful shutdown removes live connection records. A hard kill cannot execute this cleanup, so expiring presence leases are the fallback—not a replacement for graceful cleanup.

## 5. Cross-instance Socket.IO delivery

### User rooms remain useful

Every authenticated socket joins `user:<userId>`. If Bob has a laptop on Backend 1 and a phone on Backend 2, both sockets join the same room name on their own server.

Emitting to that room reaches all of Bob's matching connections across the cluster. This avoids storing a global “user → backend address” directory and manually forwarding each event to a specific backend.

The JWT cookie determines `socket.data.userId`; the client does not choose its identity with a query parameter. MongoDB must contain the authenticated user.

### What the adapter changes

The existing application-level emit calls remain room based. The adapter sends a broadcast to matching local sockets and publishes it for peer servers. Peers deliver to their own matching sockets. The browser does not need to know which server hosts its conversation partner. [Socket.IO adapter behavior](https://socket.io/docs/v4/redis-adapter/)

Adapter channels use an application-specific prefix, `${REDIS_PREFIX}:socket.io`, so separate environments should not accidentally communicate through the same channels.

`publishOnSpecificResponseChannel: true` limits inter-server request responses to the requesting node's response channel. Ordinary message correctness does not depend on that optimization.

### What the adapter does not do

It does not store messages permanently, replace MongoDB, move a physical connection to another process, provide the custom presence data model, or enforce quotas. The standard Pub/Sub adapter also does not support Socket.IO connection-state recovery. [Adapter supported features](https://socket.io/docs/v4/redis-adapter/)

## 6. Message and receipt flows

### Sending a message

```text
Alice browser creates clientMessageId and saves pending outbox record
   ↓
POST /api/messages/send/<bobId> through NGINX
   ↓
General IP quota → authentication → sender quota → upload quota if applicable
   ↓
Validate receiver ID and message payload
   ↓
Return an existing MongoDB message if sender/clientMessageId already exists
   ↓
Upload image to Cloudinary if needed, then save a new message to MongoDB
   ↓
Emit newMessage to user:<bobId>
   ↓
Redis adapter forwards the event to peer instances
   ↓
Bob's owning backend emits to Bob's socket(s)
```

The send endpoint returns 201 for a new message and 200 for an existing idempotent message. The HTTP request may run on a different instance than Alice's own socket; this is expected and does not invalidate authentication.

### Idempotency across replicas

There are two safeguards in the existing send workflow:

1. Check for an existing message for the sender and `clientMessageId`.
2. Rely on MongoDB's unique index and handle duplicate-key errors if concurrent inserts race.

The first saves unnecessary work during ordinary retries. The second is the actual cross-process safety mechanism. Two processes can both pass the first check, but only one matching document can be inserted once the unique index exists.

This deduplicates message documents. It is not a blanket exactly-once guarantee: concurrent image retries may still perform more than one Cloudinary upload, and returning an already-saved message does not re-publish a missed real-time event.

### Delivered receipts

Bob emits `messagesDelivered` with a batch of message IDs. The backend checks a shared receipt-event quota, filters IDs, and queries only messages whose `receiverId` matches Bob's authenticated identity.

It sets `deliveredAt` only where the field is still null, reads the resulting saved receipt state, groups receipts by sender, and emits `messageStatusUpdated` to each sender's user room. It also emits the receipts to Bob's own room so his devices can synchronize.

The adapter forwards sender-room events even if Alice is connected to another backend. The acknowledgement contains `{ ok: true, receipts }` on success.

“Delivered” means Bob's client reported receiving the message. It does not prove a human saw it or that a mobile push notification was delivered.

### Read receipts

Bob emits `messagesRead` when the conversation is visible. The handler queries only Bob's incoming messages. A MongoDB update pipeline uses `$ifNull` so it preserves existing delivery and read timestamps.

If Bob reads a message before a separate delivery acknowledgement is recorded, the same pipeline fills `deliveredAt` as well. Reading implies delivery in this model.

The backend then reads the persisted timestamps and broadcasts them to senders and Bob's devices.

### The concurrency correction in this milestone

The original delivery handler first found undelivered messages and later updated them by ID. Another instance could mark one read between those operations. An unconditional delivery update could overwrite the timestamp that the read pipeline had just established.

The delivery update now also filters `deliveredAt: null` at write time. Together with the read pipeline, this makes repeated/concurrent receipt processing preserve already-recorded timestamps.

The integration suite issues delivery and read acknowledgements concurrently from different devices and checks that repeating them does not change the saved timestamps.

### Existing browser limitations to remember

The browser's receipt-emission helper currently does not consume server acknowledgements or automatically retry a rejected receipt batch. The protocol supports acknowledgements, and the tests use them, but the UI may need a later conversation fetch or another eligible receipt emission to recover after a rate limit or outage.

Likewise, this milestone does not introduce a full automatic reconnect catch-up protocol. MongoDB history is available, but “fetchable after reconnect” is different from “every missed event is replayed automatically.”

## 7. Distributed presence in detail

### The definition of online

A user is online if Redis contains at least one unexpired lease for that user's live Socket.IO connections. Being signed in alone does not mean online.

Each member identifies one connection:

```text
<userId>:<socketId>
```

For example:

```text
Bob laptop → bobId:socketLaptop
Bob phone  → bobId:socketPhone
```

The backend does not maintain an application-level online-user map anymore. It does enumerate Socket.IO's necessary local socket registry to renew the connections it actually owns. Local connection ownership still exists; shared user-presence authority lives in Redis.

### Redis keys

For `REDIS_PREFIX=whisper`:

| Key | Type | Contents |
| --- | --- | --- |
| `{whisper}:presence:connections` | Sorted set | Connection members with lease-expiration millisecond scores |
| `{whisper}:presence:epoch` | String | Random generation identifier for this presence state |
| `{whisper}:presence:revision` | Integer string | Monotonically incremented snapshot revision within the epoch |

The braces are Redis hash tags. They keep the three presence keys in the same hash slot if a compatible Redis Cluster deployment is introduced later. The current application still uses a standalone Redis connection; braces alone do not make it a Redis Cluster implementation.

### Why a sorted set?

The score stores `expiresAt`, so a range removal can delete connections whose leases have elapsed. Distinct members naturally support multiple devices. A plain global “online users” set would require another mechanism to track which user still has a valid connection.

A simple user-level counter also needs crash repair: if a process dies without decrementing, the counter can remain positive forever. Connection leases make stale entries bounded in time without assuming disconnect handlers always execute.

### One atomic synchronization operation

`syncPresence()` runs a Lua script with the following logic:

1. Read Redis's clock using `TIME`.
2. Remove scores at or before now.
3. Remove explicitly disconnected connection members.
4. Renew currently owned active members to `now + leaseMs`.
5. Refresh the whole sorted set's TTL to twice the lease duration when nonempty.
6. Create an epoch if one does not exist.
7. Increment the revision.
8. Return unique online-user IDs and revision metadata.

The sorted-set score is the per-connection lease. The key TTL is an additional cleanup mechanism if all backends stop renewing the set. Redis does not automatically expire individual sorted-set members; the script removes them by score.

Lua keeps the cleanup, renewal, and snapshot together so another instance cannot interleave changes halfway through this operation. Redis scripts execute atomically, but long scripts block other Redis activity, which is an important tradeoff. [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/)

Using Redis's clock avoids requiring perfectly synchronized Node.js clocks for lease decisions. It does not eliminate every timing issue: long pauses, network delays, or Redis clock changes can still affect presence.

### Heartbeat values

The normal module defaults are a 10-second heartbeat and 30-second lease. Compose uses a faster local demonstration configuration: a 1-second heartbeat and 6-second lease.

The configuration requires at least three heartbeat intervals per lease. That gives some room for delayed renewals instead of expiring a connection after one missed heartbeat.

After a hard crash, stale presence generally remains until the last lease expires and another instance runs synchronization. With the Compose values and an otherwise healthy system, that is approximately the remaining six-second lease plus up to one heartbeat interval. It is not an unconditional seven-second service-level guarantee.

### Connect and disconnect behavior

On connection, the socket joins its authenticated user room and queues presence synchronization. On disconnect, its member is explicitly removed and a new shared online list is broadcast.

If Bob's laptop disconnects while his phone remains connected on another instance, only the laptop member disappears. Bob remains in the deduplicated user list.

If the backend crashes, neither connection cleanup nor an immediate offline broadcast can run. Surviving backends prune old leases on their periodic synchronization and publish an updated list.

### Avoiding a local heartbeat race

The presence manager serializes updates through a promise queue. It reads the local live-socket registry when a queued operation executes—not when it was originally requested.

Otherwise, an old heartbeat could capture a socket, wait behind Redis work, and re-add it after a later disconnect removed it. Serialization and execution-time enumeration avoid that local stale-renewal problem. Leases remain the fallback when cleanup cannot reach Redis.

### Why revisions and epochs?

Snapshots are created atomically, but broadcasts from different backends can arrive in a different order. The browser receives:

```text
getOnlineUsers(userIds, { epoch, revision })
```

It ignores an older/equal revision from the current epoch. The epoch allows a lower revision to be accepted when Redis presence state is recreated after loss. The browser also resets this tracking on a fresh socket connection.

This protects against ordinary stale snapshots within one state generation. It is not a durable globally ordered event log, and it does not solve arbitrary old-generation packets arriving across a Redis failover boundary.

### Presence consistency and cost

Presence is eventually consistent at the browser boundary. Individual Redis snapshots are atomic, but detection and event propagation take time. A network partition may temporarily mark a user offline even if their physical browser connection remains open.

The current snapshot walks all active connection members and broadcasts the full user list. It is intentionally straightforward for a portfolio-sized application. With many nodes and connections, repeated global scans and broadcasts become a bottleneck; see the scaling section for a more advanced alternative.

## 8. Load balancing and sticky sessions

### Two different routing needs

NGINX uses two upstream pools over the same backends:

- Ordinary HTTP requests use round-robin selection.
- `/socket.io/` requests use consistent hashing over the JWT cookie, with client IP as the unauthenticated fallback.

JWT verification is stateless across replicas because they share the signing secret and database. Therefore, a REST request does not need to follow the user's socket owner.

Socket.IO long-polling is different: successive requests carry an Engine.IO session identifier owned by the backend that established it. They must keep reaching that backend. [Socket.IO multiple-node guidance](https://socket.io/docs/v4/using-multiple-nodes/)

### Why not just round-robin Socket.IO?

If Backend 1 creates a polling session and the next polling request goes to Backend 2, Backend 2 does not know that session ID. The Redis adapter forwards application events; it does not replicate the underlying transport session.

This is why a Redis adapter does not remove the need for sticky sessions while long-polling is enabled.

### Why hash the cookie rather than IP?

Many users share an IP behind home Wi-Fi, a university network, or a corporate NAT. IP affinity would place them on the same backend and can also make a two-user local demo fail to demonstrate cross-node routing.

Hashing the authentication cookie spreads independently authenticated users while keeping one user's unchanged token stable during its socket session. The token itself is not logged or copied into presence keys.

This is a pragmatic local design, not a general transport-session affinity system. Changing a JWT while a polling session is still active can change its backend mapping. A production deployment with token rotation should use a dedicated affinity cookie/session mechanism or reconnect deliberately when the authentication token changes.

### WebSocket forwarding and timeouts

NGINX forwards HTTP/1.1 `Upgrade` and `Connection` headers. The read/send timeouts are 75 seconds, above Socket.IO's default combined ping interval and ping timeout. The integration suite verifies both polling-only sessions and polling-to-WebSocket upgrades.

The configuration uses Docker's DNS resolver and dynamically resolves backend names, which matters when Compose recreates containers with new IP addresses. NGINX 1.28 supports this upstream-resolution configuration. [NGINX upstream documentation](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)

### Forwarded IPs and trusted proxies

NGINX overwrites `X-Forwarded-For` with the direct client's address rather than appending an untrusted header. The Compose backends trust exactly one proxy hop. Socket authentication attempts use the same configured forwarded-address boundary.

Only use this trust setting when that network boundary is true. A publicly reachable backend that blindly trusts a supplied forwarding header would allow users to choose new IP identities and bypass IP quotas. [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/)

Backend diagnostic ports are bound to host loopback in Compose. Production should not expose bypass ports publicly.

## 9. Distributed rate limiting

### Why a shared counter matters

With independent in-memory limits, two backends each allowing 60 sends would allow up to 120 across the system. More replicas would increase the effective quota further.

The Redis key does not include an instance identifier. Requests for the same identity and policy therefore consume the same counter regardless of the backend selected.

### Implemented policies

| Policy | Identity | Default budget | Window | Location |
| --- | --- | --- | --- | --- |
| General API | Client IP | 300 requests | 1 minute | `/api` before JSON body parsing |
| Authentication | Client IP | 20 attempts | 15 minutes | Login and signup share one policy |
| Message sends | Authenticated user ID | 60 attempts | 1 minute | After authentication, before controller |
| Image/profile uploads | Authenticated user ID | 10 attempts | 1 hour | Shared upload policy, only when image/profile data exists |
| Socket connection attempts | Client IP | 60 attempts | 1 minute | Socket.IO authentication middleware |
| Delivery/read receipt events | Authenticated user ID | 120 events | 1 minute | Both receipt handlers share one policy |

Environment variables can override budgets. These values are development defaults, not tuned production abuse thresholds. Invalid attempts also consume quotas; changing route parameters or device connections should not reset them.

General API limits still apply to authenticated send/upload requests. An allowed sender quota does not override an exhausted IP quota.

### Key structure

```text
<prefix>:rate:<policy>:<sha256(identity)>
```

Hashing avoids storing raw IPs/user IDs in key names and keeps the format consistent. It is not encryption or anonymization: an IP address has a small enough search space that a plain hash can be guessed. Treat these keys as potentially sensitive operational data.

### Atomic fixed-window algorithm

The Lua script increments the counter and sets its millisecond expiration on the first hit. It returns the hit count and remaining TTL. If it encounters a key without expiration, it restores the policy TTL.

The decision is `hits <= limit`. Denied requests also increment the counter but do not keep extending the window. A new window begins after expiration.

The fixed window starts with the first request, not at the wall-clock start of each minute. This is simple and predictable, but still allows a boundary burst: a client can use one full quota immediately before expiry and another immediately afterward.

Separate `INCR` and `PEXPIRE` calls would risk leaving a permanent counter if the process died between them. The Lua script keeps both together.

### Client-visible behavior

HTTP responses include `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`. An exhausted budget returns 429 plus `Retry-After` and a JSON message. A Redis connection/command failure returns 503 rather than bypassing the protection.

Receipt acknowledgements use `RATE_LIMITED` with a retry delay or `SERVICE_UNAVAILABLE`. Handshake failures expose rate-limit metadata through Socket.IO's connection error data.

When policies stack, the headers reflect the most recently executed policy rather than a combined report of every budget. The browser should honor the error response and retry delay.

### What is and is not protected

Express middleware protects HTTP endpoints, not arbitrary Socket.IO events. The two receipt event handlers therefore explicitly consume Redis quotas.

The socket-attempt limiter runs at Socket.IO namespace authentication. It is not an edge-level defense against every Engine.IO handshake packet, malicious open TCP connection, or volumetric attack. Add reverse-proxy/CDN connection controls for those threats.

Exact-IP policies also have limitations: many legitimate users can share one NAT IP, and attackers can rotate IPs or IPv6 addresses. More advanced production policies can combine account/IP/network-prefix identities and use sliding windows or token buckets.

### Why a custom Redis script instead of another middleware package?

The implementation uses one small Redis primitive for HTTP and socket workflows so its behavior is visible and testable. It is fixed-window counting, not an attempt to invent a universal anti-abuse platform.

Maintained libraries such as `express-rate-limit` with `rate-limit-redis` are valid alternatives, particularly for standardized HTTP policy features and IPv6 identity handling. The architectural requirement is shared, atomic counters—not a particular package name.

## 10. Failure behavior and delivery guarantees

| Failure | Expected behavior | Important limitation |
| --- | --- | --- |
| One browser tab closes | Remove that connection; other tabs/devices keep the user online | Presence broadcasts are not instantaneous everywhere |
| Backend receives SIGTERM | Close connections, drain presence cleanup, disconnect dependencies | Long/outstanding work can hit the shutdown deadline |
| Backend receives SIGKILL | No cleanup; remaining backends remove expired leases | Stale presence exists until lease expiry/synchronization |
| Redis connectivity is lost | `/ready` returns 503; APIs reject with 503; receipt processing rejects | Existing physical WebSockets can remain connected |
| Redis connection recovers | Clients reconnect; adapter subscriptions resume; heartbeats renew presence | Pub/Sub does not replay events missed during the outage |
| Redis state is lost | Presence epoch changes, leases rebuild from owned sockets, rate windows reset | No persisted global quota history in local Redis |
| MongoDB is unavailable | Readiness/API gate rejects once disconnection is observed | In-flight operations may fail separately; Redis does not store history instead |
| Message saved but backend dies before emit | Saved document remains available for history fetch/idempotent retry | No transactional outbox guarantees publication |
| Emit occurs but recipient is disconnected | Recipient can fetch persisted history later | No automatic server-side event replay is added here |
| Upload succeeds but MongoDB insert loses a duplicate race | Only one message document should exist | An extra Cloudinary upload may need cleanup |

Redis Pub/Sub is at-most-once: a subscriber that misses a publication does not later receive a replay from Pub/Sub. [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/)

The save-before-emit ordering protects the persisted message against a normal application-process crash after saving, but saving and publishing are still separate operations. Database durability itself also depends on the MongoDB deployment and write concern.

Do not describe this as “zero message loss” or “exactly-once delivery.” A stronger design would atomically save a message and outbox record, have a worker publish/retry, and make consumers deduplicate re-delivery. Browser reconnect synchronization would complement that design.

### Why fail closed during Redis problems?

The application prioritizes consistent cluster behavior and quotas over accepting potentially unprotected requests. If Redis cannot enforce limits, allowing each node to proceed independently would violate the shared-limit guarantee.

The downside is availability: Redis becomes a required dependency even for API reads. A future design could selectively allow safe reads with a documented fallback policy, while still failing closed for login, sends, uploads, and other sensitive workflows.

### What the failure tests prove

The hard-kill tests terminate isolated child backends owned by the test runner, not the main backend containers. They verify lease cleanup and surviving users' connections. The Redis-failure test partitions two test-owned backends through a TCP proxy and verifies recovery on their existing sockets.

These tests do not prove a cloud region can fail over, a browser transparently reconnects after its NGINX-selected backend dies, or Redis replicas promote correctly during failover. The implementation and the test scope should not be confused.

## 11. Verification and evidence

The test infrastructure uses real Redis, MongoDB, two backend services, and NGINX. Unit tests cover isolated logic; integration tests prove process boundaries and saved database state.

Verification results are recorded in the final section. The integration suite has 19 named behavior checks plus its outer test, which Node reports as 20 tests. That is not a concurrent-user capacity measurement.

### Integration checks

1. Both backends report ready and NGINX serves the built frontend.
2. Ordinary NGINX HTTP requests reach both backends.
3. NGINX does not trust a client-supplied forwarded IP.
4. Unauthenticated sockets are rejected.
5. Users deliberately attached to different servers exchange messages and delivered/read receipts in both directions.
6. Retrying the same client message ID on the other backend produces one message document.
7. A sender cannot mark their own outgoing messages as the receiver's read messages.
8. A user remains online until their last device disconnects.
9. Polling-only sockets through NGINX remain sticky and different authenticated users can reach different nodes.
10. Polling upgrades to WebSocket through NGINX.
11. Concurrent delivery/read updates preserve timestamps across devices and replicas.
12. Hard-killed test backends leave only bounded stale presence.
13. Graceful test backend shutdown exits successfully and removes presence.
14. Redis network loss causes fail-closed behavior and subscriptions recover on the same sockets.
15. Real Redis presence tracks multiple connections, expires leases, and changes epoch after isolated state loss.
16. Concurrent quota increments from two Redis clients allow exactly the configured number and reset after expiry.
17. HTTP send quotas are shared across replicas and return 429 with `Retry-After`.
18. Receipt-event quotas are shared across devices on different backends.
19. Login quotas cannot be reset by choosing another backend.

The polling routing test sometimes creates a new signed test token for Bob with a random `jti` until his cookie hashes to a different node. It does not bypass verification or create an unauthenticated user. This makes the cross-node assertion deliberate instead of relying on a lucky first assignment.

### Test safety

The Compose runner uses the local database and creates accounts with a run-specific UUID. Cleanup deletes only those users and messages sent by those test users, plus explicitly owned Redis test keys. It does not drop databases, truncate collections, flush Redis, or kill unrelated processes.

Never point `TEST_MONGODB_URI` at production. Tests intentionally create data and exercise quotas. The Redis network fault proxy only supports local `redis://` connectivity, not a production TLS deployment.

If a test runner is killed before cleanup, disposable `@example.test` accounts may remain in the local database. Normal presence records still expire. Inspect exact run IDs before manually removing anything.

### What has not been benchmarked or verified

There is no measured production concurrent-user capacity, messages-per-second target, p95 end-to-end latency, cloud failover SLO, or region-level resilience claim. Cloudinary image delivery is not part of the text-message integration tests. UI appearance is checked by the frontend build and serving smoke test, not a full browser visual regression suite.

## 12. Local setup and demo runbook

### Prerequisites

Use Docker Desktop with Compose v2. Node.js is required for host-side unit tests; the Docker builds and test runner supply Node 24 inside containers.

The default host ports must be free:

| Service | Host address | Purpose |
| --- | --- | --- |
| NGINX | `http://localhost:8080` | Normal browser entry point |
| Backend 1 | `http://localhost:5001` | Loopback diagnostic/testing |
| Backend 2 | `http://localhost:5002` | Loopback diagnostic/testing |
| Redis | `127.0.0.1:6380` | Optional host-side debugging |
| MongoDB | `127.0.0.1:27018` | Isolated local database |

Inside Docker, both backends listen on port 5001; Docker maps Backend 2 to host port 5002. They are separate containers, so that internal port does not conflict.

### Start the complete demo

From the repository root:

```sh
docker compose up --build -d --wait
docker compose ps
```

Open `http://localhost:8080`. Create two demo accounts in separate browser profiles or a normal/incognito pair. Two tabs in one profile share the JWT cookie, so use separate profiles when demonstrating different users.

Compose creates its own MongoDB volume and hardcodes the local database/service URLs. It does not copy or read `backend/.env` into the images. An existing production database is not migrated or cloned into this local stack.

The default development JWT secret is deliberately labeled local-only. If setting a custom `JWT_SECRET`, keep it identical across backends and the test runner. Do not print the secret during an interview demo.

### Images and Cloudinary

Text chat works without Cloudinary credentials. Image/profile uploads still depend on the existing Cloudinary integration. Supply `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` explicitly via the shell environment or a local untracked environment file used with Compose.

Do not commit real credentials. The app and NGINX cap JSON/request bodies at roughly 2 MiB. Base64 increases image size, so the raw image allowance is smaller than 2 MiB. This is not an image optimization or direct-upload redesign.

### Run tests

```sh
npm test --prefix backend
docker compose build integration-tests
docker compose run --rm --no-deps integration-tests
```

The last command assumes the stack is already healthy. To let Compose start dependencies when needed, use:

```sh
docker compose run --rm --build integration-tests
```

That command may rebuild/recreate backends, so do not run it during a live demo conversation you need to preserve uninterrupted.

### Run Vite separately if desired

Set `VITE_BACKEND_URL=http://localhost:8080` when launching Vite, or use the provided `frontend/.env.example` as a starting point for an untracked local environment file. Restart Vite after changing environment values.

Without that override, development retains the original direct `localhost:5001` backend default. The production-built Compose frontend uses same-origin `/api` and Socket.IO traffic through NGINX.

### Inspect without changing state

```sh
curl http://localhost:5001/ready
curl http://localhost:5002/ready
curl http://localhost:8080/ready
docker compose logs --tail=50 backend1 backend2 load-balancer
docker compose exec redis redis-cli ZRANGE '{whisper}:presence:connections' 0 -1 WITHSCORES
docker compose exec redis redis-cli GET '{whisper}:presence:revision'
```

Do not show authentication cookies or private message payloads in recorded screenshots. The Redis presence key shows socket/user IDs and lease scores, not permanent message content.

### Stop and restart

```sh
docker compose stop
docker compose start
```

Stopping retains local MongoDB history. Redis is configured without persistence, so its temporary state resets when its process restarts. Presence rebuilds from current sockets and rate windows start fresh.

To rebuild after source changes, use `docker compose up --build -d --wait`. Avoid volume-removal commands unless you deliberately want to erase the local chat database.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| Port binding fails | Stop another local backend or change Compose host ports |
| Backend exits at startup | Required variables, valid Redis URL, dependency connectivity, index initialization |
| Messages work directly but polling fails through NGINX | Affinity cookie, `/socket.io/` location, upgrade/forwarding headers |
| A user appears offline briefly after a pause | Heartbeat/lease values, event-loop pauses, Redis connectivity |
| HTTP returns 429 | Exhausted policy and `Retry-After`; do not solve it by switching nodes |
| HTTP returns 503 | Readiness plus Redis/MongoDB logs; do not silently bypass shared limits |
| Image upload fails | Cloudinary credentials, body-size limit, upload quota |
| Vite only reaches one backend | Configure `VITE_BACKEND_URL` to the load balancer |
| NGINX serves stale/unavailable backend IP | Dynamic resolver configuration and backend readiness |

## 13. Source-code walkthrough

| File | What to explain |
| --- | --- |
| `backend/src/lib/config.js` | Shared settings, required-variable validation, lease/heartbeat relationship, budgets, instance ID |
| `backend/src/lib/redis.js` | Separate clients, explicit connect, bounded waiting, readiness, graceful close |
| `backend/src/lib/presence.js` | Lease sorted set, Redis clock, atomic snapshots, epoch/revision, serialized manager |
| `backend/src/lib/socket.js` | Adapter initialization, authenticated rooms, connection quota, presence hooks, receipt routing |
| `backend/src/lib/rateLimit.js` | Shared fixed-window Lua primitive, hashed identities, policy middleware, fail-closed acknowledgements |
| `backend/src/index.js` | Dependency-first startup, indexes, health/readiness, API gate, parsing limit, shutdown |
| `backend/src/lib/db.js` | MongoDB connection failures propagate instead of being swallowed |
| `backend/src/controllers/message.controller.js` | Receiver validation, existing idempotent MongoDB workflow, save-before-emit |
| `backend/src/routes/auth.route.js` | Shared login/signup quota and profile upload protection |
| `backend/src/routes/message.route.js` | Authenticated sender quota and conditional upload quota |
| `frontend/src/lib/backendUrl.js` | One configurable backend origin for HTTP and sockets |
| `frontend/src/lib/axios.js` | API URL derived from the shared origin |
| `frontend/src/store/useAuthStore.js` | Socket origin, disconnect state, stale presence-revision filtering |
| `Dockerfile` | Frontend build, backend runtime without dev dependencies, separate integration-test stage, non-root runtime |
| `compose.yaml` | Dependency health gates, isolated MongoDB volume, Redis configuration, two replicas, NGINX, test profile |
| `deploy/nginx.conf` | Round-robin HTTP versus sticky sockets, Docker DNS, trusted forwarding, upgrade, timeouts |
| `backend/test/unit.test.js` | Isolated validation, fail-closed behavior, identity format, local queue race |
| `backend/test/distributed.integration.test.js` | Real-service and cross-process evidence, exact cleanup, fault injection |

In an interview, start with the architecture problem, then open the adapter initialization and presence script. Do not begin by reading every import or reciting package versions.

## 14. Security and production checklist

The Compose topology deliberately uses local-only HTTP and unauthenticated development Redis/MongoDB. It is not a production-ready security configuration.

Before public deployment:

- Replace the development JWT secret with a long random secret shared securely between replicas.
- Terminate HTTPS/WSS at the edge and use secure cookie settings. The local stack uses `NODE_ENV=development` so authentication cookies work over local HTTP.
- Keep Redis and MongoDB private; add authentication, TLS where appropriate, ACLs, backups, and restricted access.
- Protect adapter channels from untrusted publishers and subscribers. Anyone with inappropriate Redis access can potentially inspect or forge adapter traffic. [Socket.IO Redis security considerations](https://socket.io/docs/v4/redis-adapter/)
- Remove publicly accessible direct backend ports and configure the exact trusted proxy topology.
- Add edge request/connection limits and payload validation beyond application quotas.
- Restrict CORS to intended frontend origins. CORS is not a replacement for authentication or network isolation.
- Review socket origin enforcement separately for browser cross-site threats; WebSocket security cannot rely only on HTTP CORS behavior.
- Review logout/token revocation. The existing signed JWT model does not instantly revoke an already-connected socket solely because an HTTP cookie is cleared.
- Use Redis capacity planning/alerts. The local `noeviction` policy favors explicit command failure over silently evicting quota keys, but memory exhaustion still reduces availability.
- Decide whether presence/counters should share a Redis deployment with adapter traffic at production scale.
- Use a reliable MongoDB deployment and appropriate write concern; a local volume is not replicated database HA.
- Integrate readiness with the actual platform/load balancer. Compose health checks are not automatically production traffic draining.
- Add metrics and alerts for readiness, Redis reconnects, rejected quotas, active sockets, message latency, and DB failures.

Do not describe “JWT authentication” as end-to-end encryption. The application is not an E2EE chat system.

## 15. Scaling tradeoffs and next steps

### Horizontal scaling is enabled, not limitless

A third backend can use the same shared services and namespace, and its address can be added to both NGINX upstream pools. Connection ownership remains local, while events/presence/quotas remain coordinated.

Adding nodes still costs CPU, network, Redis traffic, and database connections. It can move the bottleneck from Node.js to Redis, MongoDB, or the load balancer. Measure before claiming a multiplier in capacity.

### Presence is the first obvious coordination bottleneck

Each synchronization scans the global active-connection set and broadcasts a full user list. With `N` active connections and `K` instances, periodic snapshot work grows roughly with `K × N`, plus broadcast fan-out. Connect/disconnect events add more snapshots.

For substantially larger scale, consider per-process connection records with expiring process heartbeats, atomic per-user counts with crash repair, incremental online/offline events, batched refreshes, and scoped presence subscriptions. Those choices trade a simpler global snapshot for more complicated recovery logic.

Do not replace this implementation with a bare global counter without solving missed decrements after crashes.

### Delivery durability

A transactional outbox plus a retrying publication worker can address the save/publish gap. Consumers still need deduplication because retrying publication generally introduces at-least-once delivery.

A reconnect catch-up protocol can retrieve messages/receipt changes since a known cursor. That is a separate feature from an adapter forwarding live broadcasts.

### Redis availability

Standalone Redis is a coordination dependency and a failure point. A production deployment could use a managed HA Redis service, Sentinel, or Redis Cluster with compatible client/adapter changes. Shared limits may reset during failover depending on replication and durability; define the intended behavior explicitly.

The current normal Redis adapter is appropriate for demonstrating two-node coordination. Socket.IO recommends considering its sharded adapter for newer Redis-based scaling designs; that is a future deployment/scale decision, not something this branch claims to have implemented. [Socket.IO adapter choices](https://socket.io/docs/v4/redis-adapter/)

### Better anti-abuse policies

Consider network-prefix normalization for IPv6, per-account plus per-IP login budgets, token-bucket/sliding-window policies, and edge connection controls. Do not select final budgets without examining legitimate traffic and shared-NAT behavior.

### Production observability and failover tests

Add repeatable backend-container failure tests through the real load balancer, browser reconnect/catch-up tests, sustained traffic benchmarks, Redis failover/restart testing, and database failure tests. The current network-partition test is valuable but not a substitute for all those deployment scenarios.

## 16. Interview questions and answers

### 1. Why did you add Redis?

To coordinate a chat application across multiple processes: cross-node Socket.IO events, shared connection presence, and shared quotas. MongoDB already handled persistence, so Redis was not introduced as a replacement database.

### 2. What broke if you simply ran two copies of the original backend?

Each copy knew only its own sockets and online-user map. A message could be saved successfully but its live event miss a receiver on the other copy. Receipts and online lists had the same process-boundary problem.

### 3. Why not just buy a bigger server?

Vertical scaling can be valid and simpler. This milestone demonstrates horizontal-scaling correctness and reduces dependence on one application process. It is not evidence that a multi-node setup is cheaper for every workload or necessary for a small demo.

### 4. Does Redis store room membership centrally?

In this implementation, each server keeps its own local membership. The adapter coordinates matching broadcasts across servers. The separate presence sorted set is custom shared state, not the adapter's permanent room directory.

### 5. Why are sticky sessions still required?

The client permits long-polling. Those transport sessions belong to one backend. Redis forwards application events but does not transfer the session ID's underlying transport state.

### 6. Why not force WebSocket-only connections?

That would avoid the polling-affinity requirement, but it removes fallback for environments where WebSocket transport fails. This implementation retains both and tests polling plus upgrades.

### 7. Why does HTTP use round-robin while sockets use hashing?

JWT authentication and database access work across replicas, so REST calls can be handled anywhere. Polling transport requests must stick to their owner. Separate upstream pools express those distinct needs.

### 8. How do two devices affect online status?

Each device has a separate socket lease. Presence deduplicates users only after finding valid connection members. Disconnecting one device does not remove the user's other lease.

### 9. What if a backend crashes without disconnecting?

Its leases stop renewing. A surviving instance removes expired members on the next synchronization. This bounds stale presence without needing the crashed process to run code.

### 10. Why use Redis TIME?

All lease decisions use one service's clock instead of separately skewed Node clocks. This simplifies expiration reasoning, although pauses and network partitions still produce temporary inaccuracies.

### 11. Why Lua instead of several Redis commands?

Other processes could interleave changes between independent commands. The presence snapshot and counter/expiry update each need one atomic operation. The downside is blocking Redis while a script runs, so work inside the script must remain bounded.

### 12. Why do presence snapshots need a revision?

Different servers can broadcast snapshots out of order. The client ignores older revisions in the same epoch. A new epoch permits recovery after the state/revision counter is recreated.

### 13. How are quotas shared?

Each key combines environment prefix, policy, and hashed identity—not instance ID. Both backends increment that same Redis counter atomically.

### 14. What happens if Redis is unavailable?

The process may remain alive, but readiness fails and APIs/receipt operations reject rather than bypassing the shared coordination protections. Existing WebSockets can remain physically connected. The tests verify reconnecting Redis restores delivery on those same sockets.

### 15. Does this guarantee no message loss?

No. Messages are saved before live publication, but a crash can occur between those steps. Pub/Sub does not replay missed events. MongoDB history supports recovery, while a durable outbox and catch-up protocol would strengthen delivery guarantees.

### 16. What do delivered and read actually mean?

Delivered means the authenticated recipient client reported receiving a message. Read means the client reported the incoming message as visible/read. Neither is cryptographic proof that a particular person saw the content.

### 17. How do you stop a user from acknowledging someone else's messages?

Receipt queries include `receiverId` from the verified socket identity. Supplying a valid message ID is not enough. A test checks that the sender cannot mark their own outgoing message as the receiver's read message.

### 18. How does idempotency survive two simultaneous sends?

The shared MongoDB unique index on sender/client message ID prevents two documents. The handler catches duplicate-key insertion races and returns the saved record. An in-memory “currently sending” flag would not coordinate processes.

### 19. Why is delivery updating with a null filter important?

Another device could read a message after it was queried as undelivered. Checking null again at write time prevents a later delivery operation from overwriting a timestamp already written by a read update.

### 20. How did you know the tests were truly cross-instance?

Direct-node sockets report different `serverInfo.instanceId` values. Through NGINX, the suite deliberately chooses tokens that reach different nodes and asserts they differ before exchanging messages and receipts.

### 21. What would you improve first for production?

Secure and make the shared services highly available, replace the local cookie-affinity shortcut if token rotation is needed, instrument the system, and add durable publication/reconnect recovery. The exact priority depends on traffic and reliability requirements.

### 22. What is the main limitation of your presence approach?

Global full-set scans and full-list broadcasts are simple but expensive as the cluster grows. Presence also represents leases rather than instantaneous physical truth during partitions.

### 23. What is the main limitation of fixed-window quotas?

Boundary bursts and imperfect identity choices. Shared atomic counters prevent replica-hopping bypass, but rotating identities/IPs still requires additional policy layers.

### 24. Is this microservices?

No. It is one application replicated across multiple instances with shared infrastructure. Multiple containers do not automatically mean separate independently owned microservices.

### 25. Is it fully stateless?

No. Persistent application records and shared ephemeral coordination are externalized, but a Socket.IO process necessarily owns live connections and local room membership. “Stateless HTTP authentication across replicas” is a more accurate statement.

### 26. What was the hardest part?

Not installing the adapter: keeping presence correct across multiple devices and crashes, avoiding concurrent receipt timestamp overwrites, and proving behavior across actual process boundaries. Mention the specific race and tests rather than inventing a dramatic incident.

## 17. Résumé bullets and claims

### Strong compact pair

- Horizontally scaled a Node.js/Express/Socket.IO messaging backend across two NGINX-balanced instances using Redis Pub/Sub, enabling cross-node messaging, shared presence, and delivery/read receipts.
- Implemented Redis-backed connection leases and atomic distributed rate limits, with integration tests validating multi-device presence, crash cleanup, and Redis reconnection recovery.

### More detailed alternatives

- Replaced process-local online-user tracking with Redis sorted-set leases, using heartbeat renewal, expiration-based crash cleanup, and revisioned snapshots to coordinate presence across backend replicas.
- Built real-service integration tests that deliberately route authenticated users to different servers and verify messages, receipt persistence, polling affinity, WebSocket upgrades, and shared abuse quotas.
- Enforced cluster-wide fixed-window quotas for login, messaging, uploads, socket authentication attempts, and receipt events using atomic Redis Lua scripts and fail-closed error handling.

### Claim boundaries

You can claim a two-replica local implementation and the verified test behaviors. Do not imply the existing public demo has been redeployed unless that separate deployment happens.

Do not claim thousands of concurrent users, doubled throughput, zero downtime, guaranteed delivery, region-level HA, or a specific p95 latency without measurement. Do not call a Pub/Sub adapter a durable message queue.

The integration suite's number of passing checks is valid evidence of tests, not evidence of scale. If adding a numerical performance bullet later, record the hardware/container limits, workloads, concurrent connections, measurement duration, error rate, and latency percentiles.

### A useful project discussion structure

```text
Constraint: process-local sockets and online tracking
Decision: Redis forwarding + shared leases + external quotas
Implementation: two replicas, NGINX, atomic scripts
Evidence: explicit cross-node and failure-injection tests
Limit: transient Pub/Sub; local shared services are not HA
Next step: durable outbox, reconnect catch-up, production deployment/benchmarks
```

This is stronger than a list of technologies because it explains why each decision exists and what would make the design better.

## 18. Terminology and references

### Short glossary

| Term | Meaning in this project |
| --- | --- |
| Instance / replica | One running copy of the Node.js backend |
| Horizontal scaling | Add copies rather than only increasing one server's resources |
| Load balancer | Chooses a backend for incoming requests/connections |
| Sticky session / affinity | Keep one transport session's requests on its owning backend |
| Room | Socket.IO grouping used to target a user's connections |
| Pub/Sub | Live publication to subscribers, without a replay backlog here |
| Lease | Temporary record that must be renewed to remain valid |
| Heartbeat | Periodic renewal of live connection records |
| TTL | Time until a whole Redis key expires |
| Atomic operation | No other Redis command interleaves halfway through the script |
| Idempotent send | Repeating one logical client message ID produces the same message document |
| Eventually consistent presence | Online views converge, but do not update everywhere instantaneously |
| Fail closed | Reject protected work when the required protection cannot run |
| Transactional outbox | Persist publication intent with business data, then publish/retry separately |

### Primary references

Use these to verify library behavior; project-specific implementation details above come from this branch's code and tests.

- [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/) — forwarding, features, connection-state recovery limitation, Redis access security.
- [Socket.IO multiple nodes](https://socket.io/docs/v4/using-multiple-nodes/) — long-polling affinity, balancing, proxy timeouts.
- [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/) — transient publication and delivery semantics.
- [Redis Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/) — atomic scripts and blocking considerations.
- [Redis EVAL](https://redis.io/docs/latest/commands/eval/) — command contract and key declarations.
- [NGINX upstream module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) — round-robin, hashing, DNS resolution, failure parameters.
- [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/) — correct trusted forwarding boundaries.
- [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/) — dependency health conditions versus merely starting a container.
- [ioredis project documentation](https://github.com/redis/ioredis) — client connection and reconnection options.

## Verification record

Verified locally on **2026-09-15**, using implementation commit `34f4f6d` on `feat/distributed-backend`.

| Check | Result |
| --- | --- |
| Host-side unit suite | 8 passed; 0 failed |
| Clean committed-source Docker build | Backend and integration-test images built successfully |
| Frontend build using committed lockfile | Passed with Vite 6.3.5; frontend served through NGINX |
| Complete local topology | Redis, MongoDB, Backend 1, Backend 2, and NGINX all healthy |
| Clean-source integration suite | 20 passed; 0 failed; 0 skipped (19 behavior checks plus outer test) |
| Unit suite inside clean-source test image | 8 passed; 0 failed |
| Lint of changed frontend files | Passed |
| Full frontend lint | Pre-existing failure: unused `useNavigate` import in `src/pages/SignUpPage.jsx` |
| Dependency installation | Successful; committed frontend lockfile reported 23 audit advisories (2 low, 4 moderate, 15 high, 2 critical) |
| Whitespace check | `git diff --check` passed |

For the final reproducibility check, the Docker build context was generated with `git archive HEAD`, not the dirty working directory. This intentionally excluded unrelated local changes to the root package, `.gitignore`, and frontend lockfile. Both runtime images and the test image were rebuilt from that committed source before rerunning verification.

The final integration run took approximately 14.4 seconds. That is suite execution time, including intentional heartbeat/expiry waits—not an end-to-end latency benchmark or capacity figure.

At the time of that original verification, the unrelated frontend lint issue and audit advisories were not changed as part of Milestone 2. The then-uncommitted frontend lockfile contained separate dependency updates, deliberately excluded from the original milestone commits. See the follow-up verification below for the subsequent dependency update. Passing architecture tests does not mean the entire application is security-audited.

Test-owned database records and explicit Redis test keys were cleaned up. During that original verification, no deployed application, production database, or `main` branch was changed. The local Docker stack remains available at `http://localhost:8080`; use `docker compose stop` when finished.

### Follow-up pre-merge verification — 2026-09-15

At the user's subsequent request to push the remaining changes and merge into `main`, the previously excluded edits to `.gitignore`, the root `package.json`, and `frontend/package-lock.json` are included in the follow-up update.

- A fresh `npm ci --prefix frontend --no-audit` succeeded.
- The frontend built successfully with the updated lockfile and Vite 6.4.3.
- `npm audit --prefix frontend` reported **0 vulnerabilities** at verification time. This is an advisory check, not a comprehensive security audit.
- The host-side unit suite passed all **8 tests**.
- The distributed integration suite passed **20 tests**, with no failures or skipped tests. This rerun used the existing backend/test images, whose backend and test source were unchanged; it was not a rebuild of the runtime frontend with the updated lockfile.
- Full frontend lint still reports the existing unused `useNavigate` import in `frontend/src/pages/SignUpPage.jsx`.

The root package edit removes its `build` script. Docker builds the frontend directly and remains independent of that script, but an external deployment configured to run root-level `npm run build` must update its build command before deploying this revision. No cloud deployment configuration or production database was modified by these checks.
