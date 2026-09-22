/** Errores tipados del catálogo, independientes del sistema bibliotecario concreto. */

/** El catálogo no respondió (red, timeout, 5xx) tras agotar reintentos. */
export class LibraryUnavailableError extends Error {
  constructor(message = "La Biblioteca Virtual UNSA no respondió. Suele tardar ~15 s; vuelve a intentarlo.") {
    super(message);
    this.name = "LibraryUnavailableError";
  }
}

/** El catálogo respondió algo que no encaja con la estructura conocida (¿cambió el OPAC?). */
export class LibraryProtocolError extends Error {
  constructor(
    message: string,
    readonly raw: string | null = null,
  ) {
    super(message);
    this.name = "LibraryProtocolError";
  }
}
