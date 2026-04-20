import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_RepairLegacyProjectionSchema", (it) => {
  it.effect(
    "repairs projection columns when legacy desktop builds already consumed ids 17-30",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 16 });

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project-1',
          'Project',
          '/repo/project',
          '{"provider":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'thread-1',
          'project-1',
          'Thread',
          '{"provider":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          'feature/test',
          '/repo/project/.worktrees/feature-test',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at,
          attachments_json
        ) VALUES (
          'message-1',
          'thread-1',
          NULL,
          'user',
          'Hello',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (17, 'ProjectionThreadsArchivedAt'),
          (18, 'ProjectionThreadsArchivedAtIndex'),
          (19, 'ProjectionSnapshotLookupIndexes'),
          (20, 'AuthAccessManagement'),
          (21, 'AuthSessionClientMetadata'),
          (22, 'AuthSessionLastConnectedAt'),
          (23, 'ProjectionThreadShellSummary'),
          (24, 'BackfillProjectionThreadShellSummary'),
          (25, 'ProjectionThreadsSubagents'),
          (26, 'ProjectionThreadShellSummary'),
          (27, 'BackfillProjectionThreadShellSummary'),
          (28, 'ProjectionProjectsKind'),
          (29, 'ProjectionThreadsLastKnownPr'),
          (30, 'ProjectionThreadMessagesDispatchMode')
      `;

        yield* runMigrations({ toMigrationInclusive: 31 });

        const repairedThreadRows = yield* sql<{
          readonly envMode: string | null;
          readonly associatedWorktreePath: string | null;
          readonly associatedWorktreeBranch: string | null;
          readonly associatedWorktreeRef: string | null;
          readonly handoffJson: string | null;
          readonly forkSourceThreadId: string | null;
          readonly pendingApprovalCount: number | null;
          readonly pendingUserInputCount: number | null;
          readonly hasActionableProposedPlan: number | null;
        }>`
        SELECT
          env_mode AS "envMode",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          handoff_json AS "handoffJson",
          fork_source_thread_id AS "forkSourceThreadId",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;

        assert.deepStrictEqual(repairedThreadRows, [
          {
            envMode: "worktree",
            associatedWorktreePath: "/repo/project/.worktrees/feature-test",
            associatedWorktreeBranch: "feature/test",
            associatedWorktreeRef: "feature/test",
            handoffJson: null,
            forkSourceThreadId: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
          },
        ]);

        const repairedMessageRows = yield* sql<{
          readonly source: string | null;
          readonly skillsJson: string | null;
          readonly mentionsJson: string | null;
          readonly dispatchMode: string | null;
        }>`
        SELECT
          source,
          skills_json AS "skillsJson",
          mentions_json AS "mentionsJson",
          dispatch_mode AS "dispatchMode"
        FROM projection_thread_messages
        WHERE message_id = 'message-1'
      `;

        assert.deepStrictEqual(repairedMessageRows, [
          {
            source: "native",
            skillsJson: null,
            mentionsJson: null,
            dispatchMode: null,
          },
        ]);
      }),
  );
});
