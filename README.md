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
npm install -g @joswetra/dutic-mcp
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

---

## Uso — CLI

| Comando | Qué hace |
|---|---|
| `dutic tasks` | Tareas próximas del timeline (rápido) |
| `dutic tasks --all` | **+ barrido de cursos → incluye las ocultas** |
| `dutic tasks --hidden` | Sólo las ocultas |
| `dutic task <cmid>` | Detalle: consigna, fechas, adjuntos, conflicto de fechas |
| `dutic grades [id]` | Notas: resumen de todos los cursos, o detalle de uno |
| `dutic courses` | Cursos matriculados |
| `dutic materials <id> [--section "Tema 2"]` | Archivos del curso, por unidad |
| `dutic study <id> [--section "Tema 2"]` | Baja materiales y convierte PDFs a Markdown |
| `dutic read <url>` | Lee un recurso (PDF→Markdown) para analizarlo |
| `dutic md <archivo.pdf>` | Convierte un PDF local a Markdown |
| `dutic people <id> [--email]` | Compañeros del curso (con correo) |
| `dutic person <texto>` | Busca a alguien por nombre o correo |
| `dutic teachers <id>` | Docentes del curso |
| `dutic pull <id>` | Descarga todos los materiales |
| `dutic setup` / `dutic login` / `dutic status` | Configuración y sesión |

Añade `--json` a la mayoría de comandos para salida estructurada.

### Ejemplos

```bash
# ¿Qué me falta entregar?
dutic tasks --all

# Preparar sólo la unidad que voy a estudiar
dutic study 2279 --section "Tema 2" --dest ./materiales

# ¿Qué pide exactamente esta tarea?
dutic task 385686

# El correo de mi compañero de grupo
dutic person "Piero"
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

**19 herramientas**: tareas (`dutic_list_tasks`, `dutic_get_assignment_detail`, …), notas
(`dutic_get_grades`), materiales (`dutic_list_course_materials`, `dutic_study_course`,
`dutic_read_resource`, `dutic_pdf_to_markdown`), personas (`dutic_list_participants`,
`dutic_find_person`, `dutic_get_course_teachers`) y sesión.

---

## Configuración

| Variable | Para qué | Por defecto |
|---|---|---|
| `DUTIC_SEMESTER` | Semestre en la URL del aula (`2026A`, `2026B`…) | `2026A` |
| `DUTIC_BROWSER_CHANNEL` | Navegador para el login: `chrome`, `msedge`, `chromium` | `chrome` |
| `DUTIC_DATA_DIR` | Dónde guardar sesión y perfil | `~/.dutic` |

El semestre sólo se usa para la URL de login: tras iniciar sesión **se auto-detecta** del propio
aula, así que al cambiar de período normalmente no hay que tocar nada.

---

## Cómo funciona

No usa la API pública de web services (la UNSA la tiene bloqueada). Captura la cookie
`MoodleSession` y el token `sesskey` tras el login de Google (Playwright manejando tu Chrome) y con
ellos llama al endpoint AJAX interno de Moodle, complementado con scraping donde hace falta.

| Necesidad | Fuente | Estado |
|---|---|---|
| Descubrir todas las tareas | `core_courseformat_get_state` | ✅ |
| Cursos matriculados | `core_course_get_enrolled_courses_by_timeline_classification` | ✅ |
| Timeline y fechas | `core_calendar_get_action_events_by_timesort` | ✅ (sólo accionables) |
| Estado de entrega, consigna, adjuntos | scraping de `mod/assign/view.php` | ✅ |
| Notas | scraping de `grade/report/user/index.php` | ✅ |
| Personas y correos | scraping de `user/index.php` y `user/view.php` | ✅ |
| `core_course_get_contents`, `mod_assign_*`, `gradereport_*` | — | ❌ bloqueadas por la UNSA |

**Fechas contradictorias:** algunas consignas mencionan una fecha distinta a la configurada en
Moodle. `dutic task <cmid>` compara ambas y avisa (`dateConflict`) — es la causa típica de entregas
perdidas.

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

## Licencia

MIT © JOSETRA44
