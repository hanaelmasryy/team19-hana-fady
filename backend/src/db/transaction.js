// Runs fn(client) inside one database transaction: all of it is saved, or none of it.
// Shared by the template and user routes. Owner: Hana Fady.

const pool = require('./pool');

async function inTransaction(fn) {
  const client = await pool.db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { inTransaction };
