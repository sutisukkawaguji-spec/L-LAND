-- Access for L-LAN Web (sign-in with Supabase Auth). Run after schema.sql in SQL Editor. Safe to run again.
-- Only e-mails listed in llan_members can see or edit shapes; anyone else who signs in sees nothing.

create table if not exists public.llan_members (
  email text primary key,
  role text not null default 'editor' check (role in ('viewer', 'editor', 'admin')),
  added_at timestamptz not null default now()
);
alter table public.llan_members enable row level security;

-- Role of the signed-in user, or null when not a member.
create or replace function public.llan_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.llan_members where lower(email) = lower(auth.jwt() ->> 'email')
$$;

drop policy if exists llan_members_self on public.llan_members;
create policy llan_members_self on public.llan_members for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.llan_role() = 'admin');

drop policy if exists llan_layers_read on public.llan_layers;
create policy llan_layers_read on public.llan_layers for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_layers_write on public.llan_layers;
create policy llan_layers_write on public.llan_layers for all to authenticated
  using (public.llan_role() in ('editor', 'admin')) with check (public.llan_role() in ('editor', 'admin'));

drop policy if exists llan_features_read on public.llan_features;
create policy llan_features_read on public.llan_features for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_features_write on public.llan_features;
create policy llan_features_write on public.llan_features for all to authenticated
  using (public.llan_role() in ('editor', 'admin')) with check (public.llan_role() in ('editor', 'admin'));

drop policy if exists llan_log_read on public.llan_feature_log;
create policy llan_log_read on public.llan_feature_log for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_log_write on public.llan_feature_log;
create policy llan_log_write on public.llan_feature_log for insert to authenticated with check (public.llan_role() in ('editor', 'admin'));

-- Add the people who may use L-LAN Web (change the e-mails, then run):
-- insert into public.llan_members (email, role) values ('you@example.com', 'admin') on conflict (email) do update set role = excluded.role;
-- insert into public.llan_members (email, role) values ('friend@example.com', 'editor') on conflict (email) do nothing;
