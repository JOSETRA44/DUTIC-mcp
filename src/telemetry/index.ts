import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { APP_VERSION } from "../core/version.js";
import { identityGranted, loadState, technicalEnabled, TELEMETRY_DIR, updateState } from "./consent.js";
import { semesterContext } from "./envelope.js";
import { identifyError } from "./fingerprint.js";
import { ensureInstall, resetInstall } from "./install.js";
import { PERSONAL_POLICY_READY, scrub } from "./scrub.js";
import { Spool } from "./spool.js";
import { postJson } from "./transport.js";

/**
 * Telemetría de dutic: la única puerta que usan la CLI, el servidor MCP y el agente.
 *
 * Tres garantías, en este orden:
 *   1. NUNCA rompe ni retrasa al usuario. Registrar es escribir una línea en disco; enviar
 *      ocurre aparte, con presupuesto de tiempo, y cualquier fallo se traga.
 *   2. NUNCA envía secretos ni argumentos/resultados de herramientas: sólo nombres, tiempos,
 *      clases de error y mensajes saneados (`scrub.ts`).
 *   3. Respeta el consentimiento en cada evento (`consent.ts`), no sólo al arrancar.
 */

export type Surface = "cli" | "mcp" | "auto";
export type Status = "ok" | "error" | "cancelled" | "skipped";
export type Attrs = Record<string, string | number | boolean | null>;

interface SpanState {
  traceId: string;
  spanId: string;
  /** Error que una capa convirtió en resultado (p.ej. `tool()` del MCP) sin relanzarlo. */
  error?: unknown;
}

const spans = new AsyncLocalStorage<SpanState>();
const runId = randomUUID();
let surface: Surface = "cli";
let mcpClient: string | undefined;
let spool: Spool | null = null;

function active(): boolean {
  return PERSONAL_POLICY_READY && technicalEnabled();
}

/** ¿Se están registrando eventos ahora mismo? (política lista, entorno y usuario lo permiten). */
export function telemetryActive(): boolean {
  return active();
}

/**
 * Abre un span que se cierra desde fuera, para quien no puede envolver la operación en una
 * función (los hooks `preAction`/`postAction` de commander). `enterWith` propaga la traza a
 * todo lo que la acción ejecute después, así las renovaciones de sesión cuelgan del comando.
 */
export function startSpan(kind: string, name: string, attrs?: Attrs): { end(error?: unknown): void } {
  if (!active()) return { end() {} };
  const parent = spans.getStore();
  const state: SpanState = { traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID() };
  spans.enterWith(state);
  const started = performance.now();
  let ended = false;
  return {
    end(error?: unknown) {
      if (ended) return;
      ended = true;
      const failure = error ?? state.error;
      record({
        kind,
        name,
        status: failure === undefined ? "ok" : "error",
        error: failure,
        attrs,
        durationMs: performance.now() - started,
        traceId: state.traceId,
        spanId: state.spanId,
        parentSpanId: parent?.spanId,
      });
    },
  };
}

/** Cola local, para los comandos de mantenimiento (`dutic telemetry status|off|forget`). */
export function localQueue(): Spool {
  return queue();
}

function queue(): Spool {
  return (spool ??= new Spool(TELEMETRY_DIR));
}

export function initTelemetry(options: { surface: Surface }): void {
  surface = options.surface;
}

/** Qué agente usa el servidor MCP (Claude Code, OpenCode…), según el `initialize` del cliente. */
export function setMcpClient(name?: string, version?: string): void {
  mcpClient = name ? `${name}${version ? `/${version}` : ""}`.slice(0, 64) : undefined;
}

export interface EventInput {
  kind: string;
  name: string;
  status: Status;
  durationMs?: number;
  error?: unknown;
  attrs?: Attrs;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

/** Registra un evento suelto. */
export function record(input: EventInput): void {
  if (!active()) return;
  try {
    const event: Record<string, unknown> = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      runId,
      surface,
      mcpClient,
      kind: input.kind,
      name: input.name,
      status: input.status,
      durationMs: input.durationMs === undefined ? undefined : Math.round(input.durationMs),
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      attrs: input.attrs,
      ...semesterContext(),
    };
    if (input.error !== undefined) {
      const identity = identifyError(input.error);
      const message = input.error instanceof Error ? input.error.message : input.error;
      event.error = {
        class: identity.errorClass,
        code: identity.code ?? undefined,
        fingerprint: identity.fingerprint,
        message: scrub(message),
      };
    }
    queue().append(event);
  } catch {
    /* la telemetría nunca rompe al usuario */
  }
}

/**
 * Mide una operación y la registra. Los spans anidados comparten `traceId`, así que un
 * comando y las renovaciones de sesión que dispare se ven como una sola traza en la consola.
 * El error, si lo hay, se relanza intacto.
 */
export async function span<T>(kind: string, name: string, fn: () => Promise<T>, attrs?: Attrs): Promise<T> {
  if (!active()) return fn();

  const parent = spans.getStore();
  const state: SpanState = { traceId: parent?.traceId ?? randomUUID(), spanId: randomUUID() };
  const started = performance.now();
  const finish = (status: Status, error?: unknown) =>
    record({
      kind,
      name,
      status,
      error,
      attrs,
      durationMs: performance.now() - started,
      traceId: state.traceId,
      spanId: state.spanId,
      parentSpanId: parent?.spanId,
    });

  try {
    const result = await spans.run(state, fn);
    finish(state.error === undefined ? "ok" : "error", state.error);
    return result;
  } catch (err) {
    finish("error", err);
    throw err;
  }
}

/** Para capas que convierten un error en un resultado sin relanzarlo: lo anota en el span en curso. */
export function noteError(err: unknown): void {
  const state = spans.getStore();
  if (state) state.error = err;
}

// ── Envío ──────────────────────────────────────────────────────────────────────────

const MAX_BATCH_EVENTS = 200;
const MAX_BATCH_CHARS = 200_000;

let flushing: Promise<void> | null = null;

/**
 * Envía lo pendiente dentro de un presupuesto de tiempo. Lo que no quepa se queda en disco
 * para la próxima ocasión. Llamadas concurrentes comparten el mismo envío.
 */
export function flush(options: { budgetMs?: number } = {}): Promise<void> {
  if (!active()) return Promise.resolve();
  flushing ??= send(options.budgetMs ?? 5000)
    .catch(() => {})
    .finally(() => {
      flushing = null;
    });
  return flushing;
}

async function send(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const pending = queue();

  const dropped = pending.enforceCap();
  if (dropped > 0) {
    record({ kind: "telemetry.dropped", name: "spool", status: "skipped", attrs: { bytes: dropped } });
  }

  const credential = await ensureInstall();
  if (!credential) return;

  for (const file of pending.claim()) {
    if (Date.now() >= deadline) {
      pending.release(file);
      continue;
    }

    const events = file.lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return []; // línea truncada por un corte de luz: se descarta sola
      }
    });

    let delivered = true;
    for (let start = 0; start < events.length && delivered; ) {
      const batch = takeBatch(events, start);
      start += batch.length;
      try {
        const res = await postJson(
          "telemetry-ingest",
          {
            v: 1,
            sentAt: new Date().toISOString(),
            appVersion: APP_VERSION,
            identityConsent: identityGranted(),
            events: batch,
          },
          { "X-Dutic-Install": `${credential.id}.${credential.secret}` },
          Math.max(500, Math.min(3000, deadline - Date.now())),
        );
        if (res.status === 401) {
          resetInstall(); // credencial olvidada o revocada: la próxima vez se registra otra
          delivered = false;
        } else if (res.status === 429 || res.status >= 500) {
          delivered = false;
        }
        // 2xx y el resto de 4xx: el lote no se reintenta. Reenviar algo que el servidor
        // rechazó por forma sería un bucle eterno; los reintentos por red son idempotentes.
      } catch {
        delivered = false;
      }
    }

    if (delivered) pending.ack(file);
    else pending.release(file);
  }
}

function takeBatch(events: Record<string, unknown>[], start: number): Record<string, unknown>[] {
  const batch: Record<string, unknown>[] = [];
  let chars = 0;
  for (let i = start; i < events.length && batch.length < MAX_BATCH_EVENTS; i++) {
    const size = JSON.stringify(events[i]).length;
    if (batch.length > 0 && chars + size > MAX_BATCH_CHARS) break;
    batch.push(events[i]);
    chars += size;
  }
  return batch;
}

// ── Aviso de primera ejecución ─────────────────────────────────────────────────────

/**
 * Texto del aviso, UNA vez por instalación. `null` si ya se mostró o si la telemetría está
 * apagada. Quien lo muestra decide dónde (stderr en la CLI; el MCP nunca escribe en stdout).
 */
export function takeFirstRunNotice(): string | null {
  if (!active() || loadState().noticeShownAt) return null;
  updateState({ noticeShownAt: Date.now() });
  return [
    "dutic envía telemetría técnica anónima para detectar y corregir fallos: qué comando o",
    "herramienta falló, cuánto tardó, versión y sistema operativo. Nunca tu sesión, tus notas",
    "ni el contenido de tus cursos. Desactívala con `dutic telemetry off` o DUTIC_TELEMETRY=0.",
  ].join("\n");
}
