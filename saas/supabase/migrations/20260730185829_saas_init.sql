-- DUTIC SaaS: notificaciones multi-usuario vía WhatsApp (Baileys) + Supabase.
-- Todas las tablas quedan con RLS activo y SIN políticas para anon/authenticated:
-- sólo la service_role key (usada dentro de las Edge Functions y del dispatcher de
-- GitHub Actions, nunca expuesta a un cliente) puede leer/escribir. Estas tablas
-- guardan números de WhatsApp de terceros y el estado de sesión de Baileys, así que
-- el default debe ser "denegado" salvo acceso explícito server-side.

CREATE TABLE IF NOT EXISTS public.students (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  unsa_user_id    integer UNIQUE NOT NULL,
  full_name       text NOT NULL,
  enroll_token    text UNIQUE NOT NULL,
  whatsapp_number text,
  status          text NOT NULL DEFAULT 'pending_link'
                    CHECK (status IN ('pending_link', 'active', 'paused')),
  enrolled_at     timestamptz NOT NULL DEFAULT now(),
  linked_at       timestamptz,
  last_push_at    timestamptz
);
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.course_snapshot (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  course_id   integer NOT NULL,
  snapshot    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, course_id)
);
ALTER TABLE public.course_snapshot ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.pending_notifications (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  student_id  uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  kind        text NOT NULL, -- 'new_task' | 'new_grade' | 'grade_change' | 'submission_change' | 'due_date_change'
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
ALTER TABLE public.pending_notifications ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS pending_notifications_unsent_idx
  ON public.pending_notifications (created_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
  bot_number  text PRIMARY KEY,
  creds       jsonb NOT NULL DEFAULT '{}'::jsonb,
  keys        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'disconnected'
                CHECK (status IN ('disconnected', 'connected', 'banned_suspected')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;

SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
