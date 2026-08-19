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

/**
 * El login de la encuesta docente fue rechazado, o su sesión PHP caducó. Es distinto de
 * SessionExpiredError: aquel habla de Moodle y pide `dutic login` (OAuth de Google), que aquí
 * no tiene nada que ver.
 */
export class EncuestaAuthError extends Error {
  constructor(
    message = "No se pudo iniciar sesión en la encuesta docente. Revisa `dutic encuesta login`.",
  ) {
    super(message);
    this.name = "EncuestaAuthError";
  }
}

/**
 * El sistema de encuestas respondió algo que no encaja con el protocolo conocido: un `0|mensaje`,
 * un HTML sin los campos esperados, o una escala de alternativas irreconocible.
 *
 * Es un error DURO y deliberadamente no recuperable: como el envío es irreversible y el sistema no
 * da acuse de recibo, ante cualquier duda se aborta sin enviar y sin reintentar, en vez de
 * arriesgarse a mandar una evaluación mal formada o duplicada.
 */
export class EncuestaProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: string | null = null,
  ) {
    super(message);
    this.name = "EncuestaProtocolError";
  }
}

/**
 * El login del sistema de matrícula (SISACAD/acad_usuario.php) fue rechazado: usuario, clave o
 * escuela incorrectos, o matrícula no pagada. Es distinto de SessionExpiredError (Moodle) y de
 * EncuestaAuthError (encuesta): aquí el fallo suele ser de credenciales, no de sesión caducada.
 */
export class SisacadAuthError extends Error {
  constructor(
    message = "No se pudo iniciar sesión en el sistema de matrícula. Revisa `dutic hrs login`.",
  ) {
    super(message);
    this.name = "SisacadAuthError";
  }
}

/** El sistema de matrícula respondió algo que no encaja con el protocolo conocido (HTML inesperado…). */
export class SisacadProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: string | null = null,
  ) {
    super(message);
    this.name = "SisacadProtocolError";
  }
}
