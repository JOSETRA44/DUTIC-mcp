# Fixtures de la encuesta docente

Respuestas **reales** del sistema `extranet.unsa.edu.pe/encuesta2`, capturadas para poder probar el
parseo completo sin red ni credenciales.

- `lista.raw` — respuesta de `php/listaEncEst.php` con `opcion=1` (incluye el debug SQL que emite el
  servidor, a propósito: el parser tiene que saber descartarlo).
- `cuestionario-1937.raw`, `cuestionario-1164.raw` — respuestas de `php/llenaEnc.php` con `opcion=3`,
  de dos docentes distintos, para comprobar que la estructura no varía entre ellos.

**Los nombres de los docentes están anonimizados** (`DOCENTE/UNO, NOMBRE EJEMPLO`…). Este repositorio
es público y los nombres originales son datos personales de terceros que no pintan nada aquí. Todo lo
demás —ids de pregunta, ids de alternativa, etiquetas de la escala, estructura del HTML— se conserva
byte a byte, que es lo único que los tests necesitan.

Si vuelves a capturar fixtures, anonimiza antes de commitear.
