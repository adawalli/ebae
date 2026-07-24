import { alertsTag } from "@/lib/poller";

// The poller's in-memory state is lazy: it doesn't exist until a public entry point touches it.
// Tests that reach past the API to inspect it prime it here, then read the __ebaeState singleton
// through a caller-supplied view type. One home for the fragile globalThis cast.
export function pollerState<T>(): T {
  alertsTag(0); // any public call forces the lazy state to initialize
  return (globalThis as unknown as { __ebaeState: T }).__ebaeState;
}
