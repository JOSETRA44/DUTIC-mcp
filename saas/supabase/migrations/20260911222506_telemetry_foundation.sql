-- ═════════════════════════════════════════════════════════════════════════════
--  Telemetría — fundamentos (fase 2)
--
--  Responde: qué falló, en qué instalación y dispositivo, en qué aula y semestre, a
--  qué hora y en qué versión. Sin secretos y sin datos de terceros.
--
--  AISLAMIENTO. Todo vive en el esquema `telemetry`, que PostgREST no expone y sobre el
--  que `anon`/`authenticated` no tienen ni USAGE. Las únicas puertas son tres funciones
--  en `public` que SÓLO puede ejecutar service_role (las Edge Functions).
--
--  IDENTIDAD POR CAPAS. persona → instalación → realm → cuenta → sesión. Ningún campo
--  es identidad por sí solo: `moodle_user_id` siempre va con su realm (cada semestre es
--  un Moodle distinto), y la cuenta se guarda como HMAC con un pepper que vive en Vault.
-- ═════════════════════════════════════════════════════════════════════════════

create schema if not exists telemetry;
revoke all on schema telemetry from public, anon, authenticated;
alter default privileges in schema telemetry revoke all on tables from public, anon, authenticated;
alter default privileges in schema telemetry revoke all on sequences from public, anon, authenticated;
alter default privileges in schema telemetry revoke all on functions from public, anon, authenticated;

-- ── Pepper: generado DENTRO de la base, nunca aparece en un archivo ──────────
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'telemetry_pepper') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'telemetry_pepper',
      'HMAC de cuentas e IPs de la telemetría. Rotarlo rompe la correlación histórica.'
    );
  end if;
end
$$;

create or replace function telemetry.pepper()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'telemetry_pepper'
$$;

-- `0.10.0` > `0.9.3`: compara por componentes numéricos, no como texto.
create or replace function telemetry.version_gt(a text, b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    string_to_array(substring(a from '^[0-9]+(?:\.[0-9]+)*'), '.')::int[]
      > string_to_array(substring(b from '^[0-9]+(?:\.[0-9]+)*'), '.')::int[],
    false
  )
$$;

-- ── Personas: humanos verificados (Google institucional, fase 1) ─────────────
create table telemetry.persons (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

-- ── Instalaciones: un dispositivo con dutic ──────────────────────────────────
create table telemetry.installs (
  id               uuid primary key default gen_random_uuid(),
  -- sha256 de un secreto de 256 bits que genera el CLIENTE; el secreto nunca llega aquí.
  secret_hash      text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  person_id        uuid references telemetry.persons(id) on delete set null,
  identity_consent boolean not null default false,
  os               text,
  os_release       text,
  arch             text,
  node_version     text,
  cpu_count        smallint,
  mem_gb           smallint,
  locale           text,
  timezone         text,
  app_version      text,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  -- Token bucket de eventos (capacidad y recarga en telemetry_ingest).
  bucket_tokens    real not null default 600,
  bucket_at        timestamptz not null default now(),
  revoked_at       timestamptz
);
create index installs_person_idx on telemetry.installs (person_id) where person_id is not null;
create index installs_last_seen_idx on telemetry.installs (last_seen);

-- ── Realms: un sistema concreto. Hoy `moodle:aulavirtual.unsa.edu.pe/2026B`;
--    mañana `sisacad:…`, `encuesta:…` sin tocar el esquema ─────────────────────
create table telemetry.realms (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  realm_key  text not null unique check (length(realm_key) <= 200),
  host       text not null,
  instance   text,
  first_seen timestamptz not null default now()
);

-- ── Cuentas: la identidad de alguien DENTRO de un realm ──────────────────────
create table telemetry.accounts (
  id           bigint generated always as identity primary key,
  realm_id     bigint not null references telemetry.realms(id) on delete cascade,
  account_key  text not null,              -- HMAC(pepper, realm_key|uid): seudónimo estable
  external_uid text,                       -- sólo con consentimiento de identidad
  display_name text,                       -- ídem
  email        text,                       -- ídem
  person_id    uuid references telemetry.persons(id) on delete set null,
  link_state   text not null default 'declared'
                 check (link_state in ('declared', 'verified', 'conflict')),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  unique (realm_id, account_key)
);
create index accounts_person_idx on telemetry.accounts (person_id) where person_id is not null;

-- ── Bitácora de identidad: append-only, nada se sobrescribe sin rastro ──────
create table telemetry.identity_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  kind       text not null check (kind in (
               'install_registered', 'linked', 'relinked', 'conflict', 'consent_changed', 'forgotten')),
  install_id uuid,
  person_id  uuid,
  account_id bigint,
  detail     jsonb not null default '{}'::jsonb
);
create index identity_events_at_idx on telemetry.identity_events (at desc);

-- ── Eventos: particionados por mes (borrar un mes viejo es un DROP, no un DELETE) ──
create table telemetry.events (
  id             uuid not null,
  occurred_at    timestamptz not null,
  received_at    timestamptz not null default now(),
  clock_skew_ms  integer,
  install_id     uuid not null references telemetry.installs(id) on delete cascade,
  person_id      uuid,
  realm_id       bigint references telemetry.realms(id) on delete set null,
  account_id     bigint references telemetry.accounts(id) on delete set null,
  session_ref    uuid,
  run_id         uuid not null,
  trace_id       uuid,
  span_id        uuid,
  parent_span_id uuid,
  surface        text not null check (surface in ('cli', 'mcp', 'auto')),
  mcp_client     text,
  kind           text not null,
  name           text not null,
  status         text not null check (status in ('ok', 'error', 'cancelled', 'skipped')),
  duration_ms    integer,
  error_class    text,
  error_code     text,
  fingerprint    text,
  message        text,
  app_version    text not null,
  attrs          jsonb not null default '{}'::jsonb,
  primary key (occurred_at, id)
) partition by range (occurred_at);

create index events_install_idx on telemetry.events (install_id, occurred_at desc);
create index events_fingerprint_idx on telemetry.events (fingerprint, occurred_at desc) where fingerprint is not null;
create index events_trace_idx on telemetry.events (trace_id) where trace_id is not null;
create index events_account_idx on telemetry.events (account_id) where account_id is not null;
create index events_name_idx on telemetry.events (kind, name, occurred_at desc);

-- ── Grupos de error: un fingerprint = un fallo, por muchas veces que ocurra ──
create table telemetry.error_groups (
  fingerprint         text primary key,
  error_class         text not null,
  error_code          text,
  surface             text,
  name                text,
  sample_message      text,
  first_seen          timestamptz not null,
  last_seen           timestamptz not null,
  occurrences         bigint not null default 0,
  first_version       text,
  last_version        text,
  status              text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  resolved_in_version text,
  resolved_at         timestamptz,
  status_changed_by   text
);
create index error_groups_last_seen_idx on telemetry.error_groups (last_seen desc);

-- ── Límite de altas por IP (la IP sólo existe como HMAC con sal diaria) ─────
create table telemetry.register_limits (
  ip_hash      text primary key,
  window_start timestamptz not null,
  attempts     integer not null
);

alter table telemetry.persons         enable row level security;
alter table telemetry.installs        enable row level security;
alter table telemetry.realms          enable row level security;
alter table telemetry.accounts        enable row level security;
alter table telemetry.identity_events enable row level security;
alter table telemetry.events          enable row level security;
alter table telemetry.error_groups    enable row level security;
alter table telemetry.register_limits enable row level security;

-- ── Mantenimiento: particiones por delante, retención, limpieza ─────────────
create or replace function telemetry.maintenance(p_keep_months integer default 6)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date;
  r record;
begin
  for i in -1..3 loop
    v_month := (date_trunc('month', now()) + make_interval(months => i))::date;
    execute format(
      'create table if not exists telemetry.%I partition of telemetry.events for values from (%L) to (%L)',
      'events_' || to_char(v_month, 'YYYYMM'), v_month, (v_month + interval '1 month')::date
    );
    execute format('alter table telemetry.%I enable row level security', 'events_' || to_char(v_month, 'YYYYMM'));
  end loop;

  for r in
    select c.relname
      from pg_catalog.pg_inherits i
      join pg_catalog.pg_class c on c.oid = i.inhrelid
     where i.inhparent = 'telemetry.events'::regclass
  loop
    if r.relname ~ '^events_[0-9]{6}$'
       and to_date(substring(r.relname from 8 for 6), 'YYYYMM')
           < (date_trunc('month', now()) - make_interval(months => p_keep_months))::date then
      execute format('drop table telemetry.%I', r.relname);
    end if;
  end loop;

  delete from telemetry.register_limits where window_start < now() - interval '1 day';
  -- Instalaciones anónimas abandonadas: sus eventos caen con ellas (on delete cascade).
  delete from telemetry.installs where person_id is null and last_seen < now() - interval '180 days';
end
$$;

select telemetry.maintenance();

-- ═════════════════════════════════════════════════════════════════════════════
--  Puertas (sólo service_role)
-- ═════════════════════════════════════════════════════════════════════════════

-- Alta idempotente: reintentar con el mismo hash devuelve la misma instalación, así
-- una respuesta perdida en la red no crea instalaciones fantasma.
create or replace function public.telemetry_register(p_secret_hash text, p_ip text, p_device jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d          jsonb := coalesce(p_device, '{}'::jsonb);
  v_ip_hash  text;
  v_attempts integer;
  v_id       uuid;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('error', 'invalid_secret');
  end if;

  v_ip_hash := encode(
    extensions.hmac(coalesce(p_ip, '?') || '|' || current_date::text, telemetry.pepper(), 'sha256'), 'hex');

  insert into telemetry.register_limits as l (ip_hash, window_start, attempts)
  values (v_ip_hash, now(), 1)
  on conflict (ip_hash) do update set
    window_start = case when l.window_start <= now() - interval '1 hour' then now() else l.window_start end,
    attempts     = case when l.window_start <= now() - interval '1 hour' then 1 else l.attempts + 1 end
  returning l.attempts into v_attempts;

  -- 60/h por IP: holgado para un aula entera detrás del NAT del campus.
  if v_attempts > 60 then
    return jsonb_build_object('error', 'rate_limited', 'retry_after', 3600);
  end if;

  insert into telemetry.installs as i (
    secret_hash, os, os_release, arch, node_version, cpu_count, mem_gb, locale, timezone, app_version)
  values (
    p_secret_hash,
    left(d ->> 'os', 40), left(d ->> 'osRelease', 60), left(d ->> 'arch', 20), left(d ->> 'node', 20),
    case when d ->> 'cpuCount' ~ '^[0-9]{1,4}$' then (d ->> 'cpuCount')::smallint end,
    case when d ->> 'memGb' ~ '^[0-9]{1,4}$' then (d ->> 'memGb')::smallint end,
    left(d ->> 'locale', 20), left(d ->> 'timezone', 60), left(d ->> 'appVersion', 40))
  on conflict (secret_hash) do update set last_seen = now()
  returning i.id into v_id;

  insert into telemetry.identity_events (kind, install_id) values ('install_registered', v_id);
  return jsonb_build_object('installId', v_id);
end
$$;

-- Ingesta de un lote. Una sola ida y vuelta: autentica, limita, resuelve realm y
-- cuenta, inserta idempotente y mantiene los grupos de error.
create or replace function public.telemetry_ingest(
  p_install_id       uuid,
  p_secret_hash      text,
  p_sent_at          timestamptz,
  p_app_version      text,
  p_identity_consent boolean,
  p_events           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_capacity      constant real := 600;
  c_refill_per_s  constant real := 600.0 / 3600;
  v_install       telemetry.installs%rowtype;
  v_now           timestamptz := clock_timestamp();
  v_n             integer;
  v_tokens        real;
  v_skew_ms       integer;
  v_consent       boolean;
  v_pepper        text;
  v_version       text := coalesce(left(p_app_version, 40), 'desconocida');
  e               jsonb;
  v_occurred      timestamptz;
  v_realm_key     text;
  v_realm_id      bigint;
  v_prev_realm    text;
  v_prev_realm_id bigint;
  v_account_key   text;
  v_account_id    bigint;
  v_prev_acct     text;
  v_prev_acct_id  bigint;
  v_rows          integer;
  v_inserted      integer := 0;
begin
  if jsonb_typeof(p_events) is distinct from 'array' then
    return jsonb_build_object('error', 'invalid_events');
  end if;
  v_n := jsonb_array_length(p_events);

  select * into v_install from telemetry.installs where id = p_install_id for update;
  if not found or v_install.revoked_at is not null or v_install.secret_hash <> p_secret_hash then
    return jsonb_build_object('error', 'invalid_install');
  end if;

  v_tokens := least(c_capacity,
    v_install.bucket_tokens + extract(epoch from (v_now - v_install.bucket_at))::real * c_refill_per_s);
  if v_tokens < v_n then
    update telemetry.installs set bucket_tokens = v_tokens, bucket_at = v_now where id = p_install_id;
    return jsonb_build_object('error', 'rate_limited',
                              'retry_after', ceil((v_n - v_tokens) / c_refill_per_s)::integer);
  end if;

  -- Desfase del reloj del cliente. Se guarda, pero NO se aplica a occurred_at: la clave
  -- primaria incluye occurred_at y un reintento del mismo lote debe chocar consigo mismo.
  v_skew_ms := case when p_sent_at is null then null
                    else greatest(-2000000000, least(2000000000,
                           round(extract(epoch from (v_now - p_sent_at)) * 1000)))::integer end;

  v_consent := coalesce(p_identity_consent, v_install.identity_consent);
  if v_consent is distinct from v_install.identity_consent then
    insert into telemetry.identity_events (kind, install_id, person_id, detail)
    values ('consent_changed', p_install_id, v_install.person_id, jsonb_build_object('identity', v_consent));
    if not v_consent then
      -- Retirar el consentimiento borra lo identificable de las cuentas vistas desde aquí.
      update telemetry.accounts a
         set external_uid = null, display_name = null, email = null
       where a.id in (select distinct ev.account_id from telemetry.events ev
                       where ev.install_id = p_install_id and ev.account_id is not null);
    end if;
  end if;

  v_pepper := telemetry.pepper();

  for e in select value from jsonb_array_elements(p_events) loop
    v_occurred := least(greatest((e ->> 'occurredAt')::timestamptz, v_now - interval '7 days'),
                        v_now + interval '5 minutes');
    v_realm_id := null;
    v_account_id := null;

    if e ? 'realm' then
      v_realm_key := (e -> 'realm' ->> 'kind') || ':' || (e -> 'realm' ->> 'host') || '/'
                     || coalesce(e -> 'realm' ->> 'instance', '');
      -- Un lote casi siempre trae el mismo realm y la misma cuenta: se resuelven una vez.
      if v_realm_key is not distinct from v_prev_realm then
        v_realm_id := v_prev_realm_id;
      else
        insert into telemetry.realms (kind, realm_key, host, instance)
        values (e -> 'realm' ->> 'kind', v_realm_key, e -> 'realm' ->> 'host', e -> 'realm' ->> 'instance')
        on conflict (realm_key) do nothing;
        select r.id into v_realm_id from telemetry.realms r where r.realm_key = v_realm_key;
        v_prev_realm := v_realm_key;
        v_prev_realm_id := v_realm_id;
        v_prev_acct := null;
      end if;

      if e ? 'account' then
        v_account_key := encode(
          extensions.hmac(v_realm_key || '|' || (e -> 'account' ->> 'uid'), v_pepper, 'sha256'), 'hex');
        if v_account_key is not distinct from v_prev_acct then
          v_account_id := v_prev_acct_id;
        else
          insert into telemetry.accounts as a (realm_id, account_key, external_uid, display_name, email, person_id)
          values (v_realm_id, v_account_key,
                  case when v_consent then e -> 'account' ->> 'uid' end,
                  case when v_consent then e -> 'account' ->> 'name' end,
                  case when v_consent then lower(e -> 'account' ->> 'email') end,
                  v_install.person_id)
          on conflict (realm_id, account_key) do update set
            last_seen    = excluded.last_seen,
            external_uid = case when v_consent then excluded.external_uid else a.external_uid end,
            display_name = case when v_consent then coalesce(excluded.display_name, a.display_name) else a.display_name end,
            email        = case when v_consent then coalesce(excluded.email, a.email) else a.email end,
            person_id    = coalesce(a.person_id, excluded.person_id),
            -- Nunca se reasigna una cuenta en silencio: si dos personas la reclaman, se marca.
            link_state   = case when a.person_id is not null and excluded.person_id is not null
                                     and a.person_id <> excluded.person_id
                                then 'conflict' else a.link_state end
          returning a.id into v_account_id;
          v_prev_acct := v_account_key;
          v_prev_acct_id := v_account_id;
        end if;
      end if;
    end if;

    insert into telemetry.events (
      id, occurred_at, clock_skew_ms, install_id, person_id, realm_id, account_id, session_ref,
      run_id, trace_id, span_id, parent_span_id, surface, mcp_client, kind, name, status,
      duration_ms, error_class, error_code, fingerprint, message, app_version, attrs
    ) values (
      (e ->> 'id')::uuid, v_occurred, v_skew_ms, p_install_id, v_install.person_id, v_realm_id, v_account_id,
      (e ->> 'sessionRef')::uuid, (e ->> 'runId')::uuid, (e ->> 'traceId')::uuid, (e ->> 'spanId')::uuid,
      (e ->> 'parentSpanId')::uuid, e ->> 'surface', e ->> 'mcpClient', e ->> 'kind', e ->> 'name',
      e ->> 'status', (e ->> 'durationMs')::integer, e -> 'error' ->> 'class', e -> 'error' ->> 'code',
      e -> 'error' ->> 'fingerprint', e -> 'error' ->> 'message', v_version,
      coalesce(e -> 'attrs', '{}'::jsonb)
    )
    on conflict do nothing;
    get diagnostics v_rows = row_count;

    if v_rows = 1 then
      v_inserted := v_inserted + 1;
      if e ->> 'status' = 'error' and (e -> 'error' ->> 'fingerprint') is not null then
        insert into telemetry.error_groups as g (
          fingerprint, error_class, error_code, surface, name, sample_message,
          first_seen, last_seen, occurrences, first_version, last_version)
        values (
          e -> 'error' ->> 'fingerprint', coalesce(e -> 'error' ->> 'class', 'Error'), e -> 'error' ->> 'code',
          e ->> 'surface', e ->> 'name', e -> 'error' ->> 'message',
          v_occurred, v_occurred, 1, v_version, v_version)
        on conflict (fingerprint) do update set
          first_seen     = least(g.first_seen, excluded.first_seen),
          last_seen      = greatest(g.last_seen, excluded.last_seen),
          occurrences    = g.occurrences + 1,
          last_version   = case when g.last_version is null
                                  or telemetry.version_gt(excluded.last_version, g.last_version)
                                then excluded.last_version else g.last_version end,
          sample_message = coalesce(excluded.sample_message, g.sample_message),
          -- Regresión: un fallo "resuelto" que reaparece después, en una versión posterior
          -- a la del arreglo (o sin versión anotada), vuelve a abrirse solo.
          status         = case when g.status = 'resolved'
                                  and excluded.last_seen > coalesce(g.resolved_at, '-infinity'::timestamptz)
                                  and (g.resolved_in_version is null
                                       or telemetry.version_gt(excluded.last_version, g.resolved_in_version))
                                then 'open' else g.status end;
      end if;
    end if;
  end loop;

  update telemetry.installs
     set last_seen        = v_now,
         bucket_tokens    = v_tokens - v_n,
         bucket_at        = v_now,
         app_version      = v_version,
         identity_consent = v_consent
   where id = p_install_id;

  return jsonb_build_object('accepted', v_inserted, 'duplicates', v_n - v_inserted);
end
$$;

-- Derecho de cancelación (Ley 29733): borra la instalación, sus eventos y las cuentas
-- que sólo ella había visto.
create or replace function public.telemetry_forget(p_install_id uuid, p_secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accounts bigint[];
  v_events   bigint;
begin
  perform 1 from telemetry.installs where id = p_install_id and secret_hash = p_secret_hash;
  if not found then
    return jsonb_build_object('error', 'invalid_install');
  end if;

  select array_agg(distinct ev.account_id) filter (where ev.account_id is not null), count(*)
    into v_accounts, v_events
    from telemetry.events ev
   where ev.install_id = p_install_id;

  delete from telemetry.installs where id = p_install_id;

  delete from telemetry.accounts a
   where a.id = any(coalesce(v_accounts, '{}'::bigint[]))
     and not exists (select 1 from telemetry.events ev where ev.account_id = a.id);

  insert into telemetry.identity_events (kind, install_id, detail)
  values ('forgotten', p_install_id, jsonb_build_object('events', v_events));

  return jsonb_build_object('forgotten', true, 'events', v_events);
end
$$;

-- ── Permisos ─────────────────────────────────────────────────────────────────
revoke all on all tables in schema telemetry from public, anon, authenticated;
revoke all on all sequences in schema telemetry from public, anon, authenticated;
revoke all on all functions in schema telemetry from public, anon, authenticated;

revoke all on function public.telemetry_register(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.telemetry_ingest(uuid, text, timestamptz, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.telemetry_forget(uuid, text) from public, anon, authenticated;

grant execute on function public.telemetry_register(text, text, jsonb) to service_role;
grant execute on function public.telemetry_ingest(uuid, text, timestamptz, text, boolean, jsonb) to service_role;
grant execute on function public.telemetry_forget(uuid, text) to service_role;
