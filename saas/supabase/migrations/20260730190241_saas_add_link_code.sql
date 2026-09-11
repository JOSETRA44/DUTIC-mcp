-- Código corto que el estudiante escribe UNA VEZ por WhatsApp al número del bot para
-- probar que ese número es suyo y completar la vinculación. Separado del enroll_token
-- (que es largo y vive sólo en ~/.dutic/saas.json, nunca se teclea) para no filtrar ni
-- un prefijo del secreto usado para autenticar `dutic saas push`.
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS link_code text UNIQUE;
