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
- `dutic_list_course_materials` — args: `courseId`. Lista TODOS los archivos del curso **expandiendo
  las carpetas** (diapositivas, lecturas, prácticas) a sus archivos reales con URL directa.
- `dutic_study_course` — args: `courseId`, `destDir`. **Descarga todos los materiales y convierte los
  PDFs a Markdown** organizados por carpeta, para estudiar/analizar offline. Úsalo cuando el usuario
  quiera "preparar/bajar el material para estudiar" de un curso.
- `dutic_pull_course_files` — args: `courseId`, `destDir`. Descarga en bloque (expande carpetas).
- `dutic_pdf_to_markdown` — args: `filePath`, `outPath?`, `maxChars`. Convierte un PDF que ya está
  en disco a Markdown (sin sesión). Útil tras descargar, o para PDFs locales del usuario.
- `dutic_session_status` / `dutic_refresh_session` — estado y renovación de sesión.

### Analizar materiales sin gastar tokens

Cuando el usuario pida "analiza/resume/qué dice este material/PDF del curso", **no descargues el
binario y lo pases crudo** (desperdicia tokens y no es legible). Usa `dutic_read_resource` con la
URL del recurso: te devuelve texto limpio en Markdown que puedes leer y razonar directamente. Para
PDFs ya descargados o del sistema de archivos del usuario, usa `dutic_pdf_to_markdown`. Para preparar
todo un curso de golpe (bajar y convertir sus PDFs para estudiar), usa `dutic_study_course`. Las
**carpetas** (mod/folder) se expanden solas a sus archivos; muchas están vacías (el profe creó la
estructura sin subir nada todavía) — eso es normal, no es un error.

## CLI `dutic` (alternativa / uso directo del usuario)

Si no hay MCP pero sí el CLI instalado, o el usuario prefiere la terminal:

```
dutic tasks                 # tareas próximas del timeline (rápido)
dutic tasks --all           # + barrido de cursos → incluye OCULTAS (usa esto para "pendientes")
dutic tasks --hidden        # sólo las ocultas
dutic tasks --all --fast    # sin scrapear estado de entrega (más rápido, menos detalle)
dutic courses               # cursos matriculados
dutic course tasks <id>     # tareas de un curso
dutic course files <id>     # recursos de un curso
dutic materials <id>        # lista todos los archivos del curso (expande carpetas)
dutic study <id> --dest ./x # baja los materiales y convierte PDFs a Markdown para estudiar
dutic read <url>            # lee un recurso (PDF→Markdown) para analizarlo sin gastar tokens
dutic md <archivo.pdf>      # convierte un PDF local a Markdown
dutic pull <id> --dest ./x  # descarga todos los recursos de un curso
dutic status                # estado de sesión
dutic login                 # reautenticación (abre navegador; sólo el usuario puede completarla)
```

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
