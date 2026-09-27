-- Run once in Supabase Dashboard -> SQL Editor.
-- Stores scanned barcodes and QR contents with shared beer entries.

alter table public.beer_entries
  add column if not exists barcode text not null default '';

alter table public.beer_entries
  drop constraint if exists beer_entries_barcode_length;

alter table public.beer_entries
  add constraint beer_entries_barcode_length check (char_length(barcode) <= 512);

create index if not exists beer_entries_household_barcode_idx
  on public.beer_entries (household_id, barcode)
  where barcode <> '';
