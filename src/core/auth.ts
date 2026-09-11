import { observeIdentity } from "../domain/identity.js";
import { span } from "../telemetry/index.js";
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
 * Tras una sesión nueva, anota quién es el usuario en ese semestre (`domain/identity.ts`).
 * Nunca tumba la renovación: si la observación falla, la sesión sigue siendo buena.
 */
async function rememberIdentity(session: Session): Promise<Session> {
  await observeIdentity(session).catch(() => null);
  return session;
}

/**
 * Devuelve una sesión válida, renovándola según el modo:
 *  - "interactive" (por defecto): headless y, si falla, login visible (reusa el perfil
 *    persistente; SSO de Google normalmente vivo → sin reescribir credenciales).
 *  - "headless-only": sólo intento headless silencioso; si el SSO expiró, lanza
 *    SessionExpiredError (el llamador pide correr `dutic login`).
 *  - "none": nunca renueva.
 *
 * Cada intento de renovación se mide (`auth.renew` / `auth.login`): la caducidad del SSO de
 * Google es la primera causa de que dutic "deje de funcionar", y así se ve cuándo y dónde pasa.
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
    // 60s: el intento headless ahora sigue el enlace OAuth y hace el viaje completo por
    // Google, que puede encadenar varias redirecciones.
    const session = await span(
      "auth.renew",
      "headless",
      () => loginWithPlaywright({ headless: true, timeoutMs: 60_000, ...login }),
      { mode },
    );
    return await rememberIdentity(session);
  } catch (err) {
    if (mode === "headless-only") throw new SessionExpiredError();
    // "interactive": abrir navegador visible para que el usuario complete el login.
    const session = await span("auth.login", "interactive", () =>
      loginWithPlaywright({ headless: false, ...login }),
    );
    return await rememberIdentity(session);
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
