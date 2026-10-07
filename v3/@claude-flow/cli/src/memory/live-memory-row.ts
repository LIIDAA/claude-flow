/** TTL is a read-time visibility rule, independent of background cleanup. */
export function liveMemoryRowSql(): string {
  return `(status = 'active' OR status IS NULL) AND (expires_at IS NULL OR expires_at > ${Date.now()})`;
}
