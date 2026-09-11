-- Mantenimiento diario de la telemetría con pg_cron (Supabase Cron).
--
-- 08:17 UTC = 03:17 en Lima: fuera de horario de uso. `telemetry.maintenance()` crea las
-- particiones de los próximos meses, borra las de más de 6 meses (un DROP por mes, no un
-- DELETE fila a fila), limpia el límite de altas por IP y las instalaciones anónimas
-- abandonadas. Si un día no corre, no pasa nada: siempre hay tres meses de margen.
create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

select cron.schedule(
  'telemetry-maintenance',
  '17 8 * * *',
  $$select telemetry.maintenance()$$
);
