# dutic-mcp

Servidor **MCP** + herramienta de **consola** para el aula virtual **DUTIC** (Moodle) de la UNSA.
Deja que tú —desde la terminal— y agentes como Claude vean **tareas (incluidas las ocultas)**, **cursos**
y **recursos**, y descarguen archivos.

## Por qué existe

La app móvil previa sólo leía el **calendario/timeline** de Moodle, que sólo muestra tareas *accionables*
(futuras y sin entregar). Las tareas sin fecha de calendario, ya vencidas o ya entregadas **quedaban
invisibles** → entregas perdidas. Esta herramienta **barre cada curso** para descubrir todas las tareas,
las marca con `hidden: true` cuando no salían en el timeline, y ordena por urgencia lo pendiente.

## Cómo funciona

No usa la API pública de web services: **captura la cookie `MoodleSession` y el token `sesskey`** tras un
login de **Google OAuth institucional** (Playwright manejando tu Chrome instalado, sin descargar Chromium),
y con ellos llama al endpoint AJAX interno de Moodle (`lib/ajax/service.php`). El perfil del navegador es
persistente, así que el SSO de Google se mantiene y la renovación de sesión suele ser automática.

**Realidad de la API en la UNSA (importante):** los admins **bloquearon** varias funciones AJAX
(`core_course_get_contents`, `mod_assign_get_assignments`) → devuelven "El servicio Web no está disponible".
La ruta que sí funciona y usamos:

| Necesidad | Fuente | Estado |
|---|---|---|
| Descubrir todas las tareas de un curso | `core_courseformat_get_state` (la que usa la propia página de curso; su `data` viene como *string* JSON) | ✅ |
| Cursos matriculados | `core_course_get_enrolled_courses_by_timeline_classification` | ✅ |
| Timeline (marca no-ocultas + fecha exacta) | `core_calendar_get_action_events_by_timesort` | ✅ (sólo accionables) |
| Estado de entrega, nota, tiempo restante | *scraping* de `mod/assign/view.php` con Cheerio | ✅ |

Los eventos de calendario de acción sólo aparecen cuando la tarea está pendiente y futura, por eso el
estado de entrega real se obtiene scrapeando la página de cada tarea.

## Requisitos

- Node.js ≥ 20
- Google Chrome (o Edge) instalado — Playwright lo usa vía `channel`. No hace falta descargar Chromium.

## Instalación

```bash
npm install
npm run build
```

> Si prefieres el Chromium propio de Playwright: `npx playwright install chromium` y luego
> `DUTIC_BROWSER_CHANNEL=chromium`. (Requiere ~184 MB de disco libre.)

## Configuración

- `DUTIC_SEMESTER` — semestre, p.ej. `2026A` (por defecto `2026A`). Cambia cada período; aun así el sitio
  real se auto-detecta tras el login.
- `DUTIC_BROWSER_CHANNEL` — `chrome` (def.), `msedge` o `chromium`.
- `DUTIC_DATA_DIR` — dónde guardar sesión y perfil (por defecto `~/.dutic`).

## Uso — CLI

```bash
# Primer login (abre Chrome, inicias sesión con Google una vez)
dutic login

dutic status                 # estado de la sesión y semestre
dutic tasks                  # tareas próximas (rápido, del calendario)
dutic tasks --all            # + barrido de cursos (incluye ocultas)
dutic tasks --hidden         # SÓLO las tareas ocultas
dutic courses                # cursos matriculados
dutic course tasks <id>      # tareas de un curso (incluye ocultas)
dutic course files <id>      # recursos de un curso
dutic read <url>             # lee un recurso (PDF→Markdown) para analizarlo sin gastar tokens
dutic md <archivo.pdf>       # convierte un PDF local a Markdown
dutic pull <id> --dest ./x   # descarga todos los recursos de un curso
```

En desarrollo, sin compilar: `npm run dev:cli -- tasks --all`.

## Uso — MCP (para Claude)

Compila (`npm run build`) y registra el servidor. En `claude_desktop_config.json` (o el equivalente de tu
cliente MCP):

```json
{
  "mcpServers": {
    "dutic": {
      "command": "node",
      "args": ["C:\\Users\\USER\\source\\MCPs\\dutic-mcp\\dist\\mcp\\server.js"],
      "env": { "DUTIC_SEMESTER": "2026A" }
    }
  }
}
```

En Claude Code: `claude mcp add dutic -- node C:\Users\USER\source\MCPs\dutic-mcp\dist\mcp\server.js`

Herramientas expuestas (11): `dutic_list_tasks` (scope `upcoming`/`all`, `onlyHidden`, `detailed`),
`dutic_list_courses`, `dutic_get_course_contents`, `dutic_get_course_tasks`, `dutic_list_course_files`,
`dutic_download_file`, **`dutic_read_resource`** (recurso → Markdown para analizar sin gastar tokens),
`dutic_pull_course_files`, **`dutic_pdf_to_markdown`** (PDF local → Markdown), `dutic_session_status`,
`dutic_refresh_session`.

### Analizar materiales sin gastar tokens

`dutic_read_resource` / `dutic read <url>` descarga un recurso y devuelve su **contenido como texto
Markdown** (convierte PDFs con `unpdf`, sin dependencias nativas), para que el agente lo analice sin
volcar el binario al contexto. `dutic_pdf_to_markdown` / `dutic md` hace lo mismo con un PDF local.
Limitación: las **carpetas** (mod/folder) de algunos temas de Moodle renderizan su árbol por JS y no
exponen los enlaces; en ese caso usa el enlace directo del archivo o descárgalo y conviértelo con `md`.

> El MCP renueva la sesión de forma **headless** si el SSO de Google sigue vivo. Si caducó del todo,
> devuelve un aviso para que corras `dutic login` en una terminal (ahí sí puede abrirse el navegador).

## Configuración multi-agente (Antigravity, OpenCode, mimocode, Claude Code…)

El servidor MCP funciona con cualquier agente compatible con MCP. Para registrarlo en todos tus agentes
instalados de una vez (preservando su config existente y con backup `*.dutic-bak`):

```bash
npm run setup        # build + instala la skill + configura los agentes
# o por separado:
npm run setup:agents # sólo registra el MCP en los agentes
npm run setup:skill  # sólo copia la skill a los dirs de skills de los agentes
```

Esquemas usados automáticamente: `mcpServers` (Claude Code `~/.claude.json`, Antigravity
`~/.antigravity/config/mcp_config.json`) y `mcp` con `type:"local"` (OpenCode `opencode.jsonc`,
mimocode `mimocode.jsonc`). Reinicia cada agente tras configurarlo.

## Skill `dutic` (instalable con `npx skills`)

El repo incluye una skill en `skills/dutic/` que enseña a los agentes a usar este MCP (buscar tareas
ocultas, priorizar lo pendiente, descargar recursos). Instálala en **todos** tus agentes con el gestor de
skills del ecosistema:

```bash
# Desde una copia local del repo:
npx skills add "C:\Users\USER\source\MCPs\dutic-mcp" -a '*' -s dutic -y

# O, una vez publicado en GitHub:
npx skills add <tu-usuario>/dutic-mcp -a '*' -s dutic -y
```

`-a '*'` instala en todos los agentes detectados. `npx skills list` muestra las instaladas.

## Ordenamiento por urgencia

`dutic tasks --all` ordena por urgencia: las **SIN ENTREGAR** van primero (por fecha de entrega, las
vencidas/próximas arriba), y las entregadas/calificadas al fondo. La cabecera resume cuántas hay pendientes.

## Notas de seguridad

- La sesión (`~/.dutic/session.json`) y el perfil del navegador contienen credenciales de tu cuenta: no se
  versionan (`.gitignore`) y el archivo de sesión se crea con permisos restrictivos.
- El certificado de `aulavirtual.unsa.edu.pe` (CA privada UNSA) se acepta **sólo para ese host**.
