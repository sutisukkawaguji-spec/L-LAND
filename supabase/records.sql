-- L-LAN register in Supabase: owners, lands, buildings, signs and deletion notes, shared by the web page
-- (members sign in) and the office L-LAN (secret key). LTAX ONLINE itself is only touched from the office.
-- Run after schema.sql and web-access.sql in Supabase → SQL Editor. Safe to run again.

-- One row per register record; data is the record as L-LAN keeps it (including the LTAX snapshot).
create table if not exists public.llan_records (
  id text primary key,
  entity text not null check (entity in ('owners', 'lands', 'buildings', 'signboards', 'deletions')),
  data jsonb not null default '{}'::jsonb,
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists llan_records_entity on public.llan_records (entity);
create index if not exists llan_records_updated on public.llan_records (updated_at);

-- Rows deleted anywhere, so every copy (web pages, office machines) deletes them too.
create table if not exists public.llan_deleted (
  id bigserial primary key,
  tbl text not null,
  row_id text not null,
  by_user text,
  at timestamptz not null default now()
);
create index if not exists llan_deleted_at on public.llan_deleted (at);

-- Who changed what, before and after.
create table if not exists public.llan_change_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  by_user text,
  entity text,
  record_id text,
  action text,
  reason text,
  before jsonb,
  after jsonb
);
create index if not exists llan_change_log_at on public.llan_change_log (at desc);
create index if not exists llan_change_log_record on public.llan_change_log (record_id);

-- Small settings the web page reads (the office publishes them: organisation, area tolerance).
create table if not exists public.llan_config (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.llan_layers add column if not exists rev integer not null default 1;
alter table public.llan_layers add column if not exists updated_by text;
alter table public.llan_features add column if not exists rev integer not null default 1;

-- Every write gets the database clock and a revision number, whoever sends it.
-- A signed-in member is recorded by their e-mail; the office sends its own name.
create or replace function public.llan_stamp() returns trigger language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  new.rev := case when tg_op = 'UPDATE' then old.rev + 1 else 1 end;
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end $$;

create or replace function public.llan_note_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.llan_deleted (tbl, row_id, by_user) values (tg_table_name, old.id::text, auth.jwt() ->> 'email');
  return old;
end $$;

drop trigger if exists llan_records_stamp on public.llan_records;
create trigger llan_records_stamp before insert or update on public.llan_records for each row execute function public.llan_stamp();
drop trigger if exists llan_features_stamp on public.llan_features;
create trigger llan_features_stamp before insert or update on public.llan_features for each row execute function public.llan_stamp();
drop trigger if exists llan_layers_stamp on public.llan_layers;
create trigger llan_layers_stamp before insert or update on public.llan_layers for each row execute function public.llan_stamp();

drop trigger if exists llan_records_gone on public.llan_records;
create trigger llan_records_gone after delete on public.llan_records for each row execute function public.llan_note_delete();
drop trigger if exists llan_features_gone on public.llan_features;
create trigger llan_features_gone after delete on public.llan_features for each row execute function public.llan_note_delete();
drop trigger if exists llan_layers_gone on public.llan_layers;
create trigger llan_layers_gone after delete on public.llan_layers for each row execute function public.llan_note_delete();

-- Save edits field by field: two people changing different fields of one record both keep their change.
-- items: [{ "id", "entity", "patch": {field: value}, "unset": [field], "by" }]. Returns the merged rows.
-- Runs with the caller's rights, so the row-level security below still decides who may write.
create or replace function public.llan_save(items jsonb) returns setof public.llan_records
language plpgsql security invoker set search_path = public as $$
declare it jsonb; gone text[];
begin
  for it in select * from jsonb_array_elements(items) loop
    gone := coalesce(array(select jsonb_array_elements_text(it -> 'unset')), '{}'::text[]);
    return query
      insert into public.llan_records as r (id, entity, data, updated_by)
      values (it ->> 'id', it ->> 'entity', coalesce(it -> 'patch', '{}'::jsonb) - gone, it ->> 'by')
      on conflict (id) do update
        set data = (r.data || coalesce(it -> 'patch', '{}'::jsonb)) - gone, entity = excluded.entity, updated_by = excluded.updated_by
      returning r.*;
  end loop;
end $$;

-- Members (llan_members) read everything; editors and admins write. The office uses the secret key.
alter table public.llan_records enable row level security;
alter table public.llan_deleted enable row level security;
alter table public.llan_change_log enable row level security;
alter table public.llan_config enable row level security;

drop policy if exists llan_records_read on public.llan_records;
create policy llan_records_read on public.llan_records for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_records_write on public.llan_records;
create policy llan_records_write on public.llan_records for all to authenticated
  using (public.llan_role() in ('editor', 'admin')) with check (public.llan_role() in ('editor', 'admin'));

drop policy if exists llan_deleted_read on public.llan_deleted;
create policy llan_deleted_read on public.llan_deleted for select to authenticated using (public.llan_role() is not null);

drop policy if exists llan_change_log_read on public.llan_change_log;
create policy llan_change_log_read on public.llan_change_log for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_change_log_write on public.llan_change_log;
create policy llan_change_log_write on public.llan_change_log for insert to authenticated with check (public.llan_role() in ('editor', 'admin'));

drop policy if exists llan_config_read on public.llan_config;
create policy llan_config_read on public.llan_config for select to authenticated using (public.llan_role() is not null);

-- Status of every parcel, decided by the office L-LAN: does the shape link to the register and to LTAX,
-- and what the field survey still has to fix. The survey web page reads it; only the office writes it.
create table if not exists public.llan_parcel_status (
  id text primary key,              -- parcel code, or '#<shape id>' for a shape without a code
  code text,
  status text not null,             -- ok (ข้อมูลตรง) / fix (ต้องปรับแก้ในระบบสำรวจ) / send (รอดำเนินการใน LTAX)
  link text,                        -- ok / no-record / no-shape / dup-shape / dup-record / no-code
  ltax text,                        -- found / not-found / dup / new / none
  pending text,                     -- create / update / null: changes not yet in LTAX
  reasons jsonb not null default '[]'::jsonb,
  info jsonb not null default '{}'::jsonb,
  rev integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists llan_parcel_status_status on public.llan_parcel_status (status);
create index if not exists llan_parcel_status_updated on public.llan_parcel_status (updated_at);
drop trigger if exists llan_parcel_status_stamp on public.llan_parcel_status;
create trigger llan_parcel_status_stamp before insert or update on public.llan_parcel_status for each row execute function public.llan_stamp();
drop trigger if exists llan_parcel_status_gone on public.llan_parcel_status;
create trigger llan_parcel_status_gone after delete on public.llan_parcel_status for each row execute function public.llan_note_delete();
alter table public.llan_parcel_status enable row level security;
drop policy if exists llan_parcel_status_read on public.llan_parcel_status;
create policy llan_parcel_status_read on public.llan_parcel_status for select to authenticated using (public.llan_role() is not null);

-- Field photos: a private Storage bucket. Members see them; editors and admins add and remove them.
-- The register records keep the list of photo paths (photos = [{ path, at, by, lat, lon }]).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('llan-photos', 'llan-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;
drop policy if exists llan_photos_read on storage.objects;
create policy llan_photos_read on storage.objects for select to authenticated using (bucket_id = 'llan-photos' and public.llan_role() is not null);
drop policy if exists llan_photos_add on storage.objects;
create policy llan_photos_add on storage.objects for insert to authenticated with check (bucket_id = 'llan-photos' and public.llan_role() in ('editor', 'admin'));
drop policy if exists llan_photos_remove on storage.objects;
create policy llan_photos_remove on storage.objects for delete to authenticated using (bucket_id = 'llan-photos' and public.llan_role() in ('editor', 'admin'));
