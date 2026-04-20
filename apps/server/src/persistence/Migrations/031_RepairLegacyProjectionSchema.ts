// FILE: 031_RepairLegacyProjectionSchema.ts
// Purpose: Repairs projection schema drift for legacy desktop databases that already consumed
// later migration ids with a different migration list.
// Layer: Persistence migration

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectionThreadsColumnExists = (columnName: string) =>
    sql<{ readonly exists: number }>`
      SELECT EXISTS(
        SELECT 1
        FROM pragma_table_info('projection_threads')
        WHERE name = ${columnName}
      ) AS "exists"
    `.pipe(Effect.map(([row]) => row?.exists === 1));

  const projectionThreadMessagesColumnExists = (columnName: string) =>
    sql<{ readonly exists: number }>`
      SELECT EXISTS(
        SELECT 1
        FROM pragma_table_info('projection_thread_messages')
        WHERE name = ${columnName}
      ) AS "exists"
    `.pipe(Effect.map(([row]) => row?.exists === 1));

  const ensureProjectionThreadsColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      if (yield* projectionThreadsColumnExists(columnName)) {
        return false;
      }
      yield* sql.unsafe(`
        ALTER TABLE projection_threads
        ADD COLUMN ${definition}
      `);
      return true;
    });

  const ensureProjectionThreadMessagesColumn = (columnName: string, definition: string) =>
    Effect.gen(function* () {
      if (yield* projectionThreadMessagesColumnExists(columnName)) {
        return false;
      }
      yield* sql.unsafe(`
        ALTER TABLE projection_thread_messages
        ADD COLUMN ${definition}
      `);
      return true;
    });

  yield* ensureProjectionThreadsColumn("handoff_json", "handoff_json TEXT");
  yield* ensureProjectionThreadsColumn("env_mode", "env_mode TEXT NOT NULL DEFAULT 'local'");
  yield* ensureProjectionThreadsColumn("fork_source_thread_id", "fork_source_thread_id TEXT");
  yield* ensureProjectionThreadsColumn("associated_worktree_path", "associated_worktree_path TEXT");
  yield* ensureProjectionThreadsColumn(
    "associated_worktree_branch",
    "associated_worktree_branch TEXT",
  );
  yield* ensureProjectionThreadsColumn("associated_worktree_ref", "associated_worktree_ref TEXT");
  yield* ensureProjectionThreadsColumn("archived_at", "archived_at TEXT");
  yield* ensureProjectionThreadsColumn("parent_thread_id", "parent_thread_id TEXT");
  yield* ensureProjectionThreadsColumn("subagent_agent_id", "subagent_agent_id TEXT");
  yield* ensureProjectionThreadsColumn("subagent_nickname", "subagent_nickname TEXT");
  yield* ensureProjectionThreadsColumn("subagent_role", "subagent_role TEXT");
  yield* ensureProjectionThreadsColumn("latest_user_message_at", "latest_user_message_at TEXT");
  yield* ensureProjectionThreadsColumn(
    "pending_approval_count",
    "pending_approval_count INTEGER NOT NULL DEFAULT 0",
  );
  yield* ensureProjectionThreadsColumn(
    "pending_user_input_count",
    "pending_user_input_count INTEGER NOT NULL DEFAULT 0",
  );
  yield* ensureProjectionThreadsColumn(
    "has_actionable_proposed_plan",
    "has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0",
  );
  yield* ensureProjectionThreadsColumn("last_known_pr_json", "last_known_pr_json TEXT");

  yield* ensureProjectionThreadMessagesColumn("source", "source TEXT NOT NULL DEFAULT 'native'");
  yield* ensureProjectionThreadMessagesColumn("skills_json", "skills_json TEXT");
  yield* ensureProjectionThreadMessagesColumn("mentions_json", "mentions_json TEXT");
  yield* ensureProjectionThreadMessagesColumn("dispatch_mode", "dispatch_mode TEXT");

  yield* sql`
    UPDATE projection_threads
    SET env_mode = CASE
      WHEN worktree_path IS NOT NULL THEN 'worktree'
      ELSE 'local'
    END
    WHERE env_mode IS NULL
      OR env_mode NOT IN ('local', 'worktree')
  `;

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_path = worktree_path
    WHERE associated_worktree_path IS NULL
      AND worktree_path IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_branch = branch
    WHERE associated_worktree_branch IS NULL
      AND branch IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET associated_worktree_ref = COALESCE(associated_worktree_branch, branch)
    WHERE associated_worktree_ref IS NULL
      AND COALESCE(associated_worktree_branch, branch) IS NOT NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET pending_approval_count = 0
    WHERE pending_approval_count IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET pending_user_input_count = 0
    WHERE pending_user_input_count IS NULL
  `;

  yield* sql`
    UPDATE projection_threads
    SET has_actionable_proposed_plan = 0
    WHERE has_actionable_proposed_plan IS NULL
  `;

  yield* sql`
    UPDATE projection_thread_messages
    SET source = 'native'
    WHERE source IS NULL
      OR TRIM(source) = ''
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads(parent_thread_id)
  `;
});
