import type { MongoClient } from 'mongodb';

/**
 * Connects a client and closes it when the connection fails, so a retried connect does not leave
 * the monitors of the failed client running.
 *
 * @param client - Client not yet connected.
 */
export async function connectOrClose(client: MongoClient): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** Category of a failed MongoDB connection attempt, without hosts' credentials or URIs. */
export type ConnectErrorCategory = 'auth' | 'tls' | 'dns' | 'refused' | 'timeout' | 'other';

/** One line of the startup log of a connection attempt. */
export interface ConnectAttempt {
  database: string;
  attempt: number;
  durationMs: number;
  outcome: 'connected' | 'failed';
  category?: ConnectErrorCategory;
  /** Category per node, from the topology of a server selection error. */
  hosts?: Record<string, ConnectErrorCategory>;
  error?: string;
}

/** Options of {@link connectWithRetry}. */
export interface ConnectWithRetryOptions<T> {
  /** Name written in the log, such as `analytics` or `b2c`. */
  database: string;
  connect: () => Promise<T>;
  /** Epoch milliseconds after which no new attempt starts. */
  deadline: number;
  log: (attempt: ConnectAttempt) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 15_000;
/** Most specific first: a node that rejected the credentials explains more than one that timed out. */
const PRIORITY: readonly ConnectErrorCategory[] = [
  'auth',
  'tls',
  'dns',
  'refused',
  'timeout',
  'other'
];

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  reason?: { servers?: unknown };
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : null;
}

/**
 * Removes connection strings from a driver message, so a log line never carries credentials.
 *
 * @param message - Error message.
 * @returns The message with every `mongodb://` or `mongodb+srv://` URI replaced.
 */
export function redactUris(message: string): string {
  return message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '<uri>');
}

function ownCategory(error: ErrorLike): ConnectErrorCategory | null {
  const name = typeof error.name === 'string' ? error.name : '';
  const code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  if (code === 18 || code === 8000 || /auth(entication)? failed|bad auth/i.test(message)) {
    return 'auth';
  }
  if (
    (typeof code === 'string' && /^(ERR_SSL|ERR_TLS|CERT_|UNABLE_TO_|DEPTH_ZERO)/.test(code)) ||
    /\b(tls|ssl|certificate)\b/i.test(message)
  ) {
    return 'tls';
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ESERVFAIL' ||
    /querySrv|querytxt/i.test(message)
  ) {
    return 'dns';
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH'
  ) {
    return 'refused';
  }
  if (code === 'ETIMEDOUT' || name === 'MongoNetworkTimeoutError' || /timed out/i.test(message)) {
    return 'timeout';
  }
  return null;
}

function hostCategories(error: ErrorLike): Record<string, ConnectErrorCategory> | undefined {
  const servers = error.reason?.servers;
  if (!(servers instanceof Map) || servers.size === 0) {
    return undefined;
  }
  const hosts: Record<string, ConnectErrorCategory> = {};
  for (const [host, description] of servers) {
    const nodeError =
      typeof description === 'object' && description !== null
        ? asErrorLike((description as { error?: unknown }).error)
        : null;
    // A node without an error never answered within the selection window.
    hosts[String(host)] = nodeError === null ? 'timeout' : (classify(nodeError) ?? 'other');
  }
  return hosts;
}

function classify(error: ErrorLike): ConnectErrorCategory | null {
  const found = [ownCategory(error)];
  const cause = asErrorLike(error.cause);
  if (cause !== null) {
    found.push(classify(cause));
  }
  for (const category of Object.values(hostCategories(error) ?? {})) {
    found.push(category);
  }
  return PRIORITY.find((category) => found.includes(category)) ?? null;
}

/**
 * Classifies a MongoDB connection error for the startup log.
 *
 * Server selection errors carry the last state of every node; the category is the most specific
 * one among the error, its cause and those nodes.
 *
 * @param error - Error thrown by `MongoClient.connect`.
 * @returns The category and, for server selection errors, the category of each node.
 */
export function categorizeConnectError(error: unknown): {
  category: ConnectErrorCategory;
  hosts?: Record<string, ConnectErrorCategory>;
} {
  const errorLike = asErrorLike(error);
  if (errorLike === null) {
    return { category: 'other' };
  }
  const hosts = hostCategories(errorLike);
  const category = classify(errorLike) ?? 'other';
  return hosts === undefined ? { category } : { category, hosts };
}

/**
 * Opens a MongoDB connection, retrying with exponential backoff until it succeeds or the deadline
 * passes.
 *
 * Cloud Run instances with Direct VPC egress may take tens of seconds after startup before the VPC
 * route works, so the first attempts can time out on a reachable cluster. Rejected credentials end
 * the retries at once: repeating them does not change the result and counts against Atlas.
 *
 * @param options - Connection to open, deadline and log sink.
 * @returns The value of the first successful `connect`.
 * @throws The error of the last attempt.
 */
export async function connectWithRetry<T>(options: ConnectWithRetryOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let delay = FIRST_DELAY_MS;
  for (let attempt = 1; ; attempt += 1) {
    const startedAt = now();
    try {
      const value = await options.connect();
      options.log({
        database: options.database,
        attempt,
        durationMs: now() - startedAt,
        outcome: 'connected'
      });
      return value;
    } catch (error) {
      const { category, hosts } = categorizeConnectError(error);
      options.log({
        database: options.database,
        attempt,
        durationMs: now() - startedAt,
        outcome: 'failed',
        category,
        ...(hosts === undefined ? {} : { hosts }),
        error: redactUris(
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        )
      });
      if (category === 'auth' || now() + delay >= options.deadline) {
        throw error;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}
