# Telemetría de dutic: cómo funcionaba y qué queda de ella

Contexto reunido antes de reimplementar la telemetría. Sirve para no repetir el diseño anterior
y para saber qué hay realmente en producción.

**Medido el:** 2026-09-11, sobre `@josetra/dutic-mcp` 0.3.0 (última versión publicada en npm).

> **Actualización (fase 0):** el cliente de la telemetría antigua (`src/core/supabase.ts`) se
> eliminó y `dutic login` ya no anuncia sincronizaciones que no ocurren. La nueva telemetría se
> diseña en el plan de la fase 1-3 (identidad por capas: persona, instalación, realm, cuenta y
> sesión). Este documento se conserva como registro de por qué no se repite el diseño anterior.

> Este repositorio es **público**. Aquí no hay claves ni pasos de explotación. Los hallazgos de
> seguridad del piloto y de la consola están en el repo local sin remoto
> `PAGINAS-WEB/dutic-admin/docs/auditoria-seguridad-2026-09-11.md`.

---

## 1. Resumen

| Pregunta | Respuesta |
|---|---|
| ¿Dónde vivía? | Sólo en el **CLI**. El servidor MCP (`src/mcp/`) no emite nada. |
| ¿Qué enviaba? | Dos eventos: `dutic login` → `dutic_users` · `dutic scan-courses` → `dutic_courses`. |
| ¿A dónde? | PostgREST directo del proyecto Supabase `ctowimobmorctvsotibf`, con su anon key incrustada en el código. |
| ¿Funciona hoy? | **No.** El proyecto ya no existe: su dominio devuelve NXDOMAIN (ver §3). |
| ¿Alguien se entera? | No. Los errores se tragan y `dutic login` sigue imprimiendo «Perfil sincronizado». |
| ¿El panel de admin mostró datos reales? | Nunca. Ver §3 y la auditoría privada. |

---

## 2. Cómo funcionaba

### Eventos

| Disparador | Función | Tabla | Campos enviados |
|---|---|---|---|
| `dutic login` (tras el OAuth) | `syncUserToSupabase` · `src/core/supabase.ts:29` | `dutic_users` | `moodle_user_id`, `name`, `email` (institucional), `site_url`, `semester`, `last_login_at` |
| `dutic scan-courses --from --to` | `syncScannedCoursesToSupabase` · `src/core/supabase.ts:66` | `dutic_courses` | `course_id`, `name`, `teachers[]`, `semester`, `scanned_by`, `updated_at` |

Llamadas desde `src/cli/index.ts:165` y `src/cli/index.ts:737`.

### Transporte

- `fetch` nativo, sin `@supabase/supabase-js`.
- `POST /rest/v1/<tabla>` con `Prefer: resolution=merge-duplicates` (upsert sobre la PK).
- `apikey` y `Authorization: Bearer` usan la **misma anon key**, escrita como constante en el código.
- No hay timeout, reintento ni cola. Cualquier error se descarta en un `catch {}`.

### Esquema (reconstruido del código)

Las migraciones **nunca se versionaron**. El commit `a6834a0` dice "add migration scripts", pero
sólo toca `src/core/supabase.ts`, `src/cli/index.ts` y `.gitignore`. Lo único que queda es lo que
se deduce de quien escribe (el CLI) y de quien lee (`dutic-admin/src/lib/queries.ts:155`):

```
dutic_users   (moodle_user_id int PK, name text, email text null, site_url text,
               semester text, last_login_at timestamptz, created_at timestamptz)
dutic_courses (course_id int PK, name text, teachers text[], semester text,
               scanned_by int, updated_at timestamptz)
```

### Quién la leía

La pestaña **Adopción** de la consola (`dutic-admin/src/app/(consola)/adopcion/page.tsx`) pedía
hasta 500 usuarios y 1000 cursos. Deduplicaba por correo, porque cada semestre es un Moodle
distinto y la misma persona tiene un `moodle_user_id` diferente en cada uno.

---

## 3. Estado verificado el 2026-09-11

| Comprobación | Resultado | Cómo |
|---|---|---|
| DNS de `ctowimobmorctvsotibf.supabase.co` | **NXDOMAIN** en 8.8.8.8, 1.1.1.1 y DoH de Cloudflare | `nslookup`, `cloudflare-dns.com/dns-query` |
| DNS del proyecto del piloto (control) | Resuelve (172.64.149.246) | igual |
| ¿Está en alguna cuenta a la que llega el MCP? | No. El MCP `supabase` de `.mcp.json` está fijado al piloto, y el conector de claude.ai pertenece a otra cuenta, sin proyectos DUTIC | `list_projects`, `get_project_url` |
| ¿La clave sigue publicada? | Sí: `dist/core/supabase.js` va en el tarball de 0.3.0 y la clave está en la historia pública de git | `npm pack --dry-run`, `git log -S` |
| Telemetría en el servidor MCP | Ninguna | `grep` en `src/mcp` |

**Conclusión:** el proyecto se borró (un proyecto pausado sigue resolviendo DNS). Los datos que
tuviera se perdieron o están en un backup de la cuenta dueña. **Hay que confirmarlo desde esa
cuenta.**

---

## 4. Defectos del diseño anterior (no replicar)

1. **No había identidad.** La clave publicada tenía `SELECT/INSERT/UPDATE/DELETE` sobre ambas
   tablas. Cualquiera podía listar nombres y correos, o sobrescribir y borrar filas ajenas. Pasó de
   verdad el 2026-07-31: una PATCH mal filtrada durante una auditoría pisó los 4 nombres. Ninguna
   política RLS lo arregla, porque sin identidad no hay nada que comparar.
2. **Datos personales sin aviso ni consentimiento.** Cada login enviaba nombre y correo
   institucional en silencio, y el README no menciona la telemetría. En Perú aplica la Ley 29733 de
   Protección de Datos Personales, que exige consentimiento informado.
3. **Datos de terceros.** `teachers[]` guarda nombres de docentes que nunca usaron la herramienta.
4. **Clave primaria que choca entre semestres.** `moodle_user_id` es único dentro de *un* Moodle,
   pero cada semestre es una instancia distinta. El mismo número en 2026A y en 2026B puede ser otra
   persona, y el upsert sobrescribiría su fila. *(Riesgo deducido del modelo; no comprobado con
   datos.)*
5. **`scanned_by` siempre valía 0.** El código lee `(sess as any)?.userId`, pero `Session` no tiene
   ese campo (`src/core/session.ts:15`).
6. **Éxito falso.** `syncUserToSupabase` se traga el error por dentro, así que `dutic login`
   imprime «Perfil sincronizado» aunque el proyecto no exista.
7. **Clave sin rotación posible.** Cambiarla obliga a publicar otra versión en npm, y las
   instalaciones viejas seguirán usando la anterior.

---

## 5. Requisitos que se derivan para la nueva telemetría

- **Ninguna tabla escribible con una clave publicada.** Se ingiere por una Edge Function, y las
  tablas no dan ningún GRANT a `anon`/`authenticated`. El piloto ya usa ese patrón y responde
  `401 42501` a la anon key (verificado).
- **Decidir antes entre anónima e identificada** (§6). Cambia qué se puede proteger.
- **Opt-out claro y documentado:** variable (`DUTIC_TELEMETRY=0`, respetar `DO_NOT_TRACK=1`) y
  aviso en la primera ejecución y en el README.
- **Nunca bloquear ni mentir:** timeout corto, fallo silencioso para el usuario pero visible con
  `--verbose`.
- **Eventos del MCP sin argumentos:** nombre de la tool, duración, clase de error y versión. Nunca
  los argumentos ni el resultado, que llevan nombres de cursos, personas y notas.
- **Una identidad estable entre semestres** si se quiere contar personas. `moodle_user_id` no lo es.
- **La consola debe leerla con el mismo candado de base de datos** que el piloto
  (`is_console_admin()`), no con una clave de servidor.

---

## 6. Diseño vigente (implementado el 2026-09-11)

**Decisiones:**
- La telemetría vive en el proyecto del piloto, en un esquema `telemetry` que PostgREST no expone.
- Telemetría técnica activa por defecto, con aviso y opt-out. La identidad es opt-in.
- La identidad se verifica de forma automática aprovechando el login de Google (fase 1, pendiente).

### Identidad por capas

| Capa | Clave | Por qué |
|---|---|---|
| Persona | `auth.users.id` (Google `@unsa.edu.pe`) | Estable entre semestres y equipos |
| Instalación | uuid + secreto de 256 bits generado en el equipo; el servidor sólo guarda su sha256 | Nadie puede escribir eventos a nombre de otro equipo |
| Realm | `moodle:aulavirtual.unsa.edu.pe/2026B` (tipo extensible: `sisacad`, `encuesta`…) | Cada semestre es un Moodle distinto |
| Cuenta | `(realm, HMAC(pepper en Vault, uid))` | El mismo uid en 2026A y 2026B son dos cuentas: sin colisiones |
| Sesión | `session.json.ref`, uuid aleatorio | Traza renovaciones sin revelar nada de la cookie |

El realm sale de la URL donde **aterrizó** el login, no del semestre pedido. Una cuenta reclamada
por dos personas se marca `conflict` y nunca se reasigna en silencio.

### Piezas

- **Cliente (`src/telemetry/`):**
  - `consent`: opt-out y consentimiento.
  - `install`: credencial.
  - `envelope`: contexto por llamada vía AsyncLocalStorage.
  - `fingerprint`: huella estable entre versiones.
  - `scrub`: saneado.
  - `spool`: cola en disco multiproceso sin locks.
  - `transport`.
  - `index`: spans, errores y envío con presupuesto de tiempo.
- **Instrumentación:**
  - cada tool MCP, dentro de su semestre;
  - cada comando CLI;
  - renovación y login de sesión;
  - latido del agente automático;
  - cliente MCP detectado en `initialize`.
- **Servidor:**
  - Edge Functions `telemetry-register`, `telemetry-ingest` y `telemetry-forget`, que validan
    campo a campo y drenan cuerpos grandes antes del 413;
  - RPCs `public.telemetry_*`, sólo para `service_role`;
  - particiones mensuales con retención de 6 meses vía `pg_cron`;
  - token bucket por instalación y límite de altas por IP con HMAC;
  - grupos de error con reapertura automática por regresión.
- **Consola:** pestañas Errores (heatmap hora × día en Lima, resolver/ignorar), Uso, Personas y
  Traza, sobre RPCs `console_*` protegidas con `is_console_admin()`.

**Verificado:**
- Pruebas unitarias del cliente.
- Pruebas SQL con rollback: idempotencia, colisiones entre semestres, regresión, revocación de
  consentimiento, límites y olvido.
- Contrato de extremo a extremo con el código real del cliente contra producción.
- stdout del MCP intacto.
- `next build` de la consola.

### Pendiente

1. **Política de datos personales:** implementar `redactPersonal` en `src/telemetry/scrub.ts` y
   poner `PERSONAL_POLICY_READY = true`. Hasta entonces dutic no registra ni envía nada.
2. **Fase 1 (identidad con Google):** requiere configurar el proveedor Google en Supabase; después,
   la función `identity-link` y el enlace PKCE dentro de `dutic login`.
3. **Contract** de la columna `students.enroll_token` tras verificar pushes reales.
