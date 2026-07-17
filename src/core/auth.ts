import { SessionExpiredError } from "./errors.js";
import { loginWithPlaywright, type LoginOptions } from "./login.js";
import { isValid, loadSession, type Session } from "./session.js";

export type AuthMode =
  /** Renueva sin interacción: sólo intento headless. Falla con SessionExpiredError. Ideal para MCP. */
  | "headless-only"
  /** Intenta headless y, si falla, abre navegador visible para que el usuario inicie sesión. */
  | "interactive"
  /** No renueva; falla de inmediato si no hay sesión válida. */
  | "none";

/**
 * Devuelve una sesión válida, renovándola según el modo:
 *  - "interactive" (por defecto): headless y, si falla, login visible (reusa el perfil
 *    persistente; SSO de Google normalmente vivo → sin reescribir credenciales).
 *  - "headless-only": sólo intento headless silencioso; si el SSO expiró, lanza
 *    SessionExpiredError (el llamador pide correr `dutic login`).
 *  - "none": nunca renueva.
 */
export async function ensureSession(
  opts: { mode?: AuthMode; login?: LoginOptions } = {},
): Promise<Session> {
  const { mode = "interactive", login } = opts;
  const existing = await loadSession();
  if (isValid(existing)) return existing;

  if (mode === "none") throw new SessionExpiredError();

  // Intento headless silencioso (funciona si el SSO de Google sigue vivo).
  try {
    return await loginWithPlaywright({ headless: true, timeoutMs: 45_000, ...login });
  } catch (err) {
    if (mode === "headless-only") throw new SessionExpiredError();
    // "interactive": abrir navegador visible para que el usuario complete el login.
    return await loginWithPlaywright({ headless: false, ...login });
  }
}

/**
 * Envuelve una operación que usa la sesión. Si la operación falla por sesión expirada,
 * renueva una vez y reintenta. Esto absorbe la caducidad del token a mitad de uso.
 */
export async function withSession<T>(
  operation: (session: Session) => Promise<T>,
  opts: { mode?: AuthMode; login?: LoginOptions } = {},
): Promise<T> {
  let session = await ensureSession(opts);
  try {
    return await operation(session);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      session = await ensureSession(opts);
      return await operation(session);
    }
    throw err;
  }
}
