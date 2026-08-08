-- Migration 167: drop the temporary unguarded debug copies from 165 —
-- verified against real data (and caught/fixed a real bug via 166), no
-- longer needed, never left reachable.
DROP FUNCTION IF EXISTS _debug_workspace_shell(varchar);
DROP FUNCTION IF EXISTS _debug_workspace_documents(varchar);
