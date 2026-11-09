/**
 * Real image bytes for the media gates.
 *
 * Goal 0009 publishes bytes unchanged, so a fixture has to *be* a PNG, a JPEG, a
 * GIF, a WebP and an AVIF. A text placeholder named `.png` is exactly the
 * "identified by validated content, never by its extension" case the pipeline
 * refuses, so a fixture that faked one would measure nothing.
 *
 * The bytes are embedded rather than read from files so a test can write a corpus
 * without a fixture directory, and so the committed corpus under
 * `tests/fixtures/assets/` holds reproducibly the same bytes. They are tiny on
 * purpose — 8x6 or smaller — and two are *animated* (a three-frame GIF and a
 * three-frame WebP), because "animated source preserved" is only testable against
 * real animation.
 *
 * `PNG_UNICODE` carries the kind of name an author writes — a space and CJK — and
 * is what the spaces/Unicode cases use. Each constant is a base64 payload decoded
 * by `imageBytes`.
 */

/** Decode one fixture payload to bytes. */
export function imageBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** A static PNG with an alpha pixel. */
export const PNG_UNICODE = imageBytes(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAAIElEQVR4nGNg+M/Q8J+B4T8uzPifgeE/Ax7AhE+STgoAM9kR' +
    'eVP24xQAAAAASUVORK5CYII=',
);

/** A second, byte-different PNG, for precedence and dedupe cases. */
export const PNG_SECOND = imageBytes(
  'iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAIAAAACDbGyAAAAFElEQVR4nGPkUbJgQAJMDKiAVD4AIMgAcPIiWLoAAAAASUVO' +
    'RK5CYII=',
);

/**
 * A third, byte-different PNG, for names carrying URL-reserved characters.
 *
 * Kept distinct from the other two because a display gate must publish it under
 * its own digest: if it shared bytes, content-addressed deduplication would give
 * it the other file's name and the reserved-character URL would never exist.
 */
export const PNG_THIRD = imageBytes(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mOQz58PRwzEcQDhYxLRxFKAIgAAAABJRU5ErkJggg==',
);

/** A baseline JPEG; its source name ends `.jpeg` and it publishes as `.jpg`. */
export const JPEG = imageBytes(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwg' +
    'IyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo' +
    'KCgoKCgoKCgoKCgoKCj/wAARCAAGAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAA' +
    'AgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6' +
    'Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG' +
    'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA' +
    'AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5' +
    'OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPE' +
    'xcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDzt3aR2d2LOxyWJySfWiiivjj+kElFWWx/' +
    '/9k=',
);

/** A three-frame animated GIF. */
export const GIF_ANIMATED = imageBytes('R0lGODlhBAAEAIAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAHgAAACwAAAAABAAEAAAICQABCBxIsCCAgAA7');

/** A three-frame animated WebP. */
export const WEBP_ANIMATED = imageBytes(
  'UklGRvQAAABXRUJQVlA4WAoAAAACAAAAAwAAAwAAQU5JTQYAAAAAAAAAAABBTk1GMAAAAAAAAAAAAAMAAAMAAGQAAAJWUDgg' +
    'GAAAADABAJ0BKgQABAABQCYlpAADcAD+/TZoAEFOTUZCAAAAAAAAAAAAAwAAAwAAZAAAAFZQOCAqAAAAVAEAnQEqBAAEAAAA' +
    'JiWYAARhgAD+/FHt/qqnr8bv//ggv4gv4grAAAAAQU5NRkYAAAAAAAAAAAADAAADAABkAAAAVlA4IC4AAAA0AQCdASoEAAQA' +
    'AAAmJaAAA3AA/vqJ3//Wryq9ZW8f//Vof/8tD//lofwAAAAA',
);

/** A static AVIF (ISO BMFF, `avif` major brand). */
export const AVIF = imageBytes(
  'AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAA' +
    'AAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAANgAAAChpaW5mAAAAAAABAAAAGmluZmUC' +
    'AAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAACAAAAAYAAAAQcGl4aQAAAAADCAgIAAAA' +
    'DGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAPm1kYXQSAAoIGAi9aICGg0Iy' +
    'KBPHh4ZlAYYYfhAAAAhIWSQPnn1IeDGh//Fp2vskWHjDP4kzUBqZ1YA=',
);

/** An SVG document: a real image format this phase refuses on purpose. */
export const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
);

/** Not an image at all, and named like one. */
export const NOT_AN_IMAGE = new TextEncoder().encode('this is prose, not pixels\n');
