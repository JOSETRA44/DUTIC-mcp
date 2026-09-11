-- ═════════════════════════════════════════════════════════════════════════════
--  Seguridad, fase 0 (EXPAND) — auditoría 2026-09-11
--
--  C1: `enroll` devolvía el enroll_token de cualquier estudiante existente. Desde
--      aquí el token sólo existe como hash, y un equipo nuevo se reinscribe con una
--      solicitud que únicamente se confirma desde el WhatsApp ya vinculado.
--  M2: `ingest` no tenía límite de frecuencia.
--  M1: el registro de Auth aceptaba cualquier correo.
--
--  Es la mitad "expand" de un cambio expand/contract: `enroll_token` (en claro) sigue
--  existiendo, ya no obligatoria, y un trigger mantiene el hash sincronizado para que
--  las Edge Functions anteriores sigan funcionando durante el despliegue. La migración
--  "contract" la elimina cuando las nuevas estén verificadas.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. El token deja de guardarse en claro ───────────────────────────────────
alter table public.students add column if not exists enroll_token_hash text;

update public.students
   set enroll_token_hash = encode(extensions.digest(enroll_token, 'sha256'), 'hex')
 where enroll_token is not null
   and enroll_token_hash is null;

alter table public.students alter column enroll_token_hash set not null;
create unique index if not exists students_enroll_token_hash_key
  on public.students (enroll_token_hash);
alter table public.students alter column enroll_token drop not null;

-- Puente de compatibilidad: si una versión anterior de `enroll` inserta el token en
-- claro, el hash se calcula aquí. Se elimina junto con la columna en "contract".
create or replace function public.students_hash_enroll_token()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enroll_token is not null then
    new.enroll_token_hash := encode(extensions.digest(new.enroll_token, 'sha256'), 'hex');
  end if;
  return new;
end
$$;

drop trigger if exists students_hash_enroll_token on public.students;
create trigger students_hash_enroll_token
  before insert or update of enroll_token on public.students
  for each row execute function public.students_hash_enroll_token();

-- ── 2. Límite de frecuencia por estudiante (M2) ──────────────────────────────
alter table public.students
  add column if not exists push_window_start timestamptz,
  add column if not exists push_count integer not null default 0;

-- Ventana fija atómica: el UPDATE bloquea la fila, así que dos envíos simultáneos
-- del mismo estudiante no pueden colarse los dos en el último hueco.
create or replace function public.claim_push_slot(
  p_student_id uuid,
  p_max integer default 12,
  p_window interval default interval '1 hour'
)
returns table (allowed boolean, retry_after_seconds integer)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.students s
     set push_window_start = case
           when s.push_window_start is null or s.push_window_start <= now() - p_window
           then now() else s.push_window_start end,
         push_count = case
           when s.push_window_start is null or s.push_window_start <= now() - p_window
           then 1 else s.push_count + 1 end
   where s.id = p_student_id
  returning s.push_count <= p_max,
            greatest(0, ceil(extract(epoch from (s.push_window_start + p_window - now())))::integer);
$$;

-- ── 3. Reinscripción sin entregar secretos (C1) ──────────────────────────────
create table if not exists public.reenroll_requests (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students(id) on delete cascade,
  token_hash  text not null unique,
  link_code   text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  consumed_at timestamptz
);
alter table public.reenroll_requests enable row level security;
revoke all on public.reenroll_requests from anon, authenticated;
create index if not exists reenroll_requests_student_idx
  on public.reenroll_requests (student_id);

-- La llama el dispatcher cuando llega un código por WhatsApp. Sólo activa el token
-- nuevo si el remitente es EL MISMO número ya vinculado a la cuenta: conocer el
-- unsaUserId de otra persona no alcanza para suplantarla.
create or replace function public.confirm_reenroll(p_link_code text, p_sender_number text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.reenroll_requests%rowtype;
begin
  select r.* into v_request
    from public.reenroll_requests r
    join public.students s on s.id = r.student_id
   where r.link_code = upper(p_link_code)
     and r.consumed_at is null
     and r.expires_at > now()
     and s.whatsapp_number is not null
     and s.whatsapp_number = p_sender_number
   for update of r;

  if not found then
    return null;
  end if;

  update public.students
     set enroll_token_hash = v_request.token_hash,
         enroll_token      = null
   where id = v_request.student_id;

  -- Confirmar una invalida las demás pendientes del mismo estudiante.
  update public.reenroll_requests
     set consumed_at = now()
   where student_id = v_request.student_id
     and consumed_at is null;

  return v_request.student_id;
end
$$;

-- ── 4. Registro de Auth restringido (M1) ─────────────────────────────────────
-- Hook `before-user-created`. Deja pasar a los admins de la consola (acceso por
-- código al correo) y a las cuentas institucionales entrando con Google. Todo lo
-- demás —incluidos usuarios anónimos— se rechaza. Hay que activarlo en
-- Authentication → Hooks; hasta entonces no tiene efecto.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email    text := lower(coalesce(event -> 'user' ->> 'email', ''));
  v_provider text := coalesce(event -> 'user' -> 'app_metadata' ->> 'provider', '');
begin
  if v_email <> '' and exists (
    select 1 from public.console_admins a where lower(a.email) = v_email
  ) then
    return '{}'::jsonb;
  end if;

  if v_provider = 'google' and split_part(v_email, '@', 2) = 'unsa.edu.pe' then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object('http_code', 403, 'message', 'Registro no permitido.')
  );
end
$$;

-- ── 5. Permisos: nada de esto es alcanzable desde la API pública ─────────────
-- Postgres concede EXECUTE a PUBLIC por defecto al crear una función, y `anon`
-- lo hereda. Los default privileges del lockdown no cubren a PUBLIC.
revoke all on function public.students_hash_enroll_token() from public, anon, authenticated;
revoke all on function public.claim_push_slot(uuid, integer, interval) from public, anon, authenticated;
revoke all on function public.confirm_reenroll(text, text) from public, anon, authenticated;
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

grant execute on function public.claim_push_slot(uuid, integer, interval) to service_role;
grant execute on function public.confirm_reenroll(text, text) to service_role;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
