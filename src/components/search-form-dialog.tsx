"use client";

import type { Dispatch, SetStateAction } from "react";
import { CONDITION_KEYS, CONDITION_LABELS } from "@/lib/types";
import { callsFor, fmt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const emptyForm = {
  q: "",
  priceFloor: "",
  priceCap: "",
  categoryId: "",
  condition: "",
  exclude: "",
  bin: true,
  auctions: false,
  interval: 2,
};

export type SearchForm = typeof emptyForm;

export function SearchFormDialog({
  showForm,
  setShowForm,
  form,
  setForm,
  editId,
  saving,
  formError,
  submitSearch,
  activeMin,
  marketSamples,
}: {
  showForm: boolean;
  setShowForm: (v: boolean) => void;
  form: SearchForm;
  setForm: Dispatch<SetStateAction<SearchForm>>;
  editId: number | null;
  saving: boolean;
  formError: string | null;
  submitSearch: () => void;
  activeMin: number;
  marketSamples: number;
}) {
  return (
    <Dialog open={showForm} onOpenChange={setShowForm}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editId == null ? "New saved search" : "Edit search"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="search-terms">Search terms</FieldLabel>
            <Input
              id="search-terms"
              value={form.q}
              onChange={(e) => setForm({ ...form, q: e.target.value })}
              placeholder="e.g. Leica M6 body"
              autoFocus
            />
          </Field>
          <div className="flex flex-col gap-3.5 md:flex-row">
            <Field className="md:flex-1">
              <FieldLabel htmlFor="category-id">Category ID</FieldLabel>
              <Input
                id="category-id"
                value={form.categoryId}
                onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                placeholder="all categories"
              />
            </Field>
            <div className="flex gap-3.5">
              <Field className="flex-1 md:w-[116px] md:flex-none">
                <FieldLabel htmlFor="min-price">Min price</FieldLabel>
                <InputGroup>
                  <InputGroupAddon className="font-mono">$</InputGroupAddon>
                  <InputGroupInput
                    id="min-price"
                    value={form.priceFloor}
                    onChange={(e) => setForm({ ...form, priceFloor: e.target.value })}
                    placeholder="any"
                    inputMode="decimal"
                    className="font-mono"
                  />
                </InputGroup>
              </Field>
              <Field className="flex-1 md:w-[116px] md:flex-none">
                <FieldLabel htmlFor="max-price">Max price</FieldLabel>
                <InputGroup>
                  <InputGroupAddon className="font-mono">$</InputGroupAddon>
                  <InputGroupInput
                    id="max-price"
                    value={form.priceCap}
                    onChange={(e) => setForm({ ...form, priceCap: e.target.value })}
                    placeholder="2500"
                    inputMode="decimal"
                    className="font-mono"
                  />
                </InputGroup>
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-3.5 md:flex-row">
            <Field className="md:w-[190px]">
              <FieldLabel htmlFor="condition">Condition</FieldLabel>
              <NativeSelect
                id="condition"
                className="w-full font-mono"
                value={form.condition}
                onChange={(e) => setForm({ ...form, condition: e.target.value })}
              >
                <option value="">Any condition</option>
                {CONDITION_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {CONDITION_LABELS[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="exclude-terms">Exclude keywords</FieldLabel>
            <Textarea
              id="exclude-terms"
              value={form.exclude}
              onChange={(e) => setForm({ ...form, exclude: e.target.value })}
              placeholder="for parts, repro, case only, read description"
              className="min-h-[56px] font-mono text-[13px]"
            />
            <span className="font-mono text-[11.5px] text-[var(--eb-faint)]">
              comma or line separated · a listing whose title contains any term is skipped
            </span>
          </Field>

          <Field>
            <FieldLabel>Poll interval</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={String(form.interval)}
              onValueChange={(v) => {
                if (v) setForm({ ...form, interval: Number(v) });
              }}
              className="w-full"
            >
              {[1, 2, 5, 10, 15].map((v) => (
                <ToggleGroupItem
                  key={v}
                  value={String(v)}
                  className="flex-1 font-mono data-[state=on]:border-[var(--eb-accent)] data-[state=on]:bg-[var(--eb-accent-soft)] data-[state=on]:text-[var(--eb-accent-text)]"
                >
                  {v}m
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <div className="flex flex-col gap-2.5 md:flex-row">
            {(
              [
                ["Buy It Now only", "bin"],
                ["Include auctions", "auctions"],
              ] as const
            ).map(([text, key]) => {
              const on = form[key];
              // BIN-only and include-auctions are the same axis: keep them
              // mutually exclusive so the saved search can't claim both
              const other = key === "bin" ? "auctions" : "bin";
              return (
                <Field
                  key={key}
                  orientation="horizontal"
                  className="flex-1 rounded-lg border bg-[var(--eb-input-bg)] px-3.5 py-3"
                >
                  <FieldLabel htmlFor={`toggle-${key}`} className="text-[13.5px] font-medium">
                    {text}
                  </FieldLabel>
                  <Switch
                    id={`toggle-${key}`}
                    checked={on}
                    onCheckedChange={() => setForm({ ...form, [key]: !on, [other]: on })}
                  />
                </Field>
              );
            })}
          </div>

          <div className="flex items-center gap-2 rounded-lg bg-[var(--eb-accent-soft)] px-3.5 py-3 text-[12.5px] text-[var(--eb-accent-text)]">
            {/* + the market baselines, which only a search with both a floor and a cap gets (the
                same gate as marketSamplesPerDay). The count rides in on status because it comes
                off a server-only env var; the gate is applied here because the search being
                priced has no row to read one from. Both so this preview matches the per-row
                figure the search will show once it exists. */}
            <span className="font-mono font-semibold">
              ≈ {fmt(callsFor(form.interval, activeMin) + (form.priceFloor && form.priceCap ? marketSamples : 0))}{" "}
              calls·day
            </span>
            <span className="text-muted-foreground">
              · first poll seeds silently — no alert spam from existing listings
            </span>
          </div>
          {formError && (
            <div className="rounded-lg bg-[color-mix(in_oklab,var(--eb-amber)_14%,transparent)] px-3.5 py-2.5 font-mono text-[12.5px] text-[var(--eb-amber)]">
              {formError}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowForm(false)}>
            Cancel
          </Button>
          <Button onClick={submitSearch} disabled={saving}>
            {saving ? (editId == null ? "Creating…" : "Saving…") : editId == null ? "Create search" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
