-- Field survey teams for L-LAN Web. Run after records.sql (the "คัดลอก SQL" button gives every file in
-- order). Safe to run again.
-- - Teams: a surveyor joins with the team key (no e-mail list to keep by hand). Admins make teams; each
--   team has leads (หัวหน้าทีม) and members (ลูกทีม).
-- - Live positions of the people in the field (admins see everyone, a lead sees the team).
-- - A work log for the daily summaries, and work plans: parcels given to each member with a due date.

create table if not exists public.llan_teams (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  join_key text not null unique,
  color text not null default '#2f80ed',
  created_at timestamptz not null default now(),
  created_by text
);
alter table public.llan_members add column if not exists team_id text references public.llan_teams(id) on delete set null;
alter table public.llan_members add column if not exists team_role text not null default 'member';
alter table public.llan_members add column if not exists display_name text;
alter table public.llan_members drop constraint if exists llan_members_team_role_check;
alter table public.llan_members add constraint llan_members_team_role_check check (team_role in ('member', 'lead'));

create or replace function public.llan_email() returns text language sql stable as $$ select lower(auth.jwt() ->> 'email') $$;
create or replace function public.llan_team() returns text
language sql stable security definer set search_path = public as $$
  select team_id from public.llan_members where lower(email) = public.llan_email()
$$;
-- Admin, or a lead of team t.
create or replace function public.llan_is_lead(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.llan_members where lower(email) = public.llan_email() and (role = 'admin' or (team_id = t and team_role = 'lead')))
$$;
create or replace function public.llan_new_key() returns text language sql volatile as $$
  select upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4))
$$;

-- Members see themselves and their team mates; admins see everyone and manage the list.
drop policy if exists llan_members_self on public.llan_members;
create policy llan_members_self on public.llan_members for select to authenticated
  using (lower(email) = public.llan_email() or public.llan_role() = 'admin' or (team_id is not null and team_id = public.llan_team()));
drop policy if exists llan_members_admin on public.llan_members;
create policy llan_members_admin on public.llan_members for all to authenticated
  using (public.llan_role() = 'admin') with check (public.llan_role() = 'admin');

-- Team names for every member; the join key only through llan_team_keys() (admins, the team's leads).
alter table public.llan_teams enable row level security;
revoke all on public.llan_teams from anon, authenticated;
grant select (id, name, color, created_at) on public.llan_teams to authenticated;
drop policy if exists llan_teams_read on public.llan_teams;
create policy llan_teams_read on public.llan_teams for select to authenticated using (public.llan_role() is not null);

create or replace function public.llan_team_keys() returns table (id text, name text, color text, join_key text)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, t.color, t.join_key from public.llan_teams t where public.llan_is_lead(t.id) order by t.name
$$;
create or replace function public.llan_team_save(p_id text, p_name text, p_color text) returns setof public.llan_teams
language plpgsql security definer set search_path = public as $$
begin
  if public.llan_role() is distinct from 'admin' then raise exception 'เฉพาะผู้ดูแลระบบสร้างหรือแก้ทีมได้' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'ใส่ชื่อทีม'; end if;
  if p_id is null or p_id = '' then
    return query insert into public.llan_teams (name, color, join_key, created_by) values (trim(p_name), coalesce(p_color, '#2f80ed'), public.llan_new_key(), public.llan_email()) returning *;
  else
    return query update public.llan_teams set name = trim(p_name), color = coalesce(p_color, color) where id = p_id returning *;
  end if;
end $$;
create or replace function public.llan_team_delete(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.llan_role() is distinct from 'admin' then raise exception 'เฉพาะผู้ดูแลระบบลบทีมได้' using errcode = '42501'; end if;
  delete from public.llan_teams where id = p_id;
end $$;
create or replace function public.llan_team_new_key(p_id text) returns text
language plpgsql security definer set search_path = public as $$
declare k text := public.llan_new_key();
begin
  if not public.llan_is_lead(p_id) then raise exception 'เฉพาะผู้ดูแลหรือหัวหน้าทีมเปลี่ยนรหัสทีมได้' using errcode = '42501'; end if;
  update public.llan_teams set join_key = k where id = p_id;
  return k;
end $$;
-- Anyone signed in may join with a key. New people become editors; an existing role is kept.
create or replace function public.llan_join_team(p_key text, p_name text) returns table (team_id text, team_name text, role text, team_role text)
language plpgsql security definer set search_path = public as $
#variable_conflict use_column
declare t public.llan_teams; me text := public.llan_email();
begin
  if me is null then raise exception 'กรุณาเข้าสู่ระบบก่อน'; end if;
  select * into t from public.llan_teams where upper(join_key) = upper(trim(p_key));
  if t.id is null then raise exception 'รหัสทีมไม่ถูกต้อง' using errcode = '22023'; end if;
  insert into public.llan_members (email, role, team_id, team_role, display_name)
    values (me, 'editor', t.id, 'member', nullif(trim(p_name), ''))
  on conflict (email) do update set team_id = t.id,
    team_role = case when public.llan_members.team_id = t.id then public.llan_members.team_role else 'member' end,
    display_name = coalesce(nullif(trim(p_name), ''), public.llan_members.display_name);
  return query select m.team_id, t.name, m.role, m.team_role from public.llan_members m where lower(m.email) = me;
end $$;
create or replace function public.llan_member_set(p_email text, p_team_id text, p_team_role text, p_role text, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.llan_role() is distinct from 'admin' then raise exception 'เฉพาะผู้ดูแลระบบจัดการสมาชิกได้' using errcode = '42501'; end if;
  update public.llan_members set team_id = nullif(p_team_id, ''), team_role = coalesce(nullif(p_team_role, ''), team_role),
    role = coalesce(nullif(p_role, ''), role), display_name = coalesce(nullif(trim(p_name), ''), display_name)
  where lower(email) = lower(p_email);
end $$;

-- Personal user codes: everyone who signs in gets a code (e.g. K7Q2-9M4A) to give the admin or the team
-- lead, who adds them to a team with it. The table is read only through the functions below.
create table if not exists public.llan_user_codes (
  email text primary key,
  code text not null unique,
  name text,
  created_at timestamptz not null default now()
);
alter table public.llan_user_codes enable row level security;
revoke all on public.llan_user_codes from anon, authenticated;
create or replace function public.llan_my_code(p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare me text := public.llan_email(); c text;
begin
  if me is null then raise exception 'กรุณาเข้าสู่ระบบก่อน'; end if;
  select code into c from public.llan_user_codes where email = me;
  if c is null then
    loop
      c := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' || substr(md5(random()::text || me), 1, 4));
      exit when not exists (select 1 from public.llan_user_codes where code = c);
    end loop;
    insert into public.llan_user_codes (email, code, name) values (me, c, nullif(trim(p_name), ''));
  elsif coalesce(trim(p_name), '') <> '' then
    update public.llan_user_codes set name = trim(p_name) where email = me;
  end if;
  return c;
end $$;
-- Admins add anyone to any team; a team lead adds people (as members) to their own team.
create or replace function public.llan_add_by_code(p_code text, p_team_id text, p_team_role text, p_role text) returns table (email text, name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare u public.llan_user_codes; old public.llan_members; admin boolean := public.llan_role() = 'admin';
begin
  select * into u from public.llan_user_codes c where upper(c.code) = upper(trim(p_code));
  if u.email is null then raise exception 'ไม่พบรหัสผู้ใช้นี้ ให้ผู้ใช้เปิดหน้าเว็บแล้วดูรหัสอีกครั้ง' using errcode = '22023'; end if;
  if coalesce(p_team_id, '') = '' then raise exception 'เลือกทีมก่อน'; end if;
  if not public.llan_is_lead(p_team_id) then raise exception 'เพิ่มสมาชิกได้เฉพาะผู้ดูแล หรือหัวหน้าของทีมนั้น' using errcode = '42501'; end if;
  select * into old from public.llan_members m where lower(m.email) = lower(u.email);
  if not admin and old.team_id is not null and old.team_id <> p_team_id then raise exception 'ผู้ใช้นี้อยู่ในทีมอื่น ให้ผู้ดูแลเป็นผู้ย้ายทีม' using errcode = '42501'; end if;
  insert into public.llan_members (email, role, team_id, team_role, display_name)
    values (u.email, case when admin then coalesce(nullif(p_role, ''), 'editor') else 'editor' end, p_team_id,
      case when admin then coalesce(nullif(p_team_role, ''), 'member') else 'member' end, u.name)
  on conflict (email) do update set team_id = excluded.team_id,
    team_role = case when admin then excluded.team_role else public.llan_members.team_role end,
    role = case when admin then excluded.role else public.llan_members.role end,
    display_name = coalesce(public.llan_members.display_name, excluded.display_name);
  return query select u.email, u.name;
end $$;
-- People who have a code but no team yet (admins only).
create or replace function public.llan_pending_users() returns table (email text, code text, name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.email, c.code, c.name, c.created_at from public.llan_user_codes c
  where public.llan_role() = 'admin' and not exists (select 1 from public.llan_members m where lower(m.email) = lower(c.email) and m.team_id is not null)
  order by c.created_at desc
$$;

-- Where each surveyor is (one row per person, kept up to date by the page while it is open).
create table if not exists public.llan_locations (
  email text primary key,
  name text,
  team_id text,
  lat double precision not null,
  lon double precision not null,
  accuracy real,
  heading real,
  speed real,
  at timestamptz not null default now()
);
create or replace function public.llan_location_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare m public.llan_members;
begin
  select * into m from public.llan_members where lower(email) = public.llan_email();
  new.email := public.llan_email(); new.team_id := m.team_id; new.name := coalesce(m.display_name, new.email); new.at := now();
  return new;
end $$;
drop trigger if exists llan_locations_stamp on public.llan_locations;
create trigger llan_locations_stamp before insert or update on public.llan_locations for each row execute function public.llan_location_stamp();
alter table public.llan_locations enable row level security;
drop policy if exists llan_locations_read on public.llan_locations;
create policy llan_locations_read on public.llan_locations for select to authenticated
  using (lower(email) = public.llan_email() or public.llan_role() = 'admin' or public.llan_is_lead(team_id));
drop policy if exists llan_locations_own on public.llan_locations;
create policy llan_locations_own on public.llan_locations for all to authenticated
  using (lower(email) = public.llan_email()) with check (public.llan_role() is not null);

-- What was done in the field, for the daily summaries.
create table if not exists public.llan_work_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  by_user text,
  team_id text,
  code text,          -- parcel code
  action text not null, -- survey / edit / create / draw / photo / delete
  state text,         -- survey: draft / revisit / done
  entity text,
  record_id text,
  note text
);
create index if not exists llan_work_log_at on public.llan_work_log (at);
create index if not exists llan_work_log_team on public.llan_work_log (team_id, at);
create or replace function public.llan_work_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.by_user := public.llan_email(); new.team_id := public.llan_team(); new.at := now();
  return new;
end $$;
drop trigger if exists llan_work_log_stamp on public.llan_work_log;
create trigger llan_work_log_stamp before insert on public.llan_work_log for each row execute function public.llan_work_stamp();
alter table public.llan_work_log enable row level security;
drop policy if exists llan_work_log_read on public.llan_work_log;
create policy llan_work_log_read on public.llan_work_log for select to authenticated
  using (by_user = public.llan_email() or public.llan_role() = 'admin' or public.llan_is_lead(team_id));
drop policy if exists llan_work_log_add on public.llan_work_log;
create policy llan_work_log_add on public.llan_work_log for insert to authenticated with check (public.llan_role() in ('editor', 'admin'));

-- Work plans: a lead gives parcels to the team's members, with a due date for each.
create table if not exists public.llan_plans (
  id text primary key,
  team_id text not null references public.llan_teams(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  workdays int[] not null default '{1,2,3,4,5,6}',
  total int not null default 0,
  members text[] not null default '{}',
  created_by text,
  created_at timestamptz not null default now()
);
create table if not exists public.llan_assignments (
  code text primary key,   -- parcel code; one plan at a time
  plan_id text references public.llan_plans(id) on delete cascade,
  team_id text not null,
  email text,
  due date,
  assigned_at timestamptz not null default now()
);
create index if not exists llan_assignments_team on public.llan_assignments (team_id);
alter table public.llan_plans enable row level security;
alter table public.llan_assignments enable row level security;
drop policy if exists llan_plans_read on public.llan_plans;
create policy llan_plans_read on public.llan_plans for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_plans_lead on public.llan_plans;
create policy llan_plans_lead on public.llan_plans for all to authenticated using (public.llan_is_lead(team_id)) with check (public.llan_is_lead(team_id));
-- Everyone sees every assignment: a parcel given to another team is locked for this one.
drop policy if exists llan_assignments_read on public.llan_assignments;
create policy llan_assignments_read on public.llan_assignments for select to authenticated using (public.llan_role() is not null);
drop policy if exists llan_assignments_lead on public.llan_assignments;
create policy llan_assignments_lead on public.llan_assignments for all to authenticated using (public.llan_is_lead(team_id)) with check (public.llan_is_lead(team_id));

