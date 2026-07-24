// The push services ebae will deliver to. Exact hosts, except WNS: Microsoft documents the
// wns2-* subdomain as subject to change, so that one is a suffix match. Single source for two
// guards that MUST agree: validate.ts's SSRF allowlist (checked at subscribe time) and log.ts's
// redaction regex (a push endpoint is bearer-equivalent, same as a webhook URL). Add a provider
// here and both move together. Dependency-free on purpose, so log.ts's leaf stays a leaf.
export const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
export const PUSH_HOST_SUFFIX = ".notify.windows.com"; // WNS (Edge on Windows)
