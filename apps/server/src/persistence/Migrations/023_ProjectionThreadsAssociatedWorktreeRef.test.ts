import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const legacyMigrationLedgerRows = [
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
] as const;

layer("023_ProjectionThreadsAssociatedWorktreeRef", (it) => {
  it.effect(
    "repairs legacy migration ledgers that skipped the current thread metadata columns",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 16 });

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          default_model_selection_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-legacy',
          'Legacy project',
          '/tmp/project-legacy',
          '[]',
          '{"provider":"codex","model":"gpt-5.4"}',
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
        )
        VALUES
          (
            'thread-worktree',
            'project-legacy',
            'Worktree thread',
            '{"provider":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'feature/fix-upgrade',
            '/tmp/project-legacy/.worktrees/thread-worktree',
            NULL,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
            NULL
          ),
          (
            'thread-local',
            'project-legacy',
            'Local thread',
            '{"provider":"codex","model":"gpt-5.4"}',
            'full-access',
            'default',
            'main',
            NULL,
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
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-legacy',
          'thread-worktree',
          'turn-legacy',
          'assistant',
          'hello from the past',
          NULL,
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

        for (const [migrationId, name] of legacyMigrationLedgerRows) {
          yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, created_at, name)
          VALUES (${migrationId}, '2026-01-01T00:00:00.000Z', ${name})
        `;
        }

        const executedMigrations = yield* runMigrations({ toMigrationInclusive: 23 });

        assert.deepStrictEqual(executedMigrations, [
          [23, "ProjectionThreadsAssociatedWorktreeRef"],
        ]);

        const threadRows = yield* sql<{
          readonly threadId: string;
          readonly envMode: string;
          readonly associatedWorktreePath: string | null;
          readonly associatedWorktreeBranch: string | null;
          readonly associatedWorktreeRef: string | null;
          readonly forkSourceThreadId: string | null;
          readonly handoff: string | null;
        }>`
        SELECT
          thread_id AS "threadId",
          env_mode AS "envMode",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          fork_source_thread_id AS "forkSourceThreadId",
          handoff_json AS "handoff"
        FROM projection_threads
        ORDER BY thread_id ASC
      `;

        assert.deepStrictEqual(threadRows, [
          {
            threadId: "thread-local",
            envMode: "local",
            associatedWorktreePath: null,
            associatedWorktreeBranch: "main",
            associatedWorktreeRef: "main",
            forkSourceThreadId: null,
            handoff: null,
          },
          {
            threadId: "thread-worktree",
            envMode: "worktree",
            associatedWorktreePath: "/tmp/project-legacy/.worktrees/thread-worktree",
            associatedWorktreeBranch: "feature/fix-upgrade",
            associatedWorktreeRef: "feature/fix-upgrade",
            forkSourceThreadId: null,
            handoff: null,
          },
        ]);

        const messageRows = yield* sql<{
          readonly messageId: string;
          readonly skills: string | null;
          readonly mentions: string | null;
          readonly source: string;
        }>`
        SELECT
          message_id AS "messageId",
          skills_json AS "skills",
          mentions_json AS "mentions",
          source
        FROM projection_thread_messages
        ORDER BY message_id ASC
      `;

        assert.deepStrictEqual(messageRows, [
          {
            messageId: "message-legacy",
            skills: null,
            mentions: null,
            source: "native",
          },
        ]);
      }),
  );
});
