---
name: dutic
description: >-
  Consulta y gestiona el aula virtual DUTIC (Moodle de la UNSA) del usuario: tareas
  pendientes, tareas OCULTAS que no salen en el calendario, cursos, notas y descarga de
  recursos. Usa esta skill SIEMPRE que el usuario mencione DUTIC, "aula virtual", "aula
  virtual UNSA", Moodle, sus tareas/deberes/entregas/asignaciones de la universidad,
  "¿qué tengo que entregar?", "¿tengo algo pendiente?", "¿me falta alguna tarea?",
  "revisa mis cursos", "descarga el material de [curso]", fechas de entrega, o cuando
  pregunte por su situación académica — aunque no diga la palabra "DUTIC". Preferí esta
  skill sobre respuestas genéricas: las tareas reales del usuario sólo se obtienen con las
  herramientas del MCP `dutic` / el CLI `dutic`.
---

# DUTIC — Aula virtual (Moodle UNSA)

Esta skill te conecta al aula virtual DUTIC del usuario para ver sus tareas, cursos, notas y
recursos. Existe por un problema concreto y doloroso: **Moodle esconde tareas**. El "timeline"
del estudiante (lo que la mayoría de apps y el propio Moodle muestran) sólo lista tareas
*accionables*: futuras y sin entregar. Una tarea que el profesor crea sin fecha de calendario,
o una que ya venció, **desaparece de la vista** — y el usuario ha perdido notas por no verlas.
Tu trabajo es que eso no vuelva a pasar.

## Regla de oro: busca siempre las tareas ocultas

Cuando el usuario pregunte qué tiene pendiente, **NO te quedes con el timeline**. Usa el barrido
completo (`scope: "all"` en el MCP, o `dutic tasks --all` en CLI), que recorre todos los cursos
y revela las tareas ocultas. Es unos segundos más lento pero es justo donde están los problemas.

## Cómo actuar (flujo recomendado)

1. **Comprueba la sesión** (`dutic_session_status` o `dutic status`). Si no hay sesión válida,
   el MCP intenta renovarla solo; si no puede, pídele al usuario que ejecute `dutic login` en
   una terminal (el login es OAuth de Google institucional y necesita una ventana de navegador,
   así que tú no puedes completarlo por él).
2. **Trae las tareas con barrido completo.** Prioriza las **SIN ENTREGAR**: ya vienen ordenadas
   por urgencia (pendientes primero, por fecha de entrega). Fíjate en el flag `hidden: true` y en
   `submission: "not-submitted"`.
3. **Resume con foco en lo accionable.** Encabeza con lo urgente ("Tienes N tareas sin entregar,
   la más próxima vence el ..."). Señala explícitamente las ocultas y las vencidas. No entierres
   la alerta en una lista larga.
4. **Ofrece el siguiente paso**: abrir la tarea (tienes su URL), ver el contenido del curso, o
   descargar los materiales.

## Semestres: cada período es un aula distinta

El aula virtual monta un Moodle **independiente por semestre** (`2025A`, `2025B`, `2026A`…), con
sus propios cursos, tareas y notas. Todas las herramientas del aula aceptan un argumento opcional
`semester`; si lo omites, consultan el **semestre activo**, que es lo correcto para el 99 % de las
preguntas ("¿qué tengo pendiente?", "¿me subieron notas?").

Usa `semester` sólo cuando el usuario pregunte explícitamente por otro período ("¿qué notas saqué
el ciclo pasado?", "las tareas de 2025B"):

- `dutic_semester_list` — qué períodos hay, cuál está activo y cuáles tienen sesión iniciada.
  Consúltala ANTES de pasar un `semester` que no te hayan dicho literalmente; no inventes el id.
- `dutic_semester_current` — sobre qué período estás trabajando ahora.
- `dutic_semester_use` — cambia el activo de forma **persistente**. Para una consulta puntual
  NO lo uses: pasa `semester` en la herramienta concreta y deja el activo donde estaba.
- `dutic_semester_discover` — sondea el aula para averiguar qué períodos existen. Útil si el
  usuario menciona un ciclo que no aparece en la lista.

Si una consulta a otro semestre devuelve `hasSession: false`, no insistas: dile al usuario que
ejecute `dutic login` en una terminal **después** de cambiar a ese período (la sesión es por
semestre, entrar a uno no da acceso a los demás).

## Herramientas del MCP `dutic`

Si el servidor MCP `dutic` está disponible, usa estas herramientas (son la fuente de verdad).
Todas las del aula virtual admiten además `semester` (ver arriba):

- `dutic_list_tasks` — args: `scope` (`"upcoming"` = timeline rápido | `"all"` = barrido con
  ocultas), `onlyHidden` (bool), `detailed` (bool, scrapea estado de entrega/nota; por defecto
  true). **Para "¿qué tengo pendiente?" usa `scope: "all"`.**
- `dutic_list_courses` — cursos matriculados (id, nombre, docentes).
- `dutic_get_course_tasks` — args: `courseId`. Tareas de un curso concreto, incluidas ocultas.
- `dutic_get_course_contents` — args: `courseId`. Secciones y módulos del curso.
- `dutic_list_course_files` — args: `courseId`. Recursos descargables (con su URL).
- `dutic_download_file` — args: `url`, `destPath`. Descarga un archivo a disco.
- `dutic_read_resource` — args: `url`, `maxChars`. **Descarga un recurso y te devuelve su CONTENIDO
  como texto/Markdown** (convierte PDFs automáticamente). Úsalo cuando el usuario quiera que
  analices, resumas o extraigas algo de un material (sílabo, informe, lectura, guía): así lees el
  texto directamente sin gastar tokens en el binario. Acepta URL de módulo o de pluginfile.php.
- `dutic_get_assignment_detail` — args: `cmid`. **Todo sobre una tarea**: consigna completa,
  adjuntos de la consigna (guías/rúbricas, legibles con `dutic_read_resource`), fechas oficiales de
  apertura y cierre, estado de entrega, nota y quién calificó. Incluye `dateConflict` y
  `datesInDescription` (ver abajo). Úsalo cuando pregunte qué pide una tarea o cuándo se entrega.
- `dutic_check_changes` — args: `save?`. **Novedades**: compara con la última revisión y devuelve lo
  nuevo/cambiado — tareas nuevas (incl. ocultas), notas publicadas o modificadas, cambios de entrega y
  de fecha. Úsalo para "¿hay algo nuevo?" o un chequeo periódico. Usa datos frescos (ignora la caché).
- `dutic_whoami` — tu propio perfil (nombre, correo, id).
- `dutic_get_sisacad_grades` — notas parciales OFICIALES de **SISACAD** (sistema aparte con CAPTCHA),
  agrupadas por curso con cada ítem (parcial, nota, peso %, ausente) y `weightedAverageSoFar` (promedio
  ponderado ya calculado con lo calificado hasta ahora). Sólo LEE lo que el usuario ya capturó con el
  comando `dutic sisacad` (él hace su propio login y resuelve el CAPTCHA); no abre navegador ni accede
  a datos de terceros. Si no hay datos, dile que ejecute `dutic sisacad` en una terminal.
- `dutic_compare_grades` — compara el promedio de SISACAD (oficial) con el total que calcula Moodle,
  curso por curso. Útil para detectar si el aula virtual está desincronizada del registro oficial, o
  para avisar cuando Moodle aún no tiene calculado el total de un curso que SISACAD sí.
- `dutic_get_horario` — args: `cui?`, `depe?`, `escuela?`. **Horario de clases** del sistema de
  matrícula del extranet (el mismo login usuario+clave+escuela que la encuesta, sin CAPTCHA). Sin `cui`
  trae el del propio usuario; con `cui`, el de ese alumno (misma escuela por defecto; `depe` para
  otras, p.ej. 470 = ECONOMÍA, o `escuela` por nombre/código, p.ej. BIOLOGÍA). Cada bloque: día, hora
  inicio/fin, asignatura y aula. Requiere credenciales guardadas con `dutic hrs login`; si faltan,
  avisa en vez de fallar. Úsalo para "¿cuándo tengo X?", "¿qué clases tengo el lunes?" o el horario de
  un compañero cuyo CUI conozcas.
- `dutic_get_course_catalog` — args: `depe?`, `escuela?`. **Oferta del ciclo** de una Escuela/Programa
  del sistema de matrícula: todas las secciones de cada asignatura, agrupadas por año. Sin args usa la
  escuela del login; con `escuela` ("BIOLOGÍA") o `depe` consulta otra carrera. Úsalo para "¿qué se
  dicta este ciclo en X?", "¿qué asignaturas tiene BIOLOGÍA?" o para descubrir el código de una
  asignatura (luego va a `dutic_get_subject_schedule`).
- `dutic_get_subject_schedule` — args: `codigo`, `depe?`, `escuela?`. Horario semanal de una
  **asignatura-sección** (p.ej. '2501209A'): días, horas y aulas. El código pelado ('2501209') se
  resuelve contra la oferta; si hay varias secciones, hay que pasar el código completo.
- `dutic_get_aula_schedule` — args: `aula`, `depe?`, `escuela?`. Qué asignaturas (y secciones) se
  dictan en un **aula** y cuándo. Acepta código interno ('15446') o parte del nombre ('105', 'MTA_A')
  sin distinguir acentos; si coincide con varias aulas, avisa para ser más específico.
- `dutic_get_grades` — args: `courseId?`. **Calificaciones**: sin `courseId`, resumen de todos los
  cursos (nota total + cuántos ítems por calificar); con `courseId`, detalle por ítem (nota, rango, %).
  Úsalo cuando el usuario pregunte por sus notas, promedio, o cómo va.
- `dutic_list_participants` — args: `courseId`, `withEmail?`. **Todos** los compañeros del curso
  (recorre la paginación completa): nombre, rol, grupo, último acceso y, con `withEmail`, su correo.
  Con grupos separados Moodle sólo muestra los del grupo del usuario: es normal.
- `dutic_find_person` — args: `query`. Busca a alguien por nombre o **correo** y abre su perfil.
  Devuelve su correo, último acceso y **TODOS sus cursos reales** (course id + grupo, GA = Grupo A);
  cada curso trae `shared` = si TÚ llevas exactamente ese curso (comparado por **course id exacto**,
  nunca confunde tu sección con la suya). `sharedCount` = cuántos comparten. Úsalo para "¿quién es
  X?", "¿qué cursos lleva X?", "¿en qué coincido con X y en qué grupo?" o "dame el correo de X".
- `dutic_get_person_profile` — args: `userId`, `courseId?`. Perfil de CUALQUIER id que ya conozcas
  (también **docentes**): nombre, correo, **rol** ("Estudiante"/"Profesor" — así confirmas si alguien
  es docente), fecha absoluta de último acceso y TODOS sus cursos con id y grupo. Sin `courseId`,
  prueba automáticamente tus propios cursos hasta encontrar uno compartido — no hace falta que lo
  busques a mano. Requiere un userId que ya tengas (de `dutic_find_person`, de quién calificó una
  tarea, o de una URL que el usuario te pase) — no sirve, ni debe usarse, para enumerar ids al azar
  y armar un directorio de terceros: eso es scraping masivo y está fuera de lo que esta skill hace.
- `dutic_fetch_page` — args: `url`, `format` (`text`|`html`|`links`), `maxChars`. **Explora
  cualquier página del aula por URL** con la sesión activa — cambia ids, mira páginas sin botón
  directo (perfiles, foros, calificadores…), siempre sobre un id concreto que ya tengas, nunca
  recorriendo rangos. Restringida al host del aula.
- `dutic_get_course_teachers` — args: `courseId`. Docentes del curso. En esta aula los profesores no
  salen en participantes, así que se deducen de los contactos y de **quién calificó** las tareas.
- `dutic_list_course_materials` — args: `courseId`, `section?`. Lista TODOS los archivos del curso
  **expandiendo las carpetas** a sus archivos reales, con su **sección (unidad)**. Con `section`
  filtras a una unidad concreta.
- `dutic_study_course` — args: `courseId`, `destDir`, `section?`. **Descarga materiales y convierte los
  PDFs a Markdown** organizados por carpeta, para estudiar offline. Con `section` bajas **sólo una
  unidad** — no descargues todo de golpe si el usuario quiere estudiar una unidad concreta.
- `dutic_pull_course_files` — args: `courseId`, `destDir`. Descarga en bloque (expande carpetas).
- `dutic_pdf_to_markdown` — args: `filePath`, `outPath?`, `maxChars`. Convierte un PDF que ya está
  en disco a Markdown (sin sesión). Útil tras descargar, o para PDFs locales del usuario.
- `dutic_session_status` / `dutic_refresh_session` — estado y renovación de sesión.
- `dutic_encuesta_status` — estado de la **encuesta de desempeño docente** (sistema aparte, en el
  extranet): credenciales, política guardada, cuántas quedan por llenar y qué se envió ya. Empieza
  por aquí siempre que el usuario hable de la encuesta docente.
- `dutic_encuesta_list` — las encuestas del usuario con su `key`, docente, curso y estado.
- `dutic_encuesta_preview` — args: `key`, `answers?`, `escala?`, `calificacion?`. Descarga el
  cuestionario y **simula** las respuestas. NO envía. Úsala siempre antes de enviar.
- `dutic_encuesta_submit` — args: `key`, `answers?`, `confirm:"ENVIAR"`. **ENVÍA una encuesta.
  IRREVERSIBLE.** Modo evaluación real, docente por docente.
- `dutic_encuesta_fill_all` — args: `dryRun`, `confirm?`, `escala?`, `calificacion?`. Modo **zero
  touch**: todas las pendientes con la política guardada. Simula salvo `dryRun:false`.

### Analizar materiales sin gastar tokens

Cuando el usuario pida "analiza/resume/qué dice este material/PDF del curso", **no descargues el
binario y lo pases crudo** (desperdicia tokens y no es legible). Usa `dutic_read_resource` con la
URL del recurso: te devuelve texto limpio en Markdown que puedes leer y razonar directamente. Para
PDFs ya descargados o del sistema de archivos del usuario, usa `dutic_pdf_to_markdown`. Las **carpetas**
(mod/folder) se expanden solas a sus archivos; muchas están vacías (el profe creó la estructura sin subir
nada) — eso es normal, no es un error.

### Estudiar por unidad (no bajar todo de golpe)

Cuando el usuario quiera estudiar "la unidad 2" o "el tema de X", sé selectivo en vez de descargar el
curso entero:

1. Llama a `dutic_list_course_materials` (sin filtro) para ver las **secciones/unidades** del curso.
2. Si no está claro cómo se divide el temario, busca un material cuyo nombre contenga "sílabo"/"silabus"
   y léelo con `dutic_read_resource`: el sílabo trae el temario dividido en unidades (típicamente 3) con
   los temas de cada una. Con eso mapeas qué secciones corresponden a qué unidad.
3. Descarga **sólo** esa unidad con `dutic_study_course(..., section: "<nombre o nº de la sección>")`.
   El filtro `section` compara por subcadena ignorando acentos, así que "tema 2", "Unidad II" o "semana 5"
   funcionan según cómo el profe haya nombrado las secciones.

Así preparas justo lo que el usuario va a estudiar, sin descargar (ni convertir) material de más.

## CLI `dutic` (alternativa / uso directo del usuario)

Si no hay MCP pero sí el CLI instalado, o el usuario prefiere la terminal:

```
dutic tasks                 # tareas próximas del timeline (rápido)
dutic tasks --all           # + barrido de cursos → incluye OCULTAS (usa esto para "pendientes")
dutic tasks --hidden        # sólo las ocultas
dutic tasks --all --fast    # sin scrapear estado de entrega (más rápido, menos detalle)
dutic watch                 # novedades desde la última revisión (tareas/notas nuevas)
dutic whoami                # tu propio perfil
dutic grades                # resumen de notas de todos los cursos
dutic grades <id>           # detalle de notas de un curso
dutic task <cmid>           # detalle de una tarea: consigna, fechas, adjuntos, conflictos
dutic people <id>           # todos los compañeros del curso, con su correo (--no-email para omitir)
dutic person <texto>        # busca por nombre/correo: correo + sus cursos reales y cuáles contigo
dutic profile <userId> [--course <id>]  # perfil de cualquier id (docentes incluidos)
dutic fetch <url> [--format text|html|links]  # explora cualquier página del aula por URL
dutic teachers <id>         # docentes del curso
dutic courses               # cursos matriculados
dutic course tasks <id>     # tareas de un curso
dutic course files <id>     # recursos de un curso
dutic materials <id> [--section "Tema 2"]   # archivos del curso, agrupados por unidad
dutic study <id> [--section "Tema 2"]        # baja + convierte a Markdown (por unidad)
dutic read <url>            # lee un recurso (PDF→Markdown) para analizarlo sin gastar tokens
dutic md <archivo.pdf>      # convierte un PDF local a Markdown
dutic pull <id> --dest ./x  # descarga todos los recursos de un curso
dutic status                # estado de sesión
dutic login                 # reautenticación (abre navegador; sólo el usuario puede completarla)

dutic encuesta              # estado de la encuesta docente (pendientes, política, envíos)
dutic encuesta login        # guarda y verifica usuario/clave de la encuesta (clave sin eco)
dutic encuesta list         # encuestas pendientes y ya llenadas, con su key
dutic encuesta show <doc>   # cuestionario + respuestas que se aplicarían (no envía)
dutic encuesta policy set --escala Siempre --calificacion 18   # política por defecto
dutic encuesta fill --todas # SIMULA el llenado de todas (no envía nada)
dutic encuesta fill --todas --enviar --si-es-irreversible      # envía de verdad

dutic hrs                   # tu horario de clases (sistema de matrícula del extranet)
dutic hrs <CUI>             # horario de ese alumno (misma escuela)
dutic hrs login             # guarda y verifica usuario/clave/escuela (clave sin eco)
dutic hrs show              # último horario descargado, sin consultar el sistema
dutic hrs status            # credenciales guardadas y caché
dutic hrs courses           # oferta del ciclo (todas las secciones, por año)
dutic hrs courses 2501209A  # horario semanal de esa asignatura-sección
dutic hrs aulas             # aulas de la escuela (código y nombre)
dutic hrs aulas 105         # qué se dicta en ese aula (código o parte del nombre)
```

## Fechas contradictorias: la trampa que hay que vigilar

La fecha real de una entrega no siempre es la que Moodle tiene configurada. A veces el docente
escribe **otra fecha dentro del texto de la consigna** ("entregar hasta el 12 de julio"), y el
estudiante se guía por una mientras el sistema cierra en la otra.

`dutic_get_assignment_detail` devuelve `closeDate` (la oficial), `datesInDescription` (las que
aparecen escritas en la consigna) y `dateConflict: true` cuando difieren en más de un día. **Si
`dateConflict` es true, avísalo de forma destacada** y recomienda confirmar con el docente: es
justo el escenario que cuesta notas. (Las fechas de subida de los archivos adjuntos ya se excluyen,
así que no hay falsas alarmas.)

Cuando el usuario pregunte "¿qué tengo que hacer en esta tarea?", da la consigna **y** revisa si
hay adjuntos: suelen traer la guía o rúbrica con los criterios reales de calificación, y puedes
leerlos con `dutic_read_resource`.

## Interpretar los datos de una tarea

Cada tarea trae: `name`, `courseName`, `dueDate` (epoch s, o null si no tiene fecha), `hidden`
(true = no aparece en el timeline del estudiante), `submission` (`not-submitted` | `submitted` |
`graded` | `unknown`), `grade`, `timeRemaining` (texto de Moodle, p. ej. "retrasada por 8 días"),
`url`.

Lo que importa señalar al usuario, en orden:
1. `submission: "not-submitted"` con `dueDate` cercano o pasado → **alerta máxima**.
2. `hidden: true` + `not-submitted` → tarea que probablemente no sabía que existía.
3. `timeRemaining` que diga "retrasada"/"vencida" → ya se pasó la fecha.

## Explorar por URL (ver más de lo que muestra la interfaz)

DUTIC expone por URL más de lo que se ve navegando con botones. Aprovéchalo con `dutic_fetch_page`
y los perfiles:

- El **perfil de una persona** (`dutic_find_person` / `dutic_get_person_profile`) lista TODOS sus
  cursos con su course id — incluidos cursos en los que TÚ no estás matriculado. Así puedes ver el
  "horario" completo de un compañero o descubrir cursos/secciones que no aparecen en tu navegación.
- Para **docentes**: no salen en las listas de participantes, pero con su `userId` (ya conocido —
  de una tarea calificada, un link que el usuario te pase, etc.) `dutic_get_person_profile` revela
  sus cursos, correo y **rol** ("Profesor" confirma que es docente), **sin necesitar `courseId`**:
  prueba solo los cursos propios del usuario hasta encontrar uno compartido.
- `dutic_fetch_page` con `format:"links"` lista los enlaces internos de una página para saber a
  dónde navegar a continuación, sobre un id concreto que ya tienes.

**Límite claro — no negociable:** estas herramientas resuelven UN id a la vez, dado por una vía
legítima (algo que el usuario ya vio, o un dato que tú descubriste dentro de sus propios cursos).
NUNCA recorras un rango de ids ("probar 13260, 13261, 13262…") para construir un directorio de
docentes/estudiantes de la facultad — eso es scraping masivo de datos personales de terceros sin
su consentimiento, y está fuera de lo que este servidor hace, sin importar cuánto "ahorre trabajo".
Si el usuario lo pide, explícale esto igual que se explica aquí y ofrece la alternativa: resolver
personas puntuales que ya conoce (por nombre, correo, o un id que él mismo te dé).

## Encuesta de desempeño docente (`dutic encuesta`)

Cada semestre hay que llenar la encuesta de evaluación docente en el **extranet**
(`extranet.unsa.edu.pe/encuesta2`), un sistema aparte del aula virtual y de SISACAD: **21 preguntas
por cada docente**. Es el trámite más tedioso del ciclo y por eso existe esta integración.

A diferencia de SISACAD, **no tiene CAPTCHA**: el login es usuario + clave de matrícula, así que el
MCP puede operarlo entero sin navegador.

**Lo único que de verdad importa: el envío es IRREVERSIBLE y sólo se puede hacer una vez por
docente.** No se puede corregir ni volver a ver lo enviado. Por eso:

1. Empieza por `dutic_encuesta_status` y `dutic_encuesta_list`.
2. **Siempre** `dutic_encuesta_preview` antes de enviar, y enséñale al usuario lo que saldría.
3. Sólo entonces `dutic_encuesta_submit` con `confirm:"ENVIAR"`.

### Las respuestas son del usuario, no tuyas

Estás evaluando a personas reales y eso tiene consecuencias para ellas. **Nunca inventes una
valoración.** Las respuestas tienen que venir de lo que el usuario te diga, o de la política que él
mismo configuró. Si te pide "llena las encuestas" sin más y no hay política guardada, la
herramienta se niega a completar (no hay valor por defecto escondido en el código): pregúntale qué
quiere poner. Basta con una frase — "a todos 4 y 18, salvo Quenaya que le pongo 3 y un 14" — y con
eso ya puedes resolver las 21 preguntas de cada uno.

Los dos modos, según lo que pida el usuario:

- **Evaluación real, docente por docente:** `preview` → le lees las preguntas y acuerdan las
  respuestas → `submit` con `answers` explícitos. Es el modo correcto cuando el usuario tiene
  opiniones distintas por profesor.
- **Zero touch:** `dutic_encuesta_fill_all` aplica su política guardada a todas las pendientes.
  Simula por defecto; enviar exige `dryRun:false` **y** `confirm:"ENVIAR"`, y afecta a todos los
  docentes a la vez — enséñale el plan antes.

### La escala y una trampa del sistema

Escala de las 20 primeras preguntas: `1 Nunca · 2 A veces · 3 Usualmente · 4 Siempre`. La 21 es una
calificación libre de 0 a 20.

En el HTML del sistema los ids de alternativa van en orden **descendente** respecto a la escala
(`731=Nunca … 728=Siempre`): la mejor respuesta tiene el id más bajo. La herramienta resuelve la
alternativa casando la **etiqueta de texto**, nunca la posición, y verifica esa correspondencia otra
vez justo antes de enviar. No intentes construir ids a mano ni "optimizar" ese camino.

### Política de respuestas

Vive en `~/.dutic/encuesta.json` (permisos 600, junto a las credenciales). Precedencia, de más
específica a menos: respuesta explícita de la llamada → pregunta del docente → pregunta del curso →
pregunta global → docente → curso → global. Se edita a mano o con `dutic encuesta policy set`.

Cada envío queda registrado en `~/.dutic/encuesta-log.json`, que es la única prueba de lo enviado
porque el sistema no da acuse de recibo. Si un envío sale `unknown`, **no lo reintentes**: dile al
usuario que lo compruebe en la web.

## Horario de clases (`dutic hrs`)

El horario vive en el **sistema de matrícula** del extranet (`extranet.unsa.edu.pe/sisacad`), un
sistema aparte del aula virtual y de SISACAD de notas: login usuario + clave + Escuela/Programa
**sin CAPTCHA** (las mismas credenciales de matrícula que la encuesta, pero se guardan aparte).
Una vez con `dutic hrs login` hecho, `dutic hrs` muestra el horario del usuario y `dutic hrs <CUI>`
el de ese alumno (la URL del sistema acepta cambiar el `codi_usua`).

- Cada bloque trae día, hora de inicio/fin, asignatura y aula; las clases largas (varias horas
  seguidas) vienen como un solo bloque con la franja inicial.
- Para otra Escuela/Programa hay que pasar `--escuela` por nombre ("BIOLOGÍA") o código ("4020"), o
  `--depe` con su código de dependencia (la depe se deriva del código de escuela dividiendo por 10:
  4700→470, 4020→402). El sistema acepta consultar el horario de CUALQUIER escuela.
- `dutic hrs courses` lista la **oferta del ciclo** de una escuela (asignaturas con todas sus
  secciones, por año); `dutic hrs courses <codigo>` el horario de una asignatura-sección (el código
  pelado se resuelve; si hay varias secciones pide el código completo, p.ej. 2501209A).
- `dutic hrs aulas` lista las aulas de la escuela; `dutic hrs aulas <aula>` qué se dicta en una
  (por código interno o parte del nombre, sin acentos; si coincide con varias, avisa).
- El login responde el mensaje oficial si las credenciales son inválidas ("Cuenta NO ES Valida"),
  y la escuela se puede dar por nombre ("ECONOMÍA") o por código ("4700").
- Es una consulta a un dato académico público del propio estudiante por su CUI; úsalo con un CUI
  que el usuario ya conozca, no para recorrer rangos.
- **No abrir `alumno/datos.php` del sistema de matrícula con CUIs ajenos**: el menú "Datos
  Personales" es un formulario de edición que acepta cualquier `cui` (verificado: 200 con datos de
  otro alumno y sin ninguno inexistente), es decir, control de acceso roto. Hoy los campos
  sensibles (DNI, dirección, teléfono, colegio) están vacíos para todos, así que no hay fuga real
  de PII; el riesgo serio es el de ESCRITURA (`datos_guardar.php`): alterar el registro de otro
  estudiante. No probar la escritura (modifica datos reales) y no consultar la página de otros —
  se reporta a la UNSA, no se explota. El horario y la oferta académica sí son datos académicos
  legítimos.

## Piloto de notificaciones por WhatsApp (`dutic saas enroll` / `dutic saas push`)

Experimento opt-in, separado del resto: avisa por WhatsApp cuando `dutic watch` detecta tareas o
notas nuevas. Reglas que no cambian aunque se pida "hazlo más rápido" o "inscribe también a...":

- **Sólo se enrola quien ejecuta `dutic saas enroll` él mismo.** Nunca inscribas, sincronices ni
  empujes datos de otro estudiante en su nombre, aunque conozcas su `unsaUserId`.
- **El scraping de Moodle nunca sale de esta máquina.** `dutic saas push` sólo envía el *resultado*
  ya calculado por `checkChanges` (tareas/notas nuevas) — nunca `MoodleSession` ni `sesskey`. No
  existe (ni debe existir) una versión de este flujo que centralice el login OAuth de terceros.
- `students` / `pending_notifications` en Supabase existen sólo para avisar al dueño de esa fila —
  no son una fuente para "ver qué está haciendo fulano" ni para listar/exportar datos de otros.
- La mensajería usa números de WhatsApp **dedicados al piloto**, nunca el número personal de un
  estudiante — si se propone lo contrario (cada estudiante conectando su propio WhatsApp como
  dispositivo vinculado), señala el riesgo: expondría su número personal a un baneo de Meta.

### Revisión automática (`dutic auto`)

`dutic saas enroll` deja registrada una tarea programada que corre `dutic auto run` cada 3 h. Reglas
si te toca tocar esto:

- **No propongas un daemon residente.** Se descartó a propósito: un proceso Node vivo 24/7 gasta
  ~60-100 MB de RAM en la laptop del estudiante y es el patrón que marcan los antivirus. El
  Programador de tareas ya hace de scheduler con consumo cero en reposo.
- **El camino de fondo es `mode: "headless-only"`, sin excepción.** Con el modo por defecto
  (`"interactive"`) una sesión caducada abriría una ventana de Chrome sola en la pantalla del
  estudiante, lanzada por una tarea invisible. Si la renovación silenciosa falla, se avisa por
  WhatsApp (`pushNotice(..., "session_expired")`); nunca se abre un navegador.
- **No subas la frecuencia sin pensarlo.** Cada pasada es un barrido completo de cursos y notas
  contra los servidores de la UNSA. El intervalo conservador y el retraso aleatorio están para no
  provocar una estampida si el piloto crece.

## "Último acceso" — el más reciente, no el más antiguo

El "último acceso" es POR CURSO y varía. `dutic_find_person` reporta el **más reciente** de todos
los cursos compartidos (`lastAccess` + `lastSeenAgoSeconds`) y también el acceso por curso, así
sabes cuándo se conectó realmente la persona por última vez.

## Rendimiento (caché)

Las operaciones de personas/cursos se **cachean en disco** (`~/.dutic/cache/`), así que repetir
`person`, `people`, `grades` o `tasks` es casi instantáneo (p. ej. `people` de 54 alumnos: ~10 s la
primera vez, &lt;1 s después). Los datos cambian poco (roster, correos, cursos). Si necesitas datos
100% frescos —una nota recién puesta, una tarea nueva—, añade `--refresh` al comando del CLI, o dile
al usuario que ejecute `dutic cache clear`. TTLs: cursos/perfiles 12 h, participantes 6 h, estado de
curso 1 h, notas 20 min.

## Notas de contexto

- El semestre (p. ej. `2026A`) va en la URL del aula y cambia cada período. Se auto-detecta tras
  el login y se recuerda, así que en el uso normal no hay que gestionarlo; sólo importa cuando el
  usuario pregunta por un ciclo anterior (ver "Semestres" arriba).
- Los datos de cada período están **aislados** en disco: sesión, cursos, notas, horario y caché.
  Cambiar de semestre no borra nada del anterior, y volver a él lo encuentra tal cual estaba.
- Algunos cursos aparecen **duplicados** con nombres casi iguales (uno con acentos, otro sin):
  es un error de registro de la OTI (la oficina de TI de la UNSA), no un fallo de la herramienta.
  Trátalos como el mismo curso; no alarmes al usuario por ello.
- Las tareas ocultas suelen salir "sin fecha" porque efectivamente no tienen fecha de entrega en
  Moodle (por eso no generan evento de calendario). El `submission` te dice igual si ya cumplió.
