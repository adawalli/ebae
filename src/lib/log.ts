import { createRequire } from "node:module";
import pino from "pino";

const LEVEL = process.env.LOG_LEVEL ?? "info";
const PRETTY = (process.env.LOG_FORMAT ?? (process.stdout.isTTY ? "pretty" : "json")) === "pretty";

// Known secret shapes that can leak inside error messages/stacks. Call-site
// discipline (never pass a secret to the logger) is the real defense; this is a
// last-ditch scrub applied to error text before it's written.
const SECRETS: RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s"']*@/gi, // connection string with credentials
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/gi, // webhook URL (its token)
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, // auth headers / bearer tokens
];

export function redact(s: string): string {
  if (s == null) return ""; // non-standard errors can have an undefined message/stack
  return SECRETS.reduce((acc, re) => acc.replace(re, "[redacted]"), s);
}

// pino-pretty as a direct stream (NOT a transport) to dodge worker threads,
// which don't bundle cleanly under Next/Turbopack. Dev-only; guarded so a prod
// image without the module (JSON is the default there, no TTY) never crashes.
function stream() {
  if (!PRETTY) return process.stdout;
  try {
    const pretty = createRequire(import.meta.url)("pino-pretty") as typeof import("pino-pretty");
    return pretty({ colorize: true });
  } catch {
    return process.stdout;
  }
}

// One stdout stream with numeric pino levels + a `level` field. ponytail: no
// stderr split (add pino.multistream later only if ops needs stream routing).
export const log = pino(
  {
    level: LEVEL,
    serializers: {
      err: (e: Error) => ({ type: e.name, message: redact(e.message), stack: redact(e.stack ?? "") }),
    },
  },
  stream(),
);
