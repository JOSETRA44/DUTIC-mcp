-- Bookkeeping para el "despertador" del dispatcher: la Edge Function `enroll` puede
-- disparar un workflow_dispatch de GitHub Actions para que el bot conecte casi de
-- inmediato en vez de esperar al próximo cron (arregla el "síndrome del check gris").
-- Fila única con debounce: como `enroll` es un endpoint público (sin verify_jwt), este
-- cooldown acota a UNO el número de workflow_dispatch que puede disparar por ventana,
-- sin importar cuántas veces se llame `enroll` — es la defensa contra abuso/DDoS para
-- este mecanismo (agotar minutos de Actions o el rate-limit del token de GitHub).
CREATE TABLE IF NOT EXISTS public.dispatch_wakeups (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- fuerza fila única
  last_triggered_at timestamptz
);
ALTER TABLE public.dispatch_wakeups ENABLE ROW LEVEL SECURITY;
INSERT INTO public.dispatch_wakeups (id, last_triggered_at) VALUES (1, NULL)
  ON CONFLICT (id) DO NOTHING;
