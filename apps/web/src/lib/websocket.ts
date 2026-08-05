'use client';

import type { ServerMessage } from '@quantdesk/shared';
import { browserEnv } from './env';

export type SocketState = 'connecting' | 'open' | 'closed';
type Listener = (message: ServerMessage) => void;
type StateListener = (state: SocketState) => void;

/**
 * Shared browser WebSocket client.
 *
 * Auth is an initial message, never a URL parameter: the API deliberately keeps
 * tokens out of reverse-proxy logs, browser history and observability traces.
 * The client remembers desired subscriptions rather than socket state so a
 * network handover or deployment restart restores the dashboard transparently.
 */
class QuantDeskSocket {
  private socket: WebSocket | null = null;
  private state: SocketState = 'closed';
  private accessToken: string | null = null;
  private readonly channels = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<StateListener>();
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  connect(accessToken: string | null = null): void {
    this.accessToken = accessToken;
    this.disposed = false;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    this.setState('connecting');
    const socket = new WebSocket(browserEnv.NEXT_PUBLIC_WS_URL);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.setState('open');
      if (this.accessToken) this.send({ type: 'auth', token: this.accessToken });
      this.restoreSubscriptions();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        this.listeners.forEach((listener) => listener(message));
      } catch {
        // One malformed packet must not take down the dashboard's event loop.
      }
    };

    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.setState('closed');
      if (!this.disposed) this.scheduleReconnect();
    };
  }

  setAccessToken(accessToken: string | null): void {
    this.accessToken = accessToken;
    if (accessToken && this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'auth', token: accessToken });
  }

  subscribe(channels: readonly string[]): void {
    channels.forEach((channel) => this.channels.add(channel));
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'subscribe', channels: [...channels] });
  }

  unsubscribe(channels: readonly string[]): void {
    channels.forEach((channel) => this.channels.delete(channel));
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: 'unsubscribe', channels: [...channels] });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'Client closed');
    this.socket = null;
    this.setState('closed');
  }

  private restoreSubscriptions(): void {
    if (this.channels.size > 0) this.send({ type: 'subscribe', channels: [...this.channels] });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Bounded exponential backoff plus a small deterministic jitter. The cap
    // avoids keeping a tab blank for minutes after a rolling deployment.
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts++, 5)) + (this.attempts % 4) * 71;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.accessToken);
    }, delay);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(next: SocketState): void {
    this.state = next;
    this.stateListeners.forEach((listener) => listener(next));
  }
}

export const liveSocket = new QuantDeskSocket();
