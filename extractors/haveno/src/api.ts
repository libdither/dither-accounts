/**
 * The Haveno daemon's gRPC API (proto/grpc.proto, from haveno-reto at the tag the node runs), with its API password as
 * the `password` metadata on every call. Errors come back as HavenoError with what they mean for the account:
 *
 *   down      the daemon is not answering (stopped, starting, or handing over to the desktop app)
 *   locked    the account is not open (it needs its password)
 *   syncing   the account is open but the wallet or the network is not ready yet
 *   denied    the API password is wrong
 *   failed    anything else the node said no to (its message is kept: it says what was wrong with a request)
 */
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';

export type HavenoErrorKind = 'down' | 'locked' | 'syncing' | 'denied' | 'failed';

export class HavenoError extends Error {
  constructor(
    message: string,
    readonly kind: HavenoErrorKind,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const PROTO_DIR = join(import.meta.dir, '..', 'proto');

let pkgCache: any = null;
function protoPackage(): any {
  pkgCache ??= (grpc.loadPackageDefinition(
    loader.loadSync('grpc.proto', { includeDirs: [PROTO_DIR], keepCase: false, longs: String, enums: String, defaults: true, oneofs: true }),
  ) as any).io.haveno.protobuffer;
  return pkgCache;
}

export function classify(e: unknown): HavenoError {
  if (e instanceof HavenoError) return e;
  const err = e as { code?: number; details?: string; message?: string };
  const code = typeof err.code === 'number' ? err.code : null;
  const text = String(err.details || err.message || e);
  if (code === grpc.status.UNAVAILABLE || code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.CANCELLED) return new HavenoError(text, 'down', code);
  // The API password (the account password's refusal comes back as a plain failure of OpenAccount).
  if (code === grpc.status.UNAUTHENTICATED) return new HavenoError(text, 'denied', code);
  if (/account not open|account is not open/i.test(text)) return new HavenoError(text, 'locked', code);
  if (/not yet initialized|not initialized|wallet is not|not synced|syncing/i.test(text)) return new HavenoError(text, 'syncing', code);
  return new HavenoError(text, 'failed', code);
}

export interface Stream {
  cancel(): void;
}

export class HavenoApi {
  private clients = new Map<string, any>();
  private creds = grpc.credentials.createInsecure();
  /** Calls made, and the last time the daemon answered. */
  calls = 0;
  answeredAt: number | null = null;

  constructor(
    readonly address: string,
    private password: () => string | null,
  ) {}

  private md(): grpc.Metadata {
    const m = new grpc.Metadata();
    const p = this.password();
    if (p) m.set('password', p);
    return m;
  }

  private client(service: string): any {
    let c = this.clients.get(service);
    if (!c) {
      const Ctor = protoPackage()[service];
      if (!Ctor) throw new Error(`no gRPC service ${service}`);
      c = new Ctor(this.address, this.creds, { 'grpc.max_receive_message_length': 64 * 1024 * 1024, 'grpc.keepalive_time_ms': 60_000 });
      this.clients.set(service, c);
    }
    return c;
  }

  /** One unary call: `service.method(request)`, as the node answers it. */
  call<T = any>(service: string, method: string, req: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    this.calls++;
    const c = this.client(service);
    const m = method[0].toLowerCase() + method.slice(1);
    if (typeof c[m] !== 'function') return Promise.reject(new HavenoError(`no gRPC method ${service}.${method}`, 'failed', null));
    return new Promise<T>((resolve, reject) => {
      c[m](req, this.md(), { deadline: Date.now() + timeoutMs }, (e: unknown, r: T) => {
        if (e) {
          const h = classify(e);
          if (h.kind !== 'down') this.answeredAt = Date.now();
          reject(h);
        } else {
          this.answeredAt = Date.now();
          resolve(r);
        }
      });
    });
  }

  /** The node's notifications (a server stream): every message to `onMessage`, the end (with why) to `onEnd`. */
  notifications(onMessage: (m: any) => void, onEnd: (e: HavenoError | null) => void): Stream {
    const s = this.client('Notifications').registerNotificationListener({}, this.md());
    let ended = false;
    const end = (e: HavenoError | null) => {
      if (ended) return;
      ended = true;
      onEnd(e);
    };
    s.on('data', (m: any) => {
      this.answeredAt = Date.now();
      onMessage(m);
    });
    s.on('error', (e: unknown) => end(classify(e)));
    s.on('end', () => end(null));
    return { cancel: () => s.cancel() };
  }

  close() {
    for (const c of this.clients.values()) c.close?.();
    this.clients.clear();
  }
}
