import type { Command } from "commander";
import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureSession } from "../core/auth.js";
import { DATA_DIR, HOST } from "../core/config.js";
import { SessionExpiredError } from "../core/errors.js";
import { acquireLock } from "../core/lock.js";
import { loadSaasEnrollment, pushChanges, pushNotice } from "../core/saasClient.js";
import { setCacheRefresh } from "../core/cache.js";
import { checkChanges } from "../domain/watch.js";
import { banner, c, mark } from "./ui.js";

const execFileAsync = promisify(execFile);
const out = (msg = "") => process.stdout.write(msg + "\n");

/**
 * Automatización local ("agente invisible"): en vez de dejar un daemon residente
 * comiéndose la RAM, se registra una TAREA PROGRAMADA del sistema que ejecuta
 * `dutic auto run` cada pocas horas. El proceso vive ~30 s y muere — en reposo el
 * consumo es literalmente cero, y el Programador de tareas de Windows aporta gratis lo
 * que un daemon casero tendría que reimplementar mal: reintentos, arranque al iniciar
 * sesión, condiciones de red/batería y recuperación tras suspensión.
 */

const TASK_NAME = "DuticAuto";
const LOG_FILE = join(DATA_DIR, "auto.log");
const LOG_MAX_LINES = 500;

/** Raíz del paquete (dist/cli/ → ../../), mismo patrón que cli/setup.ts. */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(PKG_ROOT, "dist", "cli", "index.js");

// ── Log acotado ────────────────────────────────────────────────────────────────────
// Corre desatendido, así que sin un tope el log crecería sin límite en el disco del
// estudiante. Se recorta a las últimas LOG_MAX_LINES.

async function log(line: string): Promise<void> {
  const stamp = new Date().toISOString();
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(LOG_FILE, `${stamp}  ${line}\n`, "utf8").catch(() => {});
}

async function trimLog(): Promise<void> {
  try {
    const lines = (await readFile(LOG_FILE, "utf8")).split("\n");
    if (lines.length > LOG_MAX_LINES) {
      await writeFile(LOG_FILE, lines.slice(-LOG_MAX_LINES).join("\n"), "utf8");
    }
  } catch {
    /* sin log todavía */
  }
}

async function tailLog(n: number): Promise<string[]> {
  try {
    return (await readFile(LOG_FILE, "utf8")).trim().split("\n").slice(-n);
  } catch {
    return [];
  }
}

// ── Comprobaciones baratas antes de gastar recursos ────────────────────────────────

/**
 * ¿Hay red? Una resolución DNS falla en milisegundos si el equipo está sin conexión,
 * así que evita arrancar Playwright y el barrido completo para nada (caso muy común en
 * una laptop que se enciende fuera de casa).
 */
async function hasNetwork(): Promise<boolean> {
  try {
    await dns.lookup(HOST);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── El trabajo real ────────────────────────────────────────────────────────────────

async function runOnce(opts: { now?: boolean; verbose?: boolean }): Promise<number> {
  const say = (msg: string) => {
    if (opts.verbose) out(msg);
  };

  // Nunca dos a la vez, y ceder ante un comando manual que esté usando el perfil del
  // navegador. Si está ocupado no es un error: simplemente toca en la próxima pasada.
  const lock = await acquireLock("auto", { label: "auto run" });
  if (!lock) {
    await log("omitido: otra instancia de dutic tiene el lock");
    say(`${mark.info()} Otra instancia está corriendo; se omite esta pasada.`);
    return 0;
  }

  try {
    if (!(await hasNetwork())) {
      await log("omitido: sin conexión");
      say(`${mark.info()} Sin conexión; se omite esta pasada.`);
      return 0;
    }

    const enrollment = await loadSaasEnrollment();
    if (!enrollment) {
      await log("omitido: no enrolado (corre `dutic saas enroll`)");
      say(`${mark.warn()} No estás enrolado. Corre ${c.cyan("dutic saas enroll")}.`);
      return 0;
    }

    // Segunda capa de jitter (la del Programador de tareas no aplica al disparador de
    // inicio de sesión). Si muchos estudiantes encienden su laptop a la misma hora, sin
    // esto todos barrerían el aula virtual en el mismo instante.
    if (!opts.now) {
      const jitter = Math.floor(Math.random() * 120_000);
      await log(`jitter ${Math.round(jitter / 1000)}s`);
      await sleep(jitter);
    }

    // CRÍTICO: "headless-only". Con el modo por defecto ("interactive"), una sesión
    // caducada abriría una ventana de Chrome de la nada en la pantalla del estudiante,
    // lanzada por una tarea de fondo. Aquí eso nunca puede pasar.
    let session;
    try {
      session = await ensureSession({ mode: "headless-only" });
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await log("sesión expirada: no se pudo renovar en silencio, avisando por WhatsApp");
        say(`${mark.warn()} Sesión expirada; avisando por WhatsApp.`);
        await pushNotice(enrollment.enrollToken, "session_expired", {
          message: "Tu sesión del aula virtual expiró. Corre `dutic login` para reactivar los avisos.",
        }).catch(() => {});
        return 0;
      }
      throw err;
    }

    // Para detectar cambios reales hay que mirar datos frescos, no la caché.
    setCacheRefresh(true);
    const { changes, previousAt, snapshot } = await checkChanges(session);

    if (!previousAt) {
      await log("línea base guardada (primera pasada)");
      say(`${mark.info()} Línea base guardada.`);
      return 0;
    }

    const result = await pushChanges(enrollment.enrollToken, snapshot, changes);
    await log(`ok: ${result.notificationsQueued} novedad(es) encoladas`);
    say(`${mark.ok()} ${result.notificationsQueued} novedad(es) encoladas.`);
    return result.notificationsQueued;
  } finally {
    await lock.release();
    await trimLog();
  }
}

// ── Registro de la tarea programada (Windows) ──────────────────────────────────────

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
  return stdout.trim();
}

/**
 * Construye el script de registro. Se usa el Programador de tareas y NO una clave
 * "Run" del registro: esa clave es el patrón clásico de persistencia de malware y es lo
 * primero que marca un antivirus. Aquí todo es explícito — ruta real de node.exe, ruta
 * real del script, tarea con nombre visible y desinstalable.
 */
function buildInstallScript(intervalHours: number, onlyOnAc: boolean): string {
  const nodeExe = process.execPath;
  const settings = [
    onlyOnAc ? "" : "-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "-RunOnlyIfNetworkAvailable",
    "-StartWhenAvailable",
    "-Hidden",
    "-MultipleInstances IgnoreNew",
    "-ExecutionTimeLimit (New-TimeSpan -Minutes 10)",
    "-Priority 7",
  ]
    .filter(Boolean)
    .join(" ");

  return `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute '${nodeExe}' -Argument '"${CLI_ENTRY}" auto run' -WorkingDirectory '${PKG_ROOT}'

# Disparador 1: poco después de iniciar sesión (cubre "encendí la laptop").
$trigLogon = New-ScheduledTaskTrigger -AtLogOn -User '${process.env.USERNAME ?? ""}'
$trigLogon.Delay = 'PT10M'

# Disparador 2: repetición indefinida cada ${intervalHours} h, con retraso aleatorio de
# hasta 45 min para no producir una estampida contra los servidores de la UNSA si muchos
# estudiantes tienen esto instalado.
# Se OMITE -RepetitionDuration a propósito: deja Duration vacío, que el Programador de
# tareas interpreta como "indefinidamente". Pasar [TimeSpan]::MaxValue serializa a
# P99999999DT23H59M59S y el registro falla con "valor fuera de intervalo".
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddHours(7) \`
  -RepetitionInterval (New-TimeSpan -Hours ${intervalHours})
$trigRepeat.RandomDelay = 'PT45M'

$settings = New-ScheduledTaskSettingsSet ${settings}
# Nunca despertar una laptop dormida por esto.
$settings.WakeToRun = $false

Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigLogon,$trigRepeat \`
  -Settings $settings -Force \`
  -Description 'DUTIC: revisa el aula virtual y envia novedades al bot de WhatsApp. Desinstalar: dutic auto uninstall' | Out-Null
'OK'
`.trim();
}

function unsupportedPlatformHelp(intervalHours: number): void {
  const cron = `0 */${intervalHours} * * *  "${process.execPath}" "${CLI_ENTRY}" auto run`;
  out(`${mark.warn()} Registro automático sólo implementado en Windows.`);
  out(`  En macOS/Linux, añade esta línea con ${c.cyan("crontab -e")}:\n`);
  out(`  ${c.dim(cron)}\n`);
}

// ── Comandos ───────────────────────────────────────────────────────────────────────

export function registerAutoCommands(program: Command): void {
  const auto = program
    .command("auto")
    .description("Automatiza la revisión en segundo plano (sin daemon: usa el Programador de tareas).");

  auto
    .command("install")
    .description("Registra la tarea programada que revisa y envía novedades sola.")
    .option("--interval <horas>", "Cada cuántas horas revisar.", "3")
    .option("--only-on-ac", "No revisar cuando la laptop está con batería.")
    .action(async (opts) => {
      const hours = Math.max(1, Number(opts.interval) || 3);
      if (platform() !== "win32") return unsupportedPlatformHelp(hours);
      try {
        await powershell(buildInstallScript(hours, Boolean(opts.onlyOnAc)));
        out(banner("Automatización activada"));
        out(`${mark.ok()} Tarea ${c.cyan(TASK_NAME)} registrada — revisa cada ${hours} h.`);
        out(`  ${c.dim("En reposo no consume nada: el proceso sólo vive unos segundos por pasada.")}`);
        out(`  ${c.dim(`Estado: dutic auto status  ·  Quitar: dutic auto uninstall`)}`);
      } catch (err) {
        out(`${mark.err()} No se pudo registrar la tarea: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  auto
    .command("uninstall")
    .description("Elimina la tarea programada.")
    .action(async () => {
      if (platform() !== "win32") {
        out(`${mark.info()} Quita a mano la línea de crontab que añadiste.`);
        return;
      }
      try {
        await powershell(
          `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop; 'OK'`,
        );
        out(`${mark.ok()} Tarea ${c.cyan(TASK_NAME)} eliminada.`);
      } catch {
        out(`${mark.info()} No había ninguna tarea ${c.cyan(TASK_NAME)} registrada.`);
      }
    });

  auto
    .command("status")
    .description("Muestra si la automatización está activa, cuándo corrió y el log reciente.")
    .action(async () => {
      out(banner("Automatización"));

      const enrollment = await loadSaasEnrollment();
      out(
        enrollment
          ? `  enrolado: ${c.green("sí")} ${c.dim(`(estado ${enrollment.status})`)}`
          : `  enrolado: ${c.yellow("no")} ${c.dim("— corre `dutic saas enroll`")}`,
      );

      if (platform() === "win32") {
        try {
          const info = await powershell(
            `$i = Get-ScheduledTaskInfo -TaskName '${TASK_NAME}' -ErrorAction Stop; ` +
              `"$($i.LastRunTime)|$($i.NextRunTime)|$($i.LastTaskResult)"`,
          );
          const [last, next, code] = info.split("|");
          out(`  tarea:    ${c.green("registrada")}`);
          out(`  última:   ${last || "—"} ${code === "0" ? c.dim("(ok)") : c.yellow(`(código ${code})`)}`);
          out(`  próxima:  ${next || "—"}`);
        } catch {
          out(`  tarea:    ${c.yellow("no registrada")} ${c.dim("— corre `dutic auto install`")}`);
        }
      }

      const lines = await tailLog(10);
      if (lines.length) {
        out(`\n${c.dim("últimas entradas:")}`);
        for (const l of lines) out(`  ${c.dim(l)}`);
      }
    });

  auto
    .command("run")
    .description("Ejecuta una pasada (lo invoca la tarea programada; también sirve para probar).")
    .option("--now", "Sin retraso aleatorio (para probar a mano).")
    .option("-v, --verbose", "Imprime lo que va haciendo.")
    .action(async (opts) => {
      try {
        await runOnce({ now: opts.now, verbose: opts.verbose });
      } catch (err) {
        // Desatendido: registrar y salir en silencio, nunca dejar una ventana colgada.
        await log(`error: ${(err as Error)?.message ?? err}`);
        if (opts.verbose) out(`${mark.err()} ${(err as Error)?.message ?? err}`);
        process.exitCode = 1;
      }
    });
}

/** Instala la tarea sin ruido, para encadenarlo tras `dutic saas enroll`. */
export async function installAutoQuietly(): Promise<boolean> {
  if (platform() !== "win32") return false;
  try {
    await powershell(buildInstallScript(3, false));
    return true;
  } catch {
    return false;
  }
}
