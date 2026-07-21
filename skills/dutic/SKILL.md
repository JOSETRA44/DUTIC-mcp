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

## Herramientas del MCP `dutic`

Si el servidor MCP `dutic` está disponible, usa estas herramientas (son la fuente de verdad):

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
- `dutic_get_grades` — args: `courseId?`. **Calificaciones**: sin `courseId`, resumen de todos los
  cursos (nota total + cuántos ítems por calificar); con `courseId`, detalle por ítem (nota, rango, %).
  Úsalo cuando el usuario pregunte por sus notas, promedio, o cómo va.
- `dutic_list_participants` — args: `courseId`, `withEmail?`. **Todos** los compañeros del curso
  (recorre la paginación completa): nombre, rol, grupo, último acceso y, con `withEmail`, su correo.
  Con grupos separados Moodle sólo muestra los del grupo del usuario: es normal.
- `dutic_find_person` — args: `query`. Busca a alguien en TODOS sus cursos por nombre o **por
  correo**. Devuelve su correo, último acceso y **todos los cursos que comparte contigo** (con el
  grupo de cada uno) más los que Moodle lista en su perfil. Úsalo para "¿quién es X?", "¿en qué
  cursos llevo con X?" o "dame el correo de X".
- `dutic_get_person_profile` — args: `userId`, `courseId?`. Correo, zona horaria y cursos compartidos.
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
dutic grades                # resumen de notas de todos los cursos
dutic grades <id>           # detalle de notas de un curso
dutic task <cmid>           # detalle de una tarea: consigna, fechas, adjuntos, conflictos
dutic people <id>           # todos los compañeros del curso, con su correo (--no-email para omitir)
dutic person <texto>        # busca por nombre/correo: da su correo y TODOS los cursos contigo
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

## Notas de contexto

- El semestre (p. ej. `2026A`) va en la URL del aula y cambia cada período; el sistema lo
  auto-detecta tras el login, no necesitas gestionarlo.
- Algunos cursos aparecen **duplicados** con nombres casi iguales (uno con acentos, otro sin):
  es un error de registro de la OTI (la oficina de TI de la UNSA), no un fallo de la herramienta.
  Trátalos como el mismo curso; no alarmes al usuario por ello.
- Las tareas ocultas suelen salir "sin fecha" porque efectivamente no tienen fecha de entrega en
  Moodle (por eso no generan evento de calendario). El `submission` te dice igual si ya cumplió.
