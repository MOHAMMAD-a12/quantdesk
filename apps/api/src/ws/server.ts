/**
 * The WebSocket server — handshake, session lifecycle, and the inbound message
 * loop.
 *
 * Authentication is a **message, not a handshake**. Browsers cannot set headers
 * on a `WebSocket` constructor, which leaves two options: a token in the query
 * string, or a token in the first frame. A query string is written to every
 * access log, proxy log and browser history entry on the path, so the token
 * arrives in an `auth` message instead. Until it does, the connection is
 * anonymous and may only subscribe to public channels — which is most of them,
 * because a price is not privileged information.
 *
 * The `user:` channel is the exception, and the check is ownership rather than
 * mere authentication: an authenticated user asking for `user:<someone-else>`
 * is refused. Getting this wrong would leak one trader's signals to another,
 * which is the single worst failure this file could have.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ServerMessage } from '@quantdesk/shared';
import { config } from '../core/config.js';
import { moduleLogger } from '../core/logger.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { Connection, hub, type Principal } from './hub.js';
import {
  MAX_PAYLOAD_BYTES,
  canonicalChannel,
  decodeClientMessage,
  parseChannel,
} from './protocol.js';
import { startMarketStream, stopMarketStream } from './stream.js';

const log = moduleLogger('ws:server');

/** The path the upgrade must arrive on. */
export const WS_PATH = '/ws';

/**
 * Heartbeat.
 *
 * A TCP connection through a NAT or a load balancer can be silently dead for
 * minutes without either end noticing. Without this sweep those sockets sit in
 * the subscriber map forever, and the poller keeps fetching prices for them.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Sockets from one address.
 *
 * Not a security boundary — an office behind one NAT is a legitimate crowd —
 * but a bound on how much of the process a single misbehaving client can hold.
 */
const MAX_CONNECTIONS_PER_IP = 24;

let wss: WebSocketServer | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/* -------------------------------------------------------------------------- */
/* Attach                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Attach the WebSocket server to the HTTP server.
 *
 * `noServer: true` with a manual upgrade handler rather than `{ server }`: the
 * hub owns exactly one path, and letting `ws` claim every upgrade would make an
 * unrelated future upgrade route on this server impossible to add.
 */
export async function attachWebSocketServer(server: HttpServer): Promise<void> {
  if (wss) return;

  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    // Compression is off deliberately. Quote frames are a few hundred bytes of
    // mostly-incompressible numbers, and permessage-deflate allocates a zlib
    // context per connection — at a few thousand sockets that is real memory
    // spent to make small messages marginally smaller.
    perMessageDeflate: false,
  });

  server.on('upgrade', handleUpgrade);
  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    onConnection(socket, request);
  });

  await hub.start();
  startMarketStream();
  startHeartbeat();

  log.info({ path: WS_PATH }, 'WebSocket server attached');
}

/**
 * Decide whether an upgrade is ours, and whether it is allowed.
 *
 * Origin is checked against the same allow-list as CORS. A WebSocket handshake
 * is not subject to the same-origin policy, so without this check any page on
 * the internet could open a socket to this server with a user's cookies — and
 * while this API is cookie-free, the connection would still consume resources
 * and could be driven from a page the user never chose to visit.
 */
function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (!wss) return;

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== WS_PATH) return; // Not ours — leave it for another handler.

  if (!originAllowed(request.headers.origin)) {
    log.warn({ origin: request.headers.origin }, 'Rejected WebSocket upgrade from unknown origin');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const ip = clientIp(request);
  if (hub.connectionsFromIp(ip) >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (client) => {
    wss?.emit('connection', client, request);
  });
}

/**
 * Non-browser clients send no `Origin` header at all, and are allowed: a bot
 * with an API key is a first-class consumer of this platform. The header is only
 * meaningful as a statement *by a browser* about which page opened the socket.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return config.server.corsOrigins.includes(origin);
}

function clientIp(request: IncomingMessage): string {
  if (config.server.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Connection lifecycle                                                       */
/* -------------------------------------------------------------------------- */

function onConnection(socket: WebSocket, request: IncomingMessage): void {
  const connection = new Connection(socket, clientIp(request));
  hub.add(connection);

  connection.send({
    type: 'welcome',
    connectionId: connection.id,
    serverTime: Date.now(),
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      // The protocol is JSON text. Binary is either a confused client or a probe;
      // either way there is nothing to parse.
      fail(connection, 'INVALID_MESSAGE', 'Binary frames are not supported');
      return;
    }
    onMessage(connection, data.toString());
  });

  socket.on('pong', () => {
    connection.awaitingPong = false;
  });

  socket.on('close', () => {
    hub.remove(connection);
  });

  socket.on('error', (err: Error) => {
    log.debug({ err, connectionId: connection.id }, 'Socket error');
    hub.remove(connection);
  });
}

function onMessage(connection: Connection, raw: string): void {
  if (!connection.admitMessage()) {
    fail(connection, 'RATE_LIMITED', 'Too many messages — slow down');
    return;
  }

  const message = decodeClientMessage(raw);
  if (!message) {
    fail(connection, 'INVALID_MESSAGE', 'Unrecognised message');
    return;
  }

  switch (message.type) {
    case 'auth':
      onAuth(connection, message.token);
      return;
    case 'subscribe':
      onSubscribe(connection, message.channels);
      return;
    case 'unsubscribe':
      onUnsubscribe(connection, message.channels);
      return;
    case 'ping':
      connection.send({ type: 'pong', ts: message.ts ?? 0, serverTime: Date.now() });
      return;
  }
}

/**
 * Authenticate an open connection.
 *
 * The same `verifyAccessToken` the REST middleware uses, so there is exactly one
 * definition of a valid token. A rejected token does not close the socket — the
 * connection remains usable for public channels, and a client whose access token
 * expired mid-session should refresh and re-authenticate rather than rebuild
 * every subscription.
 */
function onAuth(connection: Connection, token: string): void {
  let principal: Principal;
  try {
    const claims = verifyAccessToken(token);
    principal = { id: claims.sub, email: claims.email, role: claims.role };
  } catch {
    fail(connection, 'UNAUTHORIZED', 'Invalid or expired token');
    return;
  }

  // Re-authenticating as a different user drops the previous user's private
  // subscriptions. Without this, a shared browser session that logs out and back
  // in as someone else would keep receiving the first account's notifications.
  if (connection.principal && connection.principal.id !== principal.id) {
    for (const channel of [...connection.channels]) {
      if (channel.startsWith('user:')) hub.unsubscribe(connection, channel);
    }
  }

  connection.principal = principal;
  connection.send({ type: 'authenticated', userId: principal.id, role: principal.role });
}

function onSubscribe(connection: Connection, channels: string[]): void {
  const accepted: string[] = [];

  for (const raw of channels) {
    const parsed = parseChannel(raw);
    if (!parsed) {
      fail(connection, 'INVALID_CHANNEL', `Unknown channel: ${raw.slice(0, 64)}`);
      continue;
    }

    if (parsed.kind === 'user') {
      if (!connection.principal) {
        fail(connection, 'UNAUTHORIZED', 'Authenticate before subscribing to a private channel');
        continue;
      }
      // Ownership, not merely authentication. Any authenticated user could
      // otherwise name another user's channel and receive their signals.
      if (parsed.userId !== connection.principal.id) {
        fail(connection, 'FORBIDDEN', 'You may only subscribe to your own channel');
        continue;
      }
    }

    const channel = canonicalChannel(parsed);
    if (!hub.subscribe(connection, channel)) {
      fail(connection, 'SUBSCRIPTION_LIMIT', 'Too many subscriptions on this connection');
      break;
    }
    accepted.push(channel);
  }

  if (accepted.length > 0) {
    connection.send({ type: 'subscribed', channels: accepted });
  }
}

function onUnsubscribe(connection: Connection, channels: string[]): void {
  const removed: string[] = [];

  for (const raw of channels) {
    const parsed = parseChannel(raw);
    // Unsubscribing from a channel never held is not an error. A client tearing
    // down a chart should not have to track what it successfully subscribed to.
    const channel = parsed ? canonicalChannel(parsed) : raw.trim();
    hub.unsubscribe(connection, channel);
    removed.push(channel);
  }

  connection.send({ type: 'unsubscribed', channels: removed });
}

function fail(connection: Connection, code: string, message: string): void {
  connection.send({ type: 'error', code, message } satisfies ServerMessage);
}

/* -------------------------------------------------------------------------- */
/* Heartbeat                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ping every connection; terminate those that missed the previous round.
 *
 * `terminate()` rather than `close()` for the dead ones: a graceful close waits
 * for a reply from a peer that has already been established as not answering.
 */
function startHeartbeat(): void {
  if (heartbeat) return;

  heartbeat = setInterval(() => {
    for (const connection of hub.all()) {
      if (connection.awaitingPong) {
        log.debug({ connectionId: connection.id }, 'Terminating unresponsive connection');
        hub.remove(connection);
        connection.socket.terminate();
        continue;
      }
      connection.awaitingPong = true;
      try {
        connection.socket.ping();
      } catch {
        hub.remove(connection);
        connection.socket.terminate();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  heartbeat.unref();
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Close every socket and stop the loops.
 *
 * Clients are sent a 1001 ("going away") so the browser client can distinguish a
 * deploy from a network failure and reconnect immediately rather than backing
 * off — a rolling restart should not leave every dashboard blank for a minute.
 */
export async function closeWebSocketServer(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  stopMarketStream();

  // Snapshot before `hub.stop()` clears the registry. Iterating after it would
  // close precisely zero sockets and leave clients waiting for their next timeout
  // instead of receiving the deploy's explicit 1001 close.
  const connections = hub.all();
  hub.stop();

  for (const connection of connections) {
    try {
      connection.socket.close(1001, 'Server shutting down');
    } catch {
      connection.socket.terminate();
    }
  }

  const server = wss;
  wss = null;
  if (!server) return;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  log.info('WebSocket server closed');
}
