/**
 * Build the escaped, anchored SQL-LIKE pattern that matches exactly the chunks
 * ingested for a single Drive file.
 *
 * The sourceUrl stored on ingest is the Drive file's webViewLink (or a
 * `.../document/d/<fileId>/edit` fallback) — both embed the id as `/d/<fileId>/`.
 * A bare `LIKE '%<fileId>%'` over-deletes: Drive ids can contain `_`, which is a
 * single-char LIKE wildcard, and an unanchored substring can collide with
 * unrelated URLs. Anchor on the `/d/<fileId>/` path segment and escape the LIKE
 * metacharacters (`\`, `%`, `_`) so the id is matched literally. Use with
 * `ESCAPE '\'`.
 */
export function buildChunkDeleteLikePattern(fileId: string): string {
  const escapedFileId = fileId.replace(/([\\%_])/g, '\\$1');
  return `%/d/${escapedFileId}/%`;
}
