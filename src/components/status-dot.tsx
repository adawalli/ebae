import { cn } from "@/lib/utils";

// The green/amber poller-health dot repeated across the top bar, sidebar, searches header and
// status card: `active` (running, plus whatever else each surface requires) shows green and
// pulsing, otherwise amber and still. Callers own the predicate. Not the per-search interval
// dot in searches-view - that one is a different concept (enabled + fast interval, with a ring).
export function StatusDot({
  active,
  size = "sm",
  className,
  title,
}: {
  active: boolean;
  size?: "sm" | "md";
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn("shrink-0 rounded-full", size === "md" ? "size-[9px]" : "size-1.5", className)}
      style={{
        background: active ? "var(--eb-green)" : "var(--eb-amber)",
        animation: active ? "ebPulse 2.4s ease-in-out infinite" : undefined,
      }}
      title={title}
    />
  );
}
