-- L-LAN shapes in Supabase (PostGIS). Only geometry, codes and non-personal attributes live here;
-- owner names, ID numbers and the rest of the register are read from LTAX ONLINE when needed.
-- Run once in Supabase → SQL Editor. Safe to run again.

create extension if not exists postgis with schema extensions;

create table if not exists public.llan_layers (
  id uuid primary key,
  name text not null,
  kind text not null check (kind in ('parcel', 'building', 'other')),
  crs text,                      -- source CRS of the shapefile, used again on export
  code_field text,
  geometry_type text,
  fields jsonb not null default '[]'::jsonb,   -- attribute columns (personal ones removed)
  count integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.llan_features (
  id uuid primary key,
  layer_id uuid not null references public.llan_layers(id) on delete cascade,
  kind text not null check (kind in ('parcel', 'building', 'other')),
  fid integer,
  code text,                     -- parcel code (11E015) or building code (11E015-B001): the link to LTAX
  geojson jsonb not null,        -- WGS84 GeoJSON geometry as L-LAN sends it
  geom extensions.geometry(Geometry, 4326)
    generated always as (extensions.st_setsrid(extensions.st_geomfromgeojson(geojson::text), 4326)) stored,
  area_m2 numeric,
  attrs jsonb not null default '{}'::jsonb,
  drawn boolean not null default false,
  reshaped boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists llan_features_code on public.llan_features (code);
create index if not exists llan_features_layer on public.llan_features (layer_id);
create index if not exists llan_features_geom on public.llan_features using gist (geom);

-- Who changed which shape, without personal data.
create table if not exists public.llan_feature_log (
  id bigserial primary key,
  feature_id uuid,
  code text,
  action text not null,          -- create / reshape / update / delete
  area_before numeric,
  area_after numeric,
  by_user text,
  at timestamptz not null default now()
);

-- No public access: only the L-LAN server, using the secret (service_role) key, can read and write.
alter table public.llan_layers enable row level security;
alter table public.llan_features enable row level security;
alter table public.llan_feature_log enable row level security;
