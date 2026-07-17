/** Errores tipados del dominio DUTIC, para distinguir causas de fallo. */

/** La sesión de Moodle caducó o no existe — hay que re-loguear. */
export class SessionExpiredError extends Error {
  constructor(message = "La sesión de Moodle caducó o no existe. Ejecuta `dutic login`.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** Error de aplicación devuelto por Moodle (errorcode no relacionado con login). */
export class MoodleApiError extends Error {
  constructor(
    message: string,
    readonly moodleErrorCode: string | null = null,
  ) {
    super(message);
    this.name = "MoodleApiError";
  }
}

/** Fallo de red/HTTP tras agotar reintentos. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}
