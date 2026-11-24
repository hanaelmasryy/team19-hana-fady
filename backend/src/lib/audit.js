// Shared audit helper: writes one security event to the insert-only
// audit_log table (proposal 6.2 "Logging").
//
// Created by Hana Fady for the login events (Week 2). Every service uses
// the same helper; Jana's Admin audit-log API reads what it writes.
//
// Never pass passwords, tokens or note text in here.

const pool = require('../db/pool');

const MAX = 60; // column limits in schema.sql

function clip(value) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, MAX);
}

// result must be 'allowed' or 'denied'.
// An audit failure must never break the request, so errors are only logged.
async function recordAudit({ actorId = null, action, entity = null, entityId = null, result, ip = null }) {
  try {
    await pool.db().query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, result, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, clip(action), clip(entity), clip(entityId), result, ip ? String(ip).slice(0, 64) : null]
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'audit write failed', action, error: err.message }));
  }
}

module.exports = { recordAudit };
