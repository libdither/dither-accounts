/**
 * Providers: accounts that are signed in through the manager's own page rather than made by an app (Google's OAuth).
 * Each adds routes and a status section; google.ts is the first.
 */
import type { Store } from '../db.ts';
import type { Kind } from '../kinds.ts';
import type { Router } from '../router.ts';
import type { Supervisor } from '../supervisor.ts';
import { googleProvider } from './google.ts';

export interface ProviderContext {
  store: Store;
  router: Router;
  sup: Supervisor;
  kinds: Map<string, Kind>;
  dataDir: string;
  /** The manager's address on your devices (https://accounts.example.net); OAuth redirects come back here. */
  publicUrl: string;
}

export interface Provider {
  name: string;
  /** Its routes (/oauth/<name>/..., /api/providers/<name>/...): a Response, or null when the path is not its. */
  routes(req: Request, url: URL): Promise<Response | null> | Response | null;
  /** Shown on the manager's page. */
  status(): unknown;
  stop?(): void;
}

export type ProviderFactory = (ctx: ProviderContext) => Provider;

export const providers: ProviderFactory[] = [googleProvider];
