-- ═════════════════════════════════════════════════════════════════════════════
--  Catálogo de la Biblioteca Virtual UNSA (Koha) — índice propio
--
--  POR QUÉ. El OPAC responde en ~10-16 s por consulta nueva: sólo es rápido si la
--  petición llega por una conexión que tuvo otra hace menos de ~1 s (ver
--  docs/biblioteca-diagnostico.md). Copiando los 199 270 registros aquí, la búsqueda
--  pasa a milisegundos y el OPAC sólo se consulta para la disponibilidad al abrir una
--  ficha.
--
--  AISLAMIENTO. El catálogo es información PÚBLICA, pero convive con el esquema
--  `public` de este proyecto, que sí tiene datos personales del piloto. Por eso vive en
--  `library`, que PostgREST no expone y sobre el que anon/authenticated no tienen ni
--  USAGE. La única puerta de lectura es `public.library_search`; la única de escritura,
--  `public.library_ingest_batch`, que sólo puede ejecutar service_role.
--
--  IDENTIDAD DE UN REGISTRO. `id` es el biblionumber de Koha: estable, y lo que hace
--  idempotente al barrido (todo es upsert, reprocesar un bloque no duplica).
-- ═════════════════════════════════════════════════════════════════════════════

create schema if not exists library;
revoke all on schema library from public, anon, authenticated;
alter default privileges in schema library revoke all on tables from public, anon, authenticated;
alter default privileges in schema library revoke all on sequences from public, anon, authenticated;
alter default privileges in schema library revoke all on functions from public, anon, authenticated;

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ── Búsqueda sin tildes ──────────────────────────────────────────────────────
-- `unaccent` es STABLE (depende del diccionario cargado), y una columna generada exige
-- IMMUTABLE. Se envuelve fijando el diccionario explícitamente, que es la forma
-- soportada de hacerlo determinista.
create or replace function library.immutable_unaccent(txt text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, txt) $$;

-- `array_to_string` está marcada STABLE (no IMMUTABLE), y eso contamina toda la
-- expresión de una columna generada. Para un text[] la operación sí es determinista,
-- así que se envuelve declarándola inmutable.
create or replace function library.immutable_join(arr text[])
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$ select array_to_string(arr, ' ') $$;

-- ── Registros bibliográficos ─────────────────────────────────────────────────
create table if not exists library.biblios (
  id          bigint primary key,                    -- biblionumber de Koha
  title       text not null,
  authors     text[] not null default '{}',
  edition     text,
  publisher   text,
  year        smallint,
  isbn        text,
  language    text,

  -- Resumen de disponibilidad del último barrido (sedes, signatura, nº de ejemplares).
  -- Es una FOTO: el estado real se consulta en vivo al abrir la ficha.
  availability jsonb not null default '{}'::jsonb,
  availability_checked_at timestamptz,

  search_vector tsvector generated always as (
    to_tsvector(
      'spanish',
      library.immutable_unaccent(
        coalesce(title, '') || ' ' ||
        coalesce(library.immutable_join(authors), '') || ' ' ||
        coalesce(publisher, '') || ' ' ||
        coalesce(isbn, '')
      )
    )
  ) stored,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  source_run    bigint
);

create index if not exists biblios_search_idx on library.biblios using gin (search_vector);
create index if not exists biblios_isbn_idx on library.biblios (isbn) where isbn is not null;
-- Para "¿qué entró nuevo?" y para auditar barridos incompletos.
create index if not exists biblios_last_seen_idx on library.biblios (last_seen_at desc);

alter table library.biblios enable row level security;  -- sin políticas: nadie entra por PostgREST

-- ── Estado de los barridos (reanudación y auditoría) ─────────────────────────
create table if not exists library.harvest_runs (
  id bigserial primary key,
  mode   text not null check (mode in ('full', 'incremental', 'verify')),
  status text not null check (status in ('running', 'paused', 'done', 'failed')),

  cursor_offset  integer not null default 0,   -- por dónde sigue la próxima tanda
  total_expected integer,                      -- total que reportó el OPAC
  records_upserted integer not null default 0,
  blocks_ok      integer not null default 0,
  blocks_failed  integer not null default 0,

  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz,
  last_error  text
);

create index if not exists harvest_runs_resume_idx
  on library.harvest_runs (mode, status, started_at desc);

alter table library.harvest_runs enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
--  Puerta de ESCRITURA — sólo service_role (el harvester del operador)
-- ═════════════════════════════════════════════════════════════════════════════

-- Abre un barrido, o retoma el que quedó a medias en ese mismo modo. Devuelve el
-- estado desde el que debe continuar la tanda.
create or replace function public.library_harvest_start(p_mode text, p_total integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run library.harvest_runs;
begin
  select * into v_run
    from library.harvest_runs
   where mode = p_mode and status in ('paused', 'running')
   order by started_at desc
   limit 1;

  if not found then
    insert into library.harvest_runs (mode, status, total_expected)
    values (p_mode, 'running', p_total)
    returning * into v_run;
  else
    update library.harvest_runs
       set status = 'running',
           total_expected = coalesce(p_total, total_expected),
           updated_at = now()
     where id = v_run.id
    returning * into v_run;
  end if;

  return to_jsonb(v_run);
end;
$$;

-- Ingesta de UN bloque: upsert de las filas y avance del cursor, en una sola
-- transacción. Si algo falla, el cursor no avanza y la tanda siguiente reintenta ese
-- mismo bloque; como todo es upsert por biblionumber, repetirlo no duplica nada.
create or replace function public.library_ingest_batch(
  p_run bigint,
  p_rows jsonb,
  p_next_offset integer,
  p_total integer default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into library.biblios as b (
    id, title, authors, edition, publisher, year, isbn, language,
    availability, availability_checked_at, source_run, first_seen_at, last_seen_at
  )
  select
    (r->>'id')::bigint,
    coalesce(r->>'title', '(sin título)'),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(r->'authors')),
      '{}'::text[]
    ),
    nullif(r->>'edition', ''),
    nullif(r->>'publisher', ''),
    (r->>'year')::smallint,
    nullif(r->>'isbn', ''),
    nullif(r->>'language', ''),
    coalesce(r->'availability', '{}'::jsonb),
    now(),
    p_run,
    now(),
    now()
  from jsonb_array_elements(p_rows) as r
  where (r->>'id') ~ '^\d+$'
  on conflict (id) do update set
    title = excluded.title,
    authors = excluded.authors,
    edition = excluded.edition,
    publisher = excluded.publisher,
    year = excluded.year,
    isbn = excluded.isbn,
    language = excluded.language,
    availability = excluded.availability,
    availability_checked_at = excluded.availability_checked_at,
    source_run = excluded.source_run,
    last_seen_at = now();

  get diagnostics v_count = row_count;

  update library.harvest_runs
     set cursor_offset = greatest(cursor_offset, p_next_offset),
         records_upserted = records_upserted + v_count,
         blocks_ok = blocks_ok + 1,
         total_expected = coalesce(p_total, total_expected),
         status = 'running',
         updated_at = now()
   where id = p_run;

  return v_count;
end;
$$;

-- Cierra (o pausa) la tanda. `p_status`: paused | done | failed.
create or replace function public.library_harvest_finish(
  p_run bigint,
  p_status text,
  p_error text default null,
  p_blocks_failed integer default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update library.harvest_runs
     set status = p_status,
         last_error = p_error,
         blocks_failed = blocks_failed + coalesce(p_blocks_failed, 0),
         updated_at = now(),
         finished_at = case when p_status in ('done', 'failed') then now() else null end
   where id = p_run;
end;
$$;

-- Refresco puntual de disponibilidad (cuando alguien abre una ficha y se consulta el
-- OPAC en vivo). No toca los metadatos.
create or replace function public.library_touch_availability(
  p_id bigint,
  p_availability jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  update library.biblios
     set availability = p_availability,
         availability_checked_at = now()
   where id = p_id;
$$;

-- Cuáles de esos biblionumber ya están guardados. Lo usa el refresco incremental para
-- cortar en cuanto una página no trae nada nuevo.
create or replace function public.library_known_ids(p_ids bigint[])
returns bigint[]
language sql
security definer
stable
set search_path = ''
as $$
  select coalesce(array_agg(b.id), '{}'::bigint[])
    from library.biblios b
   where b.id = any(p_ids);
$$;

-- ═════════════════════════════════════════════════════════════════════════════
--  Puerta de LECTURA — anon/authenticated, con la forma de consulta acotada
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.library_search(
  q text,
  lim integer default 30,
  "off" integer default 0
)
returns table (
  id bigint,
  title text,
  authors text[],
  edition text,
  publisher text,
  year smallint,
  isbn text,
  language text,
  availability jsonb,
  availability_checked_at timestamptz,
  rank real,
  total bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with qq as (
    select websearch_to_tsquery('spanish', library.immutable_unaccent(coalesce(q, ''))) as tsq
  ),
  hits as (
    select b.*, ts_rank_cd(b.search_vector, qq.tsq) as rank
      from library.biblios b, qq
     where qq.tsq is not null and b.search_vector @@ qq.tsq
  )
  select h.id, h.title, h.authors, h.edition, h.publisher, h.year, h.isbn, h.language,
         h.availability, h.availability_checked_at, h.rank,
         count(*) over () as total
    from hits h
   order by h.rank desc, h.id
   -- Topes dentro de la función: el cliente no puede pedir la tabla entera.
   limit least(greatest(coalesce(lim, 30), 1), 100)
  offset greatest(coalesce("off", 0), 0);
$$;

-- ── Privilegios ──────────────────────────────────────────────────────────────
-- Postgres concede EXECUTE a public por defecto: hay que quitarlo explícitamente.
revoke execute on function public.library_harvest_start(text, integer) from public, anon, authenticated;
revoke execute on function public.library_ingest_batch(bigint, jsonb, integer, integer) from public, anon, authenticated;
revoke execute on function public.library_harvest_finish(bigint, text, text, integer) from public, anon, authenticated;
revoke execute on function public.library_touch_availability(bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.library_known_ids(bigint[]) from public, anon, authenticated;

grant execute on function public.library_harvest_start(text, integer) to service_role;
grant execute on function public.library_ingest_batch(bigint, jsonb, integer, integer) to service_role;
grant execute on function public.library_harvest_finish(bigint, text, text, integer) to service_role;
grant execute on function public.library_touch_availability(bigint, jsonb) to service_role;
grant execute on function public.library_known_ids(bigint[]) to service_role;

grant execute on function public.library_search(text, integer, integer) to anon, authenticated, service_role;

comment on schema library is
  'Copia del catálogo público de la Biblioteca Virtual UNSA (Koha). Aislado del esquema public, que tiene datos personales del piloto.';
comment on table library.biblios is
  'Un registro bibliográfico por biblionumber. `availability` es la foto del último barrido; el estado real se consulta en vivo.';
comment on table library.harvest_runs is
  'Estado de cada barrido: cursor de reanudación, totales y último error. Una tanda nocturna deja el run en paused.';
