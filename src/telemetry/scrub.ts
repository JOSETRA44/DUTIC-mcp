import { homedir } from "node:os";

/**
 * Saneado de los textos que salen del equipo en la telemetría: mensajes de error y stacks.
 * NUNCA pasan por aquí argumentos ni resultados de herramientas — esos no se envían en absoluto.
 *
 * Dos niveles, con dueños distintos:
 *
 *   1. SECRETOS (`redactSecrets`) — siempre y sin excepción. Lo que permite suplantar al
 *      usuario (sesskey, MoodleSession, JWT, tokens, credenciales de la instalación) y la ruta
 *      de su carpeta personal, que en Windows lleva su nombre. No es una decisión de producto:
 *      si esto falla, la telemetría es una fuga.
 *
 *   2. DATOS PERSONALES Y ACADÉMICOS (`redactPersonal`) — aquí sí hay un equilibrio: cuanto
 *      más se borra, menos sirve el error para depurar.
 */

/** Largo final de un mensaje. Un error que no se entiende en 500 caracteres es un stack, no un mensaje. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Interruptor de toda la telemetría. Mientras sea `false`, dutic NI REGISTRA NI ENVÍA eventos.
 *
 * Existe porque el saneado se aplica al registrar: un evento guardado en disco con la política
 * vacía seguiría sin sanear el día que se envíe. Ponlo en `true` en el mismo cambio en que
 * implementes `redactPersonal` (ver el TODO de abajo).
 */
export const PERSONAL_POLICY_READY: boolean = false;

/**
 * Tope previo al saneado. Se recorta ANTES para acotar el trabajo de las expresiones, pero con
 * margen amplio: cortar justo en MAX_MESSAGE_LENGTH podría partir un secreto por la mitad y
 * dejar su comienzo sin reconocer.
 */
const PRE_SCRUB_LIMIT = 8_000;

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(sesskey=)[^&\s"'<>]+/gi, "$1<redacted>"],
  [/(MoodleSession=)[^;\s"'<>]+/gi, "$1<redacted>"],
  [/(PHPSESSID=)[^;\s"'<>]+/gi, "$1<redacted>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>"],
  [/(DUTIC-Install\s+)\S+/gi, "$1<redacted>"],
  [/("?(?:password|passwd|clave|token|secret|enrollToken|sesskey)"?\s*[:=]\s*"?)[^"\s,;}&]+/gi, "$1<redacted>"],
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Nivel 1: secretos y carpeta personal. `home` es inyectable para las pruebas. */
export function redactSecrets(text: string, home: string = homedir()): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  if (home) {
    // Windows mezcla separadores: `C:\Users\ana` y `C:/Users/ana` son la misma carpeta, y en
    // un stack pueden aparecer las dos formas (o la codificada de una URL file://).
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), "gi"), "~");
    }
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   TODO(josé) — nivel 2: qué datos personales y académicos se borran.

   Aquí llegan textos YA sin secretos. Ejemplos del tipo de mensaje que produce dutic
   (inventados, pero con la forma real):

     · "HTTP 404 en https://aulavirtual.unsa.edu.pe/2026B/user/view.php?id=10432&course=2911"
     · "No se encontró el perfil de ana.perez@unsa.edu.pe"
     · "La tarea \"Informe final de Econometría\" no tiene fecha de cierre"
     · "Participante 70412345 sin correo"

   La tensión: cada cosa que borras vuelve el error menos útil para reproducirlo, y cada
   cosa que dejas es un dato de alguien que viaja a nuestra base.

   · Correos → probablemente fuera (`<email>`): identifican a una persona y casi nunca
     explican un fallo.
   · ids en URLs → el `id` de user/view.php es de una PERSONA; el de course/view.php es
     de un CURSO, rara vez sensible y muy útil para reproducir un fallo de scraping.
     ¿Los tratas distinto?
   · Texto entre comillas (tareas, cursos, a veces nombres) → suele ser lo que explica
     el fallo, pero puede ser el nombre de un compañero.
   · Números sueltos de 8+ dígitos (DNI, CUI, teléfonos) → ¿fuera?

   Implementa `redactPersonal` (5-10 líneas) con la política que te parezca justa, y
   activa los casos `todo` de scrub.test.ts que la describan. Hasta que esto exista, el
   transporte de la telemetría no se conecta a ninguna llamada.
   ──────────────────────────────────────────────────────────────────────────── */
export function redactPersonal(text: string): string {
  return text;
}

/** Saneado completo de un mensaje antes de salir del equipo. */
export function scrub(value: unknown, home?: string): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return redactPersonal(redactSecrets(raw.slice(0, PRE_SCRUB_LIMIT), home)).slice(0, MAX_MESSAGE_LENGTH);
}
