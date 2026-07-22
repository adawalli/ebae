"use client";

import { useState, type ReactNode } from "react";

import { CircleHelp } from "lucide-react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Radix tooltips don't open on touch, so drive `open` ourselves and toggle it on a touch pointer.
// `children` is the visible trigger (e.g. a legend term); without it we fall back to a help icon.
export function InfoTip({ content, label, children }: { content: ReactNode; label?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onPointerDown={(event) => {
              if (event.pointerType !== "touch") return;
              event.preventDefault();
              setOpen((prev) => !prev);
            }}
            className={
              children
                ? "cursor-help underline decoration-dotted decoration-[var(--eb-faint)] underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50"
                : "inline-flex size-5 shrink-0 items-center justify-center rounded text-[var(--eb-faint)] transition-colors hover:text-[var(--eb-accent-text)] focus-visible:ring-3 focus-visible:ring-ring/50"
            }
          >
            {children ?? <CircleHelp aria-hidden="true" className="size-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
