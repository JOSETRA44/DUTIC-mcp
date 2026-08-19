# dutic-mcp

**Servidor MCP + CLI para el aula virtual DUTIC (Moodle) de la UNSA.**
Tus tareas —incluidas las **ocultas**—, notas, materiales de estudio y compañeros, en la terminal
y disponibles para agentes de IA (Claude Code, Antigravity, OpenCode, mimocode…).

```
┌─────────────────────────────────────────────┐
│ 24 tareas · 10 SIN ENTREGAR                 │
│ 18 ocultas que el calendario no te muestra  │
└─────────────────────────────────────────────┘
```

## Por qué existe

El timeline de Moodle sólo muestra tareas **accionables** (futuras y sin entregar). Las tareas sin
fecha de calendario, ya vencidas o ya entregadas **desaparecen de la vista** — y así se pierden
entregas. `dutic` barre todos los cursos, encuentra esas tareas, las marca como `OCULTA` y ordena
lo pendiente por urgencia.

---

## Instalación

**Requisitos:** [Node.js](https://nodejs.org) ≥ 20 y Google Chrome (o Edge) instalado.
No hace falta descargar Chromium: se usa el navegador que ya tienes.

### Un solo comando

```bash
npm install -g @josetra/dutic-mcp
```

Esto deja `dutic` y `dutic-mcp` en tu PATH.

<details>
<summary>Instalar desde el código fuente</summary>

```bash
git clone https://github.com/JOSETRA44/dutic-mcp.git
cd dutic-mcp
npm install        # compila automáticamente (script prepare)
npm install -g .   # deja los comandos en el PATH
```
</details>

---

## Primeros pasos

### 1. Configura tus agentes (una vez)

```bash
dutic setup
```

Registra el servidor MCP en los agentes que tengas instalados y copia la skill `dutic` a sus
directorios. Hace copia de seguridad (`*.dutic-bak`) y **no toca** el resto de tu configuración.

```
[OK] Claude Code (MCP)    C:\Users\tu-usuario\.claude.json
[OK] Antigravity (MCP)    ...\.antigravity\config\mcp_config.json
[OK] OpenCode (MCP)       ...\.config\opencode\opencode.jsonc
[OK] mimocode (MCP)       ...\.config\mimocode\mimocode.jsonc
[OK] Claude Code (skill)  ...\.claude\skills\dutic
```

> Reinicia cada agente para que cargue el servidor.

### 2. Inicia sesión (una vez)

```bash
dutic login
```

Se abre tu Chrome en el aula virtual. Pulsa **«Ingresar con Correo UNSA»**, elige tu cuenta de
Google y espera: la ventana se cierra sola al capturar la sesión. El perfil del navegador queda
guardado, así que las renovaciones posteriores suelen ser automáticas.

### 3. Compruébalo

```bash
dutic status          # ¿sesión válida?
dutic tasks --all     # tus tareas, incluidas las ocultas
```

Si ves tus tareas, ya está todo listo. Pídeselo también a tu agente:
*«¿tengo alguna tarea pendiente en el aula virtual?»*

### 3. Comandos Rapidos (Cheat Sheet)

Una vez iniciada la sesion, usa estos comandos frecuentemente para interactuar con tu entorno:

```bash
# Ver estado de sesion
dutic status

# Revisar que tareas faltan (incluyendo ocultas)
dutic tasks --all

# Descargar materiales del curso a tu computadora
dutic study <courseId> --dest ./materiales

# Forzar busqueda de nuevos cursos matriculados
dutic courses --refresh

# Buscar un curso o docente en la base de datos local
dutic search "estadistica"
```

---

## Uso — CLI

| Comando | Qué hace |
|---|---|
| `dutic tasks` | Tareas próximas del timeline (rápido) |
| `dutic tasks --all` | **+ barrido de cursos → incluye las ocultas** |
| `dutic tasks --hidden` | Sólo las ocultas |
| `dutic watch` | **Novedades** desde la última revisión (tareas/notas nuevas, entregas, fechas) |
| `dutic whoami` | Tu propio perfil (nombre, correo, id) |
| `dutic sisacad` | Captura tus notas parciales de SISACAD — **tú** haces el login + CAPTCHA; sólo tus datos |
| `dutic sisacad show` | Muestra las notas ya capturadas, agrupadas por curso con promedio ponderado |
| `dutic sisacad compare` | Compara el promedio de SISACAD (oficial) con el total que calcula Moodle |
| `dutic hrs` | **Tu horario de clases** (sistema de matrícula del extranet, sin CAPTCHA) |
| `dutic hrs <CUI>` | Horario de ese alumno (misma escuela por defecto; `--depe` para otras) |
| `dutic hrs login` | Guarda y verifica usuario/clave/Escuela del sistema de matrícula (clave sin eco) |
| `dutic hrs show` / `status` | Último horario descargado (sin red) / estado de credenciales y caché |
| `dutic task <cmid>` | Detalle: consigna, fechas, adjuntos, conflicto de fechas |
| `dutic grades [id]` | Notas: resumen de todos los cursos, o detalle de uno |
| `dutic courses` | Cursos matriculados |
| `dutic materials <id> [--section "Tema 2"]` | Archivos del curso, por unidad |
| `dutic study <id> [--section "Tema 2"]` | Baja materiales y convierte PDFs a Markdown |
| `dutic read <url>` | Lee un recurso (PDF→Markdown) para analizarlo |
| `dutic md <archivo.pdf>` | Convierte un PDF local a Markdown |
| `dutic people <id>` | Todos los compañeros del curso, con correo (`--no-email` para omitir) |
| `dutic person <texto>` | Busca por nombre/correo: su correo y **sus cursos reales** (con grupo), marcando cuáles compartes |
| `dutic profile <userId>` | Perfil por id (docentes incluidos): correo, **rol**, cursos — resuelve el curso en común solo, sin `--course` |
| `dutic teachers <id>` | Docentes del curso |
| `dutic search <query>` | Busca cursos o docentes en la base de datos local |
| `dutic scan-courses` | Escanea cursos por rango de IDs para armar tu base de datos y respaldar en la nube |
| `dutic fetch <url>` | Explora cualquier página del aula por URL (cambiar ids, ver lo que no tiene botón) |
| `dutic pull <id>` | Descarga todos los materiales |
| `dutic auto install` / `status` / `uninstall` | Revisión automática en segundo plano (tarea programada, sin daemon) |
| `dutic cache info` / `clear` | Gestiona la caché local (perfiles, cursos…) |
| `dutic setup` / `dutic login` / `dutic status` | Configuración y sesión |

Opciones globales: `--refresh` (ignora la caché y trae datos frescos), `--no-cache`, `--json`.

### Rendimiento y Refresco

Las consultas de personas/cursos se **cachean en disco** (`~/.dutic/cache/`): repetir `person`,
`people`, `grades` o `tasks` es casi instantaneo. Usa `--refresh` para ignorar el cache temporalmente y forzar datos frescos. Esto es muy util para reescanear tras algun cambio (matriculas nuevas, fechas extendidas, etc.).

### Ejemplos Utiles

```bash
# Que me falta entregar exactamente?
dutic tasks --all

# Forzar que busque nuevas tareas saltandose el cache
dutic tasks --all --refresh

# Preparar solo la unidad que voy a estudiar
dutic study 2279 --section "Tema 2" --dest ./materiales

# Que pide exactamente esta tarea?
dutic task 385686

# Forzar el rescanneo de materiales de un curso
dutic materials 2279 --refresh

# Quien es y en que cursos coincido con el? (correo + todos los cursos compartidos)
dutic person "Piero"

# Escanear perfiles de cursos (1 al 5000) para crear tu propia base de datos offline
dutic scan-courses --from 1 --to 5000

# Quien ensena Estadistica? (requiere haber ejecutado scan-courses primero)
dutic search "Estadistica"
```

---

## Uso — con agentes (MCP)

Tras `dutic setup` no hay nada más que hacer: pregúntale a tu agente por tus tareas, notas o
materiales y usará las herramientas del servidor.

<details>
<summary>Configuración manual (otros clientes MCP)</summary>

```json
{
  "mcpServers": {
    "dutic": {
      "command": "dutic-mcp",
      "env": { "DUTIC_SEMESTER": "2026A" }
    }
  }
}
```

Si tu cliente no resuelve comandos del PATH, usa la ruta absoluta que imprime `dutic setup`:
`{ "command": "node", "args": ["<ruta>/dist/mcp/server.js"] }`
</details>

**25 herramientas**: novedades (`dutic_check_changes`), notas SISACAD (`dutic_get_sisacad_grades`,
`dutic_compare_grades`), horario (`dutic_get_horario`), perfil propio (`dutic_whoami`), tareas
(`dutic_list_tasks`, `dutic_get_assignment_detail`, …), notas
(`dutic_get_grades`), materiales (`dutic_list_course_materials`, `dutic_study_course`,
`dutic_read_resource`, `dutic_pdf_to_markdown`), personas (`dutic_list_participants`,
`dutic_find_person`, `dutic_get_person_profile`, `dutic_get_course_teachers`), exploración por URL
(`dutic_fetch_page`) y sesión.

---

## Encuesta de desempeño docente

Cada semestre toca llenar la encuesta de evaluación docente en el extranet
(`extranet.unsa.edu.pe/encuesta2`): **21 preguntas por cada profesor**. Con 7 docentes son ~147
clics en un formulario de hace quince años. Esto lo reduce a una frase.

```bash
dutic encuesta login                                          # usuario + clave (la de matrícula)
dutic encuesta policy set --escala Siempre --calificacion 18  # tu criterio, una sola vez
dutic encuesta fill --todas                                   # SIMULA: enseña las 21 respuestas
dutic encuesta fill --todas --enviar --si-es-irreversible     # envía de verdad
```

Con matices por docente o por pregunta:

```bash
dutic encuesta policy set --docente QUENAYA --escala "A veces" --calificacion 12
dutic encuesta show BEJAR --escala Siempre --pregunta 4=Nunca   # puntualidad aparte
```

**El envío es irreversible y sólo se puede hacer una vez por docente.** Por eso:

- Todo **simula por defecto**; enviar exige `--enviar` **y** `--si-es-irreversible`.
- No hay respuesta por defecto escondida en el código: sin política configurada, la herramienta se
  niega a completar en vez de inventarse una valoración.
- Antes de cada POST se vuelve a comprobar que el id de alternativa que va a viajar corresponde a
  la etiqueta que se te mostró. En este sistema los ids van al revés que la escala (`731=Nunca` …
  `728=Siempre`, la mejor respuesta tiene el id más bajo), así que todo se resuelve por la etiqueta
  de texto y nunca por posición.
- Nunca se reenvía algo ya llenado: se comprueba contra el servidor y contra un registro local
  (`~/.dutic/encuesta-log.json`), que es la única prueba de lo enviado porque el sistema no da acuse.

Desde un agente: `dutic_encuesta_preview` para revisar y `dutic_encuesta_submit` para una evaluación
real docente por docente, o `dutic_encuesta_fill_all` para el modo zero touch con tu política.

---

## Horario de clases

El horario vive en el **sistema de matrícula** del extranet (`extranet.unsa.edu.pe/sisacad/...`),
otro sistema aparte del aula virtual y de SISACAD de notas: login con usuario + clave +
Escuela/Programa **sin CAPTCHA**, así que el MCP lo opera entero por HTTP.

```bash
dutic hrs login        # una vez: usuario + clave + escuela (ECONOMÍA o su código 4700)
dutic hrs              # tu horario, día por día: hora, asignatura y aula
dutic hrs <CUI>        # el horario de ese alumno (la URL del sistema acepta otro codi_usua)
dutic hrs show         # el último descargado, sin tocar la red
```

- Las clases de varias horas seguidas llegan como **un solo bloque** con su franja inicial (el
  sistema las marca con rowspan en la grilla semanal).
- Para el horario de alguien de **otra escuela** añade `--depe` con su código de dependencia
  (por defecto se usa la del propio login, p. ej. `470` = ECONOMÍA).
- Si las credenciales fallan, el sistema responde su mensaje oficial ("Cuenta NO ES Valida"); la
  escuela se acepta por nombre o por código y se valida contra el select real del login.
- Guarda las credenciales en `~/.dutic/sisacad-login.json` (permisos 600) y el último horario en
  `~/.dutic/horario.json` — nunca se versionan.

---

## Piloto de notificaciones por WhatsApp (opt-in)

Experimento **separado** del uso personal de arriba: un bot que avisa por WhatsApp cuando aparece una
tarea o nota nueva. Sólo para quien decida enrolarse explícitamente — nadie queda inscrito sin haberlo
pedido.

```bash
dutic saas enroll   # te registra (una vez) y te da un código corto de 6 caracteres
# le escribes ese código, tal cual, al número de WhatsApp del bot (te lo da el operador del piloto)
```

**Y ya está — no hay nada más que recordar.** `dutic saas enroll` deja activada la revisión
automática: tu PC revisa el aula virtual sola cada 3 horas y te avisa por WhatsApp si aparece una
tarea o una nota. Puedes verlo con `dutic auto status` y desactivarlo con `dutic auto uninstall`.

Cómo está construido, y por qué:

- **El scraping nunca sale de tu PC.** `dutic saas push` reutiliza el mismo `dutic watch` de siempre;
  sólo empuja el *resultado* (tarea nueva, nota nueva) a Supabase — jamás tu `MoodleSession` ni tu
  `sesskey`. Centralizar el login de Google OAuth de otros estudiantes en la nube no es viable (los
  sistemas anti-bot de Google bloquean ese patrón) ni seguro (expondría la sesión de todos en un solo
  lugar), así que el login sigue pasando, como siempre, en la máquina de cada quien.
- **La mensajería usa Baileys** (librería no oficial de WhatsApp) con **1-3 números dedicados/externos**
  del piloto — nunca el número personal de un estudiante. Sólo esos números del bot están expuestos a
  un eventual baneo de Meta; son reemplazables sin afectar a nadie más. El envío tiene demoras
  aleatorias entre mensajes y variación de texto para reducir el riesgo de detección como spam.
- **"Despertador" del bot**: el dispatcher normalmente sólo corre por cron (2x/día), así que un código
  de vinculación enviado justo después de `dutic saas enroll` podía quedar con el check gris horas. La
  Edge Function `enroll` dispara un `workflow_dispatch` de GitHub Actions apenas se crea un estudiante
  nuevo, con una ventana de escucha más larga (150s) que la de las corridas por cron (20s). Como
  `enroll` es un endpoint público, el disparo está limitado a **uno cada 2 minutos** (tabla
  `dispatch_wakeups`, claim atómico) sin importar cuántas veces se llame — así no se puede agotar el
  presupuesto gratis de Actions ni el rate-limit del token de GitHub llamando `enroll` en bucle.
- **Sin daemon residente.** La revisión automática no deja ningún proceso vivo consumiendo RAM: se
  registra una tarea en el Programador de tareas de Windows que ejecuta `dutic auto run` cada 3 h;
  cada pasada dura segundos y termina. En reposo el consumo es cero. Se usa el Programador de tareas
  y no una clave `Run` del registro precisamente porque esa clave es el patrón de persistencia que
  marcan los antivirus.
- **Respetuoso con tu laptop y con la UNSA.** Corre en prioridad baja, sólo si hay red, nunca
  despierta un equipo dormido, y se salta la pasada si no hay conexión o si estás usando `dutic` a
  mano. El disparo lleva retraso aleatorio (hasta 45 min) para que, si muchos estudiantes lo tienen
  instalado, no barran el aula virtual todos en el mismo instante.
- **Nunca aparece una ventana de la nada.** La renovación de sesión en segundo plano es estrictamente
  headless. Si el SSO de Google caduca de verdad y no se puede renovar en silencio, en vez de abrirte
  un navegador sin avisar, el bot te escribe por WhatsApp pidiéndote que corras `dutic login`.
- Piloto con consentimiento explícito de cada participante — no un lanzamiento masivo a la facultad.

## Configuración

| Variable | Para qué | Por defecto |
|---|---|---|
| `DUTIC_SEMESTER` | Semestre en la URL del aula (`2026A`, `2026B`…) | `2026A` |
| `DUTIC_BROWSER_CHANNEL` | Navegador para el login: `chrome`, `msedge`, `chromium` | `chrome` |
| `DUTIC_DATA_DIR` | Dónde guardar sesión y perfil | `~/.dutic` |
| `DUTIC_ENCUESTA_USER` | Usuario de la encuesta docente (evita guardarlo en disco) | — |
| `DUTIC_ENCUESTA_PASSWORD` | Clave de la encuesta docente | — |
| `DUTIC_SISACAD_USER` | Usuario del sistema de matrícula (`dutic hrs`) | — |
| `DUTIC_SISACAD_PASSWORD` | Clave del sistema de matrícula | — |
| `DUTIC_SISACAD_ESCUELA` | Escuela del sistema de matrícula (código o nombre) | — |
| `DUTIC_MATRICULA_PATH` | Ruta del login de matrícula, cambia cada ciclo (`matr_int_2026b_v2.00`) | auto |

El semestre sólo se usa para la URL de login: tras iniciar sesión **se auto-detecta** del propio
aula, así que al cambiar de período normalmente no hay que tocar nada.

---

## Cómo funciona

No usa la API pública de web services (la UNSA la tiene bloqueada). Captura la cookie
`MoodleSession` y el token `sesskey` tras el login de Google (Playwright manejando tu Chrome) y con
ellos llama al endpoint AJAX interno de Moodle, complementado con scraping donde hace falta.

| Necesidad | Fuente | Estado |
|---|---|---|
| Descubrir todas las tareas | `core_courseformat_get_state` | SI |
| Cursos matriculados | `core_course_get_enrolled_courses_by_timeline_classification` | SI |
| Timeline y fechas | `core_calendar_get_action_events_by_timesort` | SI (sólo accionables) |
| Estado de entrega, consigna, adjuntos | scraping de `mod/assign/view.php` | SI |
| Notas | scraping de `grade/report/user/index.php` | SI |
| Personas y correos | scraping de `user/index.php` y `user/view.php` | SI |
| `core_course_get_contents`, `mod_assign_*`, `gradereport_*` | — | NO bloqueadas por la UNSA |

**Fechas contradictorias:** algunas consignas mencionan una fecha distinta a la configurada en
Moodle. `dutic task <cmid>` compara ambas y avisa (`dateConflict`) — es la causa típica de entregas
perdidas.

**SISACAD es distinto a propósito.** Es un sistema aparte (`extranet.unsa.edu.pe`) protegido con
CAPTCHA, y esa protección se respeta: `dutic sisacad` no automatiza el login ni resuelve el CAPTCHA
por ti — abre el navegador, **tú** entras con tu usuario/clave y lo resuelves, y sólo cuando aparecen
tus notas la herramienta las lee y las estructura (por curso, con el promedio ponderado). Nunca
accede a datos de otros estudiantes.

**El horario (`dutic hrs`) vive en el sistema de matrícula del mismo extranet** — login
usuario+clave+escuela **sin CAPTCHA** — y su página acepta un CUI cualquiera en la URL
(`horario_datos.php3?codi_usua=…`), así que se opera entero por HTTP. La ruta del login
(`matr_int_2026b_v2.00`) cambia cada ciclo: se ajusta con `DUTIC_MATRICULA_PATH`.

---

## Publicar en npm

```bash
npm login                 # cuenta de npm
npm version patch         # o minor / major
npm publish               # el paquete es scoped y público (publishConfig.access)
git push --follow-tags
```

`prepublishOnly` compila antes de publicar y `files` limita el tarball a `dist/` y `skills/`.

> Si tu scope de npm no es `@joswetra`, cambia el campo `name` en `package.json` por
> `@tu-scope/dutic-mcp` (o un nombre sin scope que esté libre).

---

## Privacidad y seguridad

- La sesión (`~/.dutic/session.json`) y el perfil del navegador contienen credenciales de tu
  cuenta: no se versionan y el archivo se crea con permisos restrictivos.
- El certificado de `aulavirtual.unsa.edu.pe` (CA privada de la UNSA) se acepta **sólo** para ese host.
- La herramienta accede únicamente a lo que tú ya ves en el aula. Donde Moodle oculta información
  (docentes en el listado, compañeros de otros grupos) se respeta esa restricción.
- `dutic profile <userId>` resuelve **un** id a la vez, dado por una vía legítima tuya (una tarea
  calificada, un correo, un enlace que ya tenías). No está pensado ni se debe usar para recorrer
  rangos de ids y construir un directorio de docentes/estudiantes de la facultad — eso sería
  scraping masivo de datos personales de terceros sin su consentimiento.
- El piloto de notificaciones (`dutic saas enroll`/`push`) es **opt-in**: sólo guarda datos de quien
  ejecuta `enroll` explícitamente. `pending_notifications` y `students` en Supabase existen sólo para
  avisar al propio dueño de esa fila — nunca para leer, listar o reenviar datos de otro estudiante.

## Licencia

MIT © JOSETRA44
