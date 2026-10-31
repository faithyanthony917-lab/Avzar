export async function checkDatabaseReadiness(pool) {
  if (!pool) return { ready: false, reason: 'database_not_configured' };
  try {
    await pool.query('SELECT 1');
    return { ready: true, reason: null };
  } catch {
    return { ready: false, reason: 'database_unavailable' };
  }
}
