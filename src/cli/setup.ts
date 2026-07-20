import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync as cp,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuración post-instalación: registra el servidor MCP en los agentes instalados y copia la
 * skill a sus directorios. Las rutas se resuelven desde la ubicación del propio paquete, así que
 * funciona igual instalado globalmente (npm i -g) que desde el repo.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** Raíz del paquete: dist/cli/ → ../../ */
const PKG_ROOT = resolve(HERE, "..", "..");
const SERVER_JS = join(PKG_ROOT, "dist", "mcp", "server.js");
const SKILL_SRC = join(PKG_ROOT, "skills", "dutic", "SKILL.md");
const HOME = homedir();

export interface SetupResult {
  label: string;
  status: "ok" | "skip" | "error";
  detail: string;
}

/** Parser tolerante de JSONC: quita comentarios y comas colgantes. */
function parseJsonc(text: string): any {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(noLine.replace(/,(\s*[}\]])/g, "$1"));
}

function backupAndWrite(file: string, obj: unknown): void {
  if (existsSync(file)) {
    const bak = `${file}.dutic-bak`;
    if (!existsSync(bak)) cp(file, bak);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function mcpServersEntry(semester: string) {
  return { command: "node", args: [SERVER_JS], env: { DUTIC_SEMESTER: semester } };
}

function localMcpEntry(semester: string) {
  return {
    type: "local",
    command: ["node", SERVER_JS],
    enabled: true,
    env: { DUTIC_SEMESTER: semester },
  };
}

/** Config con esquema { mcpServers: { dutic: … } } — Claude Code, Antigravity. */
function configureMcpServers(label: string, file: string, semester: string): SetupResult {
  try {
    if (!existsSync(file) && !existsSync(dirname(file))) {
      return { label, status: "skip", detail: "no instalado" };
    }
    const cfg = existsSync(file) ? parseJsonc(readFileSync(file, "utf8")) : {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers.dutic = mcpServersEntry(semester);
    backupAndWrite(file, cfg);
    return { label, status: "ok", detail: file };
  } catch (e) {
    return { label, status: "error", detail: (e as Error).message };
  }
}

/** Config con esquema { mcp: { dutic: { type:"local", … } } } — OpenCode, mimocode. */
function configureLocalMcp(label: string, file: string, semester: string): SetupResult {
  try {
    if (!existsSync(file)) return { label, status: "skip", detail: "no instalado" };
    const cfg = parseJsonc(readFileSync(file, "utf8"));
    cfg.mcp = cfg.mcp ?? {};
    cfg.mcp.dutic = localMcpEntry(semester);
    backupAndWrite(file, cfg);
    return { label, status: "ok", detail: file };
  } catch (e) {
    return { label, status: "error", detail: (e as Error).message };
  }
}

/** Copia la skill al directorio de skills de cada agente que la soporte. */
function installSkill(): SetupResult[] {
  const targets = [
    { label: "Claude Code (skill)", dir: join(HOME, ".claude", "skills", "dutic") },
    { label: "OpenCode (skill)", dir: join(HOME, ".config", "opencode", "skills", "dutic") },
    { label: "mimocode (skill)", dir: join(HOME, ".config", "mimocode", "skills", "dutic") },
  ];
  if (!existsSync(SKILL_SRC)) {
    return [{ label: "skill", status: "error", detail: `no encontrada: ${SKILL_SRC}` }];
  }
  return targets.map(({ label, dir }) => {
    try {
      // Sólo instalar si el agente existe (no crear carpetas de agentes ausentes).
      const agentRoot = resolve(dir, "..", "..");
      if (!existsSync(agentRoot)) return { label, status: "skip" as const, detail: "no instalado" };
      mkdirSync(dir, { recursive: true });
      copyFileSync(SKILL_SRC, join(dir, "SKILL.md"));
      return { label, status: "ok" as const, detail: dir };
    } catch (e) {
      return { label, status: "error" as const, detail: (e as Error).message };
    }
  });
}

/** Ejecuta la configuración completa y devuelve el informe. */
export function runSetup(semester: string): SetupResult[] {
  if (!existsSync(SERVER_JS)) {
    return [
      {
        label: "build",
        status: "error",
        detail: `No existe ${SERVER_JS}. Ejecuta \`npm run build\`.`,
      },
    ];
  }
  return [
    configureMcpServers("Claude Code (MCP)", join(HOME, ".claude.json"), semester),
    configureMcpServers(
      "Antigravity (MCP)",
      join(HOME, ".antigravity", "config", "mcp_config.json"),
      semester,
    ),
    configureLocalMcp(
      "OpenCode (MCP)",
      join(HOME, ".config", "opencode", "opencode.jsonc"),
      semester,
    ),
    configureLocalMcp(
      "mimocode (MCP)",
      join(HOME, ".config", "mimocode", "mimocode.jsonc"),
      semester,
    ),
    ...installSkill(),
  ];
}

/** Ruta absoluta del servidor MCP, para mostrarla en el informe/documentación. */
export const MCP_SERVER_PATH = SERVER_JS;
