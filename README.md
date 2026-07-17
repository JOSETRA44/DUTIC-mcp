# dutic-mcp

Servidor **MCP** + herramienta de **consola** para el aula virtual **DUTIC** (Moodle) de la UNSA.
Deja que tú —desde la terminal— y agentes como Claude vean **tareas (incluidas las ocultas)**, **cursos**
y **recursos**, y descarguen archivos.

## Por qué existe

La app móvil previa sólo leía el **calendario** de Moodle, así que las tareas que un profesor crea sin
publicar evento de calendario **quedaban invisibles** → entregas perdidas. Esta herramienta, además del
calendario, **barre cada curso** (`core_course_get_contents`) para encontrar esas tareas ocultas y las
marca con `hidden: true`.

## Cómo funciona

Igual que la app: no usa la API pública de web services, sino que **captura la cookie `MoodleSession` y el
token `sesskey`** tras un login de **Google OAuth institucional**, y con ellos llama al endpoint AJAX
interno de Moodle (`lib/ajax/service.php`). El login se hace con **Playwright manejando tu Google Chrome
instalado** (no descarga Chromium). El perfil del navegador es persistente, así que el SSO de Google se
mantiene vivo y renovar la sesión (que Moodle caduca a las ~6-8h) normalmente es automático.

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

Herramientas expuestas: `dutic_list_tasks` (scope `upcoming`/`all`, `onlyHidden`), `dutic_list_courses`,
`dutic_get_course_contents`, `dutic_get_course_tasks`, `dutic_list_course_files`, `dutic_download_file`,
`dutic_session_status`, `dutic_refresh_session`.

> El MCP renueva la sesión de forma **headless** si el SSO de Google sigue vivo. Si caducó del todo,
> devuelve un aviso para que corras `dutic login` en una terminal (ahí sí puede abrirse el navegador).

## Notas de seguridad

- La sesión (`~/.dutic/session.json`) y el perfil del navegador contienen credenciales de tu cuenta: no se
  versionan (`.gitignore`) y el archivo de sesión se crea con permisos restrictivos.
- El certificado de `aulavirtual.unsa.edu.pe` (CA privada UNSA) se acepta **sólo para ese host**.
