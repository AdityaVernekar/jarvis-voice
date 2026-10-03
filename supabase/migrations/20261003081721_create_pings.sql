create table public.pings (
  install_id     uuid        not null,
  day            date        not null default current_date,
  app_version    text        not null,
  macos_version  text,
  arch           text,
  locale         text,
  agents         text[]      not null default '{}',
  created_at     timestamptz not null default now(),
  primary key (install_id, day)
);

alter table public.pings enable row level security;

revoke all on public.pings from anon, authenticated;
grant insert on public.pings to anon;

create policy "app can insert today's ping"
  on public.pings for insert
  to anon
  with check (
    day = current_date
    and length(app_version) <= 20
    and coalesce(length(macos_version), 0) <= 20
    and coalesce(length(arch), 0) <= 10
    and coalesce(length(locale), 0) <= 20
    and cardinality(agents) <= 10
  );
