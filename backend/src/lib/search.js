// Search helper shared by the user and template lists. Owner: Hana Fady.
//
// Turns what the user typed into a safe ILIKE pattern. The value is always
// sent as a query parameter (never pasted into SQL), and % and _ are
// escaped so they are matched literally instead of acting as wildcards.

const MAX_SEARCH = 100;

// Returns { value: pattern | null } or { error } for a 400.
function searchPattern(raw) {
  if (raw === undefined) return { value: null };
  if (typeof raw !== 'string' || raw.length > MAX_SEARCH) {
    return { error: `search must be text of at most ${MAX_SEARCH} characters` };
  }
  const term = raw.trim();
  if (!term) return { value: null };
  return { value: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
}

module.exports = { searchPattern, MAX_SEARCH };
