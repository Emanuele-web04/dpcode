import { DatabaseSync } from "node:sqlite";

import {
  CheckpointRef,
  ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationMessageRole,
  OrchestrationMessageSource,
  OrchestrationCheckpointFile,
  OrchestrationImportLegacyT3StateResult,
  OrchestrationProposedPlanId,
  OrchestrationThreadActivityTone,
  OrchestrationThreadPullRequest,
  ProviderMentionReference,
  ProviderSkillReference,
  ProjectId,
  ProjectKind,
  ProjectScript,
  ThreadHandoff,
  ThreadId,
  TurnDispatchMode,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import { workspaceRootsEqual } from "@t3tools/shared/threadWorkspace";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

import { resolveAttachmentPath } from "./attachmentStore.ts";
import { deriveServerPaths, ServerConfig, type ServerDerivedPaths } from "./config.ts";
import { LEGACY_T3_HOME_DIRNAME } from "./homeMigration.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";

export class LegacyStateImportError extends Data.TaggedError("LegacyStateImportError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isLegacyStateImportError(cause: unknown): cause is LegacyStateImportError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause as { readonly _tag?: unknown })._tag === "LegacyStateImportError"
  );
}

type SourceProjectSnapshot = {
  readonly id: ProjectId;
  readonly kind: ProjectKind;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: typeof ModelSelection.Type | null;
  readonly scripts: ReadonlyArray<typeof ProjectScript.Type>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
};

type SourceImportedMessage = {
  readonly messageId: string;
  readonly role: typeof OrchestrationMessageRole.Type;
  readonly text: string;
  readonly attachments: ReadonlyArray<typeof ChatAttachment.Type>;
  readonly skills: ReadonlyArray<typeof ProviderSkillReference.Type>;
  readonly mentions: ReadonlyArray<typeof ProviderMentionReference.Type>;
  readonly dispatchMode: typeof TurnDispatchMode.Type | null;
  readonly turnId: string | null;
  readonly streaming: boolean;
  readonly source: typeof OrchestrationMessageSource.Type;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type SourceThreadActivity = {
  readonly id: string;
  readonly turnId: string | null;
  readonly tone: typeof OrchestrationThreadActivityTone.Type;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly sequence: number | null;
  readonly createdAt: string;
};

type SourceProposedPlan = {
  readonly id: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type SourceCheckpoint = {
  readonly turnId: string;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly status: "ready" | "missing" | "error";
  readonly files: ReadonlyArray<typeof OrchestrationCheckpointFile.Type>;
  readonly assistantMessageId: string | null;
  readonly completedAt: string;
};

type SourceThreadSnapshot = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: typeof ModelSelection.Type;
  readonly runtimeMode: "approval-required" | "full-access";
  readonly interactionMode: "default" | "plan";
  readonly envMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly subagentAgentId: string | null;
  readonly subagentNickname: string | null;
  readonly subagentRole: string | null;
  readonly lastKnownPr: typeof OrchestrationThreadPullRequest.Type | null;
  readonly handoff: typeof ThreadHandoff.Type | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly messages: ReadonlyArray<SourceImportedMessage>;
  readonly activities: ReadonlyArray<SourceThreadActivity>;
  readonly proposedPlans: ReadonlyArray<SourceProposedPlan>;
  readonly checkpoints: ReadonlyArray<SourceCheckpoint>;
};

type SourceSnapshot = {
  readonly projects: ReadonlyArray<SourceProjectSnapshot>;
  readonly threads: ReadonlyArray<SourceThreadSnapshot>;
};

type ImportCounters = {
  importedProjects: number;
  mappedProjects: number;
  skippedProjects: number;
  importedThreads: number;
  skippedThreads: number;
  importedMessages: number;
  importedActivities: number;
  importedProposedPlans: number;
  importedCheckpoints: number;
  copiedAttachments: number;
  skippedAttachments: number;
  missingAttachments: number;
};

type SourcePathCandidate = ServerDerivedPaths & {
  readonly baseDir: string;
};

type SourceProjectRow = {
  readonly projectId: string;
  readonly kind: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelectionJson: string | null;
  readonly scriptsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
};

type SourceThreadRow = {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelectionJson: string;
  readonly runtimeMode: string;
  readonly interactionMode: string;
  readonly envMode: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
  readonly parentThreadId: string | null;
  readonly subagentAgentId: string | null;
  readonly subagentNickname: string | null;
  readonly subagentRole: string | null;
  readonly lastKnownPrJson: string | null;
  readonly handoffJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
};

type SourceMessageRow = {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly attachmentsJson: string | null;
  readonly skillsJson: string | null;
  readonly mentionsJson: string | null;
  readonly dispatchMode: string | null;
  readonly isStreaming: number | null;
  readonly source: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type SourceActivityRow = {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payloadJson: string;
  readonly sequence: number | null;
  readonly createdAt: string;
};

type SourceProposedPlanRow = {
  readonly planId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type SourceCheckpointRow = {
  readonly threadId: string;
  readonly turnId: string;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: string;
  readonly checkpointStatus: string;
  readonly checkpointFilesJson: string;
  readonly assistantMessageId: string | null;
  readonly completedAt: string;
};

const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeProjectScripts = Schema.decodeUnknownSync(Schema.Array(ProjectScript));
const decodeChatAttachments = Schema.decodeUnknownSync(Schema.Array(ChatAttachment));
const decodeProviderSkills = Schema.decodeUnknownSync(Schema.Array(ProviderSkillReference));
const decodeProviderMentions = Schema.decodeUnknownSync(Schema.Array(ProviderMentionReference));
const decodeThreadHandoff = Schema.decodeUnknownSync(ThreadHandoff);
const decodeThreadPullRequest = Schema.decodeUnknownSync(OrchestrationThreadPullRequest);
const decodeCheckpointFiles = Schema.decodeUnknownSync(Schema.Array(OrchestrationCheckpointFile));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.Unknown);
const asCommandId = () => CommandId.makeUnsafe(`import-legacy-t3:${crypto.randomUUID()}`);

class SourceDatabaseReader {
  private tableNames: Set<string> | null = null;
  private readonly columnsByTable = new Map<string, Set<string>>();

  constructor(private readonly db: DatabaseSync) {}

  all<T>(query: string): ReadonlyArray<T> {
    return this.db.prepare(query).all() as unknown as ReadonlyArray<T>;
  }

  hasTable(tableName: string): boolean {
    if (this.tableNames === null) {
      this.tableNames = new Set(
        this.all<{ readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ).map((row) => row.name),
      );
    }
    return this.tableNames.has(tableName);
  }

  hasColumn(tableName: string, columnName: string): boolean {
    let columns = this.columnsByTable.get(tableName);
    if (!columns) {
      if (!this.hasTable(tableName)) {
        columns = new Set();
      } else {
        columns = new Set(
          this.all<{ readonly name: string }>(`PRAGMA table_info("${tableName}")`).map(
            (row) => row.name,
          ),
        );
      }
      this.columnsByTable.set(tableName, columns);
    }
    return columns.has(columnName);
  }
}

function requiredTable(reader: SourceDatabaseReader, tableName: string): void {
  if (reader.hasTable(tableName)) {
    return;
  }
  throw new LegacyStateImportError({
    message: `The legacy T3 database is missing the required table '${tableName}'.`,
  });
}

function selectColumn(
  reader: SourceDatabaseReader,
  tableName: string,
  columnName: string,
  alias: string,
  fallbackSql = "NULL",
): string {
  return reader.hasColumn(tableName, columnName)
    ? `"${columnName}" AS "${alias}"`
    : `${fallbackSql} AS "${alias}"`;
}

function decodeJsonColumn<T>(
  raw: string | null | undefined,
  decode: (value: unknown) => T,
  fallback: T,
  fieldName: string,
): T {
  if (raw === null || raw === undefined || raw.length === 0) {
    return fallback;
  }
  try {
    return decode(JSON.parse(raw));
  } catch (cause) {
    throw new LegacyStateImportError({
      message: `Failed to decode '${fieldName}' from the legacy T3 DB.`,
      cause,
    });
  }
}

const asMessageId = (value: string) => MessageId.makeUnsafe(value);
const asEventId = (value: string) => EventId.makeUnsafe(value);
const asCheckpointRef = (value: string) => CheckpointRef.makeUnsafe(value);
const asNonNegativeInt = (value: number) => NonNegativeInt.makeUnsafe(value);
const asTurnId = (value: string) => TurnId.makeUnsafe(value);
const asTrimmedNonEmptyString = (value: string) => TrimmedNonEmptyString.makeUnsafe(value);
const asOptionalTrimmedNonEmptyString = (value: string | null) =>
  value === null ? null : asTrimmedNonEmptyString(value);
const asProposedPlanId = (value: string) => OrchestrationProposedPlanId.makeUnsafe(value);

function maxIso(values: ReadonlyArray<string>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (latest === null || latest.localeCompare(value) < 0) {
      latest = value;
    }
  }
  return latest;
}

function chunkArray<T>(
  items: ReadonlyArray<T>,
  chunkSize: number,
): ReadonlyArray<ReadonlyArray<T>> {
  if (items.length === 0) {
    return [];
  }
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function readSourceProjects(reader: SourceDatabaseReader): ReadonlyArray<SourceProjectSnapshot> {
  const tableName = "projection_projects";
  requiredTable(reader, tableName);
  const rows = reader.all<SourceProjectRow>(`
    SELECT
      ${selectColumn(reader, tableName, "project_id", "projectId")},
      ${selectColumn(reader, tableName, "kind", "kind", "'project'")},
      ${selectColumn(reader, tableName, "title", "title", "''")},
      ${selectColumn(reader, tableName, "workspace_root", "workspaceRoot", "''")},
      ${selectColumn(
        reader,
        tableName,
        "default_model_selection_json",
        "defaultModelSelectionJson",
      )},
      ${selectColumn(reader, tableName, "scripts_json", "scriptsJson", "'[]'")},
      ${selectColumn(reader, tableName, "created_at", "createdAt", "''")},
      ${selectColumn(reader, tableName, "updated_at", "updatedAt", "''")},
      ${selectColumn(reader, tableName, "deleted_at", "deletedAt")}
    FROM "${tableName}"
    ORDER BY "created_at" ASC, "project_id" ASC
  `);

  return rows.map((row) => ({
    id: ProjectId.makeUnsafe(row.projectId),
    kind: row.kind === "chat" ? "chat" : "project",
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: decodeJsonColumn(
      row.defaultModelSelectionJson,
      decodeModelSelection,
      null,
      "projection_projects.default_model_selection_json",
    ),
    scripts: decodeJsonColumn(
      row.scriptsJson,
      decodeProjectScripts,
      [],
      "projection_projects.scripts_json",
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  }));
}

function readSourceThreads(reader: SourceDatabaseReader): ReadonlyArray<SourceThreadRow> {
  const tableName = "projection_threads";
  requiredTable(reader, tableName);
  return reader.all<SourceThreadRow>(`
    SELECT
      ${selectColumn(reader, tableName, "thread_id", "threadId")},
      ${selectColumn(reader, tableName, "project_id", "projectId")},
      ${selectColumn(reader, tableName, "title", "title", "''")},
      ${selectColumn(reader, tableName, "model_selection_json", "modelSelectionJson", "'{}'")},
      ${selectColumn(reader, tableName, "runtime_mode", "runtimeMode", "'full-access'")},
      ${selectColumn(reader, tableName, "interaction_mode", "interactionMode", "'default'")},
      ${selectColumn(reader, tableName, "env_mode", "envMode", "'local'")},
      ${selectColumn(reader, tableName, "branch", "branch")},
      ${selectColumn(reader, tableName, "worktree_path", "worktreePath")},
      ${selectColumn(reader, tableName, "associated_worktree_path", "associatedWorktreePath")},
      ${selectColumn(reader, tableName, "associated_worktree_branch", "associatedWorktreeBranch")},
      ${selectColumn(reader, tableName, "associated_worktree_ref", "associatedWorktreeRef")},
      ${selectColumn(reader, tableName, "parent_thread_id", "parentThreadId")},
      ${selectColumn(reader, tableName, "subagent_agent_id", "subagentAgentId")},
      ${selectColumn(reader, tableName, "subagent_nickname", "subagentNickname")},
      ${selectColumn(reader, tableName, "subagent_role", "subagentRole")},
      ${selectColumn(reader, tableName, "last_known_pr_json", "lastKnownPrJson")},
      ${selectColumn(reader, tableName, "handoff_json", "handoffJson")},
      ${selectColumn(reader, tableName, "created_at", "createdAt", "''")},
      ${selectColumn(reader, tableName, "updated_at", "updatedAt", "''")},
      ${selectColumn(reader, tableName, "archived_at", "archivedAt")},
      ${selectColumn(reader, tableName, "deleted_at", "deletedAt")}
    FROM "${tableName}"
    ORDER BY "created_at" ASC, "thread_id" ASC
  `);
}

function readSourceMessages(
  reader: SourceDatabaseReader,
): ReadonlyMap<ThreadId, ReadonlyArray<SourceImportedMessage>> {
  const tableName = "projection_thread_messages";
  requiredTable(reader, tableName);
  const rows = reader.all<SourceMessageRow>(`
    SELECT
      ${selectColumn(reader, tableName, "message_id", "messageId")},
      ${selectColumn(reader, tableName, "thread_id", "threadId")},
      ${selectColumn(reader, tableName, "role", "role", "''")},
      ${selectColumn(reader, tableName, "text", "text", "''")},
      ${selectColumn(reader, tableName, "turn_id", "turnId")},
      ${selectColumn(reader, tableName, "attachments_json", "attachmentsJson")},
      ${selectColumn(reader, tableName, "skills_json", "skillsJson")},
      ${selectColumn(reader, tableName, "mentions_json", "mentionsJson")},
      ${selectColumn(reader, tableName, "dispatch_mode", "dispatchMode")},
      ${selectColumn(reader, tableName, "is_streaming", "isStreaming", "0")},
      ${selectColumn(reader, tableName, "source", "source", "'native'")},
      ${selectColumn(reader, tableName, "created_at", "createdAt", "''")},
      ${selectColumn(reader, tableName, "updated_at", "updatedAt", "created_at")}
    FROM "${tableName}"
    ORDER BY "thread_id" ASC, "created_at" ASC, "message_id" ASC
  `);

  const messagesByThread = new Map<ThreadId, SourceImportedMessage[]>();
  for (const row of rows) {
    const role =
      row.role === "assistant" || row.role === "system" || row.role === "user" ? row.role : null;
    if (role === null) {
      continue;
    }
    const source =
      row.source === "handoff-import" || row.source === "fork-import" || row.source === "native"
        ? row.source
        : "native";
    const dispatchMode =
      row.dispatchMode === "queue" || row.dispatchMode === "steer" ? row.dispatchMode : null;
    const threadId = ThreadId.makeUnsafe(row.threadId);
    const entries = messagesByThread.get(threadId) ?? [];
    entries.push({
      messageId: row.messageId,
      role,
      text: row.text,
      turnId: row.turnId,
      attachments: decodeJsonColumn(
        row.attachmentsJson,
        decodeChatAttachments,
        [],
        "projection_thread_messages.attachments_json",
      ),
      skills: decodeJsonColumn(
        row.skillsJson,
        decodeProviderSkills,
        [],
        "projection_thread_messages.skills_json",
      ),
      mentions: decodeJsonColumn(
        row.mentionsJson,
        decodeProviderMentions,
        [],
        "projection_thread_messages.mentions_json",
      ),
      dispatchMode,
      streaming: row.isStreaming === 1,
      source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    messagesByThread.set(threadId, entries);
  }
  return messagesByThread;
}

function readSourceActivities(
  reader: SourceDatabaseReader,
): ReadonlyMap<ThreadId, ReadonlyArray<SourceThreadActivity>> {
  const tableName = "projection_thread_activities";
  if (!reader.hasTable(tableName)) {
    return new Map();
  }
  const rows = reader.all<SourceActivityRow>(`
    SELECT
      ${selectColumn(reader, tableName, "activity_id", "activityId")},
      ${selectColumn(reader, tableName, "thread_id", "threadId")},
      ${selectColumn(reader, tableName, "turn_id", "turnId")},
      ${selectColumn(reader, tableName, "tone", "tone", "'info'")},
      ${selectColumn(reader, tableName, "kind", "kind", "''")},
      ${selectColumn(reader, tableName, "summary", "summary", "''")},
      ${selectColumn(reader, tableName, "payload_json", "payloadJson", "'null'")},
      ${selectColumn(reader, tableName, "sequence", "sequence")},
      ${selectColumn(reader, tableName, "created_at", "createdAt", "''")}
    FROM "${tableName}"
    ORDER BY "thread_id" ASC, "sequence" ASC, "created_at" ASC, "activity_id" ASC
  `);

  const activitiesByThread = new Map<ThreadId, SourceThreadActivity[]>();
  for (const row of rows) {
    const tone =
      row.tone === "tool" || row.tone === "approval" || row.tone === "error" ? row.tone : "info";
    const threadId = ThreadId.makeUnsafe(row.threadId);
    const entries = activitiesByThread.get(threadId) ?? [];
    entries.push({
      id: row.activityId,
      turnId: row.turnId,
      tone,
      kind: row.kind,
      summary: row.summary,
      payload: decodeJsonColumn(
        row.payloadJson,
        decodeUnknownJson,
        null,
        "projection_thread_activities.payload_json",
      ),
      sequence: row.sequence,
      createdAt: row.createdAt,
    });
    activitiesByThread.set(threadId, entries);
  }
  return activitiesByThread;
}

function readSourceProposedPlans(
  reader: SourceDatabaseReader,
): ReadonlyMap<ThreadId, ReadonlyArray<SourceProposedPlan>> {
  const tableName = "projection_thread_proposed_plans";
  if (!reader.hasTable(tableName)) {
    return new Map();
  }
  const rows = reader.all<SourceProposedPlanRow>(`
    SELECT
      ${selectColumn(reader, tableName, "plan_id", "planId")},
      ${selectColumn(reader, tableName, "thread_id", "threadId")},
      ${selectColumn(reader, tableName, "turn_id", "turnId")},
      ${selectColumn(reader, tableName, "plan_markdown", "planMarkdown", "''")},
      ${selectColumn(reader, tableName, "implemented_at", "implementedAt")},
      ${selectColumn(reader, tableName, "implementation_thread_id", "implementationThreadId")},
      ${selectColumn(reader, tableName, "created_at", "createdAt", "''")},
      ${selectColumn(reader, tableName, "updated_at", "updatedAt", "''")}
    FROM "${tableName}"
    ORDER BY "thread_id" ASC, "created_at" ASC, "plan_id" ASC
  `);

  const plansByThread = new Map<ThreadId, SourceProposedPlan[]>();
  for (const row of rows) {
    const threadId = ThreadId.makeUnsafe(row.threadId);
    const entries = plansByThread.get(threadId) ?? [];
    entries.push({
      id: row.planId,
      turnId: row.turnId,
      planMarkdown: row.planMarkdown,
      implementedAt: row.implementedAt,
      implementationThreadId:
        row.implementationThreadId === null
          ? null
          : ThreadId.makeUnsafe(row.implementationThreadId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    plansByThread.set(threadId, entries);
  }
  return plansByThread;
}

function readSourceCheckpoints(
  reader: SourceDatabaseReader,
): ReadonlyMap<ThreadId, ReadonlyArray<SourceCheckpoint>> {
  const tableName = "projection_turns";
  if (!reader.hasTable(tableName)) {
    return new Map();
  }
  const rows = reader.all<SourceCheckpointRow>(`
    SELECT
      ${selectColumn(reader, tableName, "thread_id", "threadId")},
      ${selectColumn(reader, tableName, "turn_id", "turnId")},
      ${selectColumn(reader, tableName, "checkpoint_turn_count", "checkpointTurnCount")},
      ${selectColumn(reader, tableName, "checkpoint_ref", "checkpointRef")},
      ${selectColumn(reader, tableName, "checkpoint_status", "checkpointStatus")},
      ${selectColumn(reader, tableName, "checkpoint_files_json", "checkpointFilesJson", "'[]'")},
      ${selectColumn(reader, tableName, "assistant_message_id", "assistantMessageId")},
      ${selectColumn(reader, tableName, "completed_at", "completedAt")}
    FROM "${tableName}"
    WHERE "turn_id" IS NOT NULL
      AND "checkpoint_turn_count" IS NOT NULL
      AND "checkpoint_ref" IS NOT NULL
      AND "checkpoint_status" IS NOT NULL
      AND "completed_at" IS NOT NULL
    ORDER BY "thread_id" ASC, "checkpoint_turn_count" ASC, "turn_id" ASC
  `);

  const checkpointsByThread = new Map<ThreadId, SourceCheckpoint[]>();
  for (const row of rows) {
    const status =
      row.checkpointStatus === "missing" || row.checkpointStatus === "error"
        ? row.checkpointStatus
        : "ready";
    const threadId = ThreadId.makeUnsafe(row.threadId);
    const entries = checkpointsByThread.get(threadId) ?? [];
    entries.push({
      turnId: row.turnId,
      checkpointTurnCount: row.checkpointTurnCount,
      checkpointRef: row.checkpointRef,
      status,
      files: decodeJsonColumn(
        row.checkpointFilesJson,
        decodeCheckpointFiles,
        [],
        "projection_turns.checkpoint_files_json",
      ),
      assistantMessageId: row.assistantMessageId,
      completedAt: row.completedAt,
    });
    checkpointsByThread.set(threadId, entries);
  }
  return checkpointsByThread;
}

function readSourceSnapshot(sourceDbPath: string): SourceSnapshot {
  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    const reader = new SourceDatabaseReader(db);
    const projects = readSourceProjects(reader);
    const threadRows = readSourceThreads(reader);
    const messagesByThread = readSourceMessages(reader);
    const activitiesByThread = readSourceActivities(reader);
    const proposedPlansByThread = readSourceProposedPlans(reader);
    const checkpointsByThread = readSourceCheckpoints(reader);

    const threads: SourceThreadSnapshot[] = threadRows.map((row) => ({
      id: ThreadId.makeUnsafe(row.threadId),
      projectId: ProjectId.makeUnsafe(row.projectId),
      title: row.title,
      modelSelection: decodeJsonColumn(
        row.modelSelectionJson,
        decodeModelSelection,
        { provider: "codex", model: "gpt-5-codex" },
        "projection_threads.model_selection_json",
      ),
      runtimeMode: row.runtimeMode === "approval-required" ? "approval-required" : "full-access",
      interactionMode: row.interactionMode === "plan" ? "plan" : "default",
      envMode: row.envMode === "worktree" ? "worktree" : "local",
      branch: row.branch,
      worktreePath: row.worktreePath,
      associatedWorktreePath: row.associatedWorktreePath,
      associatedWorktreeBranch: row.associatedWorktreeBranch,
      associatedWorktreeRef: row.associatedWorktreeRef,
      parentThreadId: row.parentThreadId === null ? null : ThreadId.makeUnsafe(row.parentThreadId),
      subagentAgentId: row.subagentAgentId,
      subagentNickname: row.subagentNickname,
      subagentRole: row.subagentRole,
      lastKnownPr: decodeJsonColumn(
        row.lastKnownPrJson,
        decodeThreadPullRequest,
        null,
        "projection_threads.last_known_pr_json",
      ),
      handoff: decodeJsonColumn(
        row.handoffJson,
        decodeThreadHandoff,
        null,
        "projection_threads.handoff_json",
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
      deletedAt: row.deletedAt,
      messages: messagesByThread.get(ThreadId.makeUnsafe(row.threadId)) ?? [],
      activities: activitiesByThread.get(ThreadId.makeUnsafe(row.threadId)) ?? [],
      proposedPlans: proposedPlansByThread.get(ThreadId.makeUnsafe(row.threadId)) ?? [],
      checkpoints: checkpointsByThread.get(ThreadId.makeUnsafe(row.threadId)) ?? [],
    }));

    return {
      projects,
      threads,
    };
  } finally {
    db.close();
  }
}

const resolveSourcePaths = Effect.fn(function* (input: {
  readonly sourceBaseDir?: string;
  readonly homeDir: string;
  readonly devUrl: URL | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceBaseDir = path.resolve(
    input.sourceBaseDir?.trim().length
      ? input.sourceBaseDir.trim()
      : path.join(input.homeDir, LEGACY_T3_HOME_DIRNAME),
  );

  const candidates: ReadonlyArray<SourcePathCandidate> = yield* Effect.all(
    [
      deriveServerPaths(sourceBaseDir, undefined).pipe(
        Effect.map((paths) => ({ baseDir: sourceBaseDir, ...paths })),
      ),
      ...(input.devUrl === undefined
        ? []
        : [
            deriveServerPaths(sourceBaseDir, input.devUrl).pipe(
              Effect.map((paths) => ({ baseDir: sourceBaseDir, ...paths })),
            ),
          ]),
    ],
    { concurrency: "unbounded" },
  );

  const uniqueCandidates = candidates.filter(
    (candidate, index, allCandidates) =>
      allCandidates.findIndex((entry) => entry.stateDir === candidate.stateDir) === index,
  );

  for (const candidate of uniqueCandidates) {
    if (yield* fs.exists(candidate.dbPath)) {
      return candidate;
    }
  }

  return yield* new LegacyStateImportError({
    message: `No T3 Code state database was found under '${sourceBaseDir}'. Expected 'userdata/state.sqlite'${
      input.devUrl ? " or 'dev/state.sqlite'" : ""
    }.`,
  });
});

function findMappedProjectId(input: {
  readonly sourceProject: SourceProjectSnapshot;
  readonly targetProjects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly kind: ProjectKind;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly deletedAt: string | null;
  }>;
  readonly platform: string;
}): ProjectId | null {
  const matchingTarget = input.targetProjects.find((targetProject) => {
    if (targetProject.deletedAt !== null) {
      return false;
    }
    if (
      !workspaceRootsEqual(targetProject.workspaceRoot, input.sourceProject.workspaceRoot, {
        platform: input.platform,
      })
    ) {
      return false;
    }
    if (targetProject.kind === input.sourceProject.kind) {
      return true;
    }
    return input.sourceProject.kind === "chat" && targetProject.title.trim() === "Home";
  });
  return matchingTarget?.id ?? null;
}

const filterImportableAttachments = Effect.fn(function* (input: {
  readonly attachments: ReadonlyArray<typeof ChatAttachment.Type>;
  readonly sourceAttachmentsDir: string;
  readonly targetAttachmentsDir: string;
  readonly counters: ImportCounters;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const keptAttachments = yield* Effect.forEach(
    input.attachments,
    (attachment) =>
      Effect.gen(function* () {
        const sourcePath = resolveAttachmentPath({
          attachmentsDir: input.sourceAttachmentsDir,
          attachment,
        });
        const targetPath = resolveAttachmentPath({
          attachmentsDir: input.targetAttachmentsDir,
          attachment,
        });
        if (!sourcePath || !targetPath) {
          input.counters.missingAttachments += 1;
          return null;
        }
        if (!(yield* fs.exists(sourcePath))) {
          input.counters.missingAttachments += 1;
          return null;
        }
        if (yield* fs.exists(targetPath)) {
          input.counters.skippedAttachments += 1;
          return attachment;
        }
        yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
        yield* fs.copyFile(sourcePath, targetPath);
        input.counters.copiedAttachments += 1;
        return attachment;
      }),
    { concurrency: 1 },
  );

  return keptAttachments.flatMap((attachment) => (attachment ? [attachment] : []));
});

export const importLegacyT3State = Effect.fn(function* (input: {
  readonly sourceBaseDir?: string;
}) {
  const serverConfig = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const sourcePaths = yield* resolveSourcePaths({
    homeDir: serverConfig.homeDir,
    devUrl: serverConfig.devUrl,
    ...(input.sourceBaseDir !== undefined ? { sourceBaseDir: input.sourceBaseDir } : {}),
  });

  const sourceSnapshot = yield* Effect.try({
    try: () => readSourceSnapshot(sourcePaths.dbPath),
    catch: (cause): LegacyStateImportError =>
      isLegacyStateImportError(cause)
        ? cause
        : new LegacyStateImportError({
            message: `Failed to read the legacy T3 database at '${sourcePaths.dbPath}'.`,
            cause,
          }),
  });

  const currentReadModel = yield* orchestrationEngine.getReadModel();
  const counters: ImportCounters = {
    importedProjects: 0,
    mappedProjects: 0,
    skippedProjects: 0,
    importedThreads: 0,
    skippedThreads: 0,
    importedMessages: 0,
    importedActivities: 0,
    importedProposedPlans: 0,
    importedCheckpoints: 0,
    copiedAttachments: 0,
    skippedAttachments: 0,
    missingAttachments: 0,
  };

  const targetProjects: Array<{
    readonly id: ProjectId;
    readonly kind: ProjectKind;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly deletedAt: string | null;
  }> = currentReadModel.projects.map((project) => ({
    id: project.id,
    kind: project.kind ?? "project",
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    deletedAt: project.deletedAt,
  }));
  const existingProjectIds = new Set(currentReadModel.projects.map((project) => project.id));
  const existingThreadsById = new Map(
    currentReadModel.threads.map((thread) => [thread.id, thread]),
  );
  const targetProjectIdBySourceProjectId = new Map<ProjectId, ProjectId>();

  for (const sourceProject of sourceSnapshot.projects) {
    if (sourceProject.deletedAt !== null) {
      counters.skippedProjects += 1;
      continue;
    }

    const mappedProjectId = findMappedProjectId({
      sourceProject,
      targetProjects,
      platform: process.platform,
    });
    if (mappedProjectId) {
      counters.mappedProjects += 1;
      targetProjectIdBySourceProjectId.set(sourceProject.id, mappedProjectId);
      continue;
    }

    if (existingProjectIds.has(sourceProject.id)) {
      counters.skippedProjects += 1;
      continue;
    }

    yield* orchestrationEngine.dispatch({
      type: "project.create",
      commandId: asCommandId(),
      projectId: sourceProject.id,
      kind: sourceProject.kind,
      title: asTrimmedNonEmptyString(sourceProject.title),
      workspaceRoot: asTrimmedNonEmptyString(sourceProject.workspaceRoot),
      defaultModelSelection: sourceProject.defaultModelSelection,
      createdAt: sourceProject.createdAt,
    });

    if (sourceProject.scripts.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "project.meta.update",
        commandId: asCommandId(),
        projectId: sourceProject.id,
        scripts: sourceProject.scripts,
      });
    }

    existingProjectIds.add(sourceProject.id);
    targetProjects.push({
      id: sourceProject.id,
      kind: sourceProject.kind,
      title: sourceProject.title,
      workspaceRoot: sourceProject.workspaceRoot,
      deletedAt: null,
    });
    targetProjectIdBySourceProjectId.set(sourceProject.id, sourceProject.id);
    counters.importedProjects += 1;
  }

  const activeSourceThreads = sourceSnapshot.threads.filter((thread) => thread.deletedAt === null);
  for (const sourceThread of activeSourceThreads) {
    const targetProjectId = targetProjectIdBySourceProjectId.get(sourceThread.projectId);
    if (!targetProjectId) {
      counters.skippedThreads += 1;
      continue;
    }
    const existingThread = existingThreadsById.get(sourceThread.id) ?? null;
    if (existingThread === null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: asCommandId(),
        threadId: sourceThread.id,
        projectId: targetProjectId,
        title: asTrimmedNonEmptyString(sourceThread.title),
        modelSelection: sourceThread.modelSelection,
        runtimeMode: sourceThread.runtimeMode,
        interactionMode: sourceThread.interactionMode,
        envMode: sourceThread.envMode,
        branch: asOptionalTrimmedNonEmptyString(sourceThread.branch),
        worktreePath: asOptionalTrimmedNonEmptyString(sourceThread.worktreePath),
        associatedWorktreePath: asOptionalTrimmedNonEmptyString(
          sourceThread.associatedWorktreePath,
        ),
        associatedWorktreeBranch: asOptionalTrimmedNonEmptyString(
          sourceThread.associatedWorktreeBranch,
        ),
        associatedWorktreeRef: asOptionalTrimmedNonEmptyString(sourceThread.associatedWorktreeRef),
        parentThreadId: sourceThread.parentThreadId,
        subagentAgentId: asOptionalTrimmedNonEmptyString(sourceThread.subagentAgentId),
        subagentNickname: asOptionalTrimmedNonEmptyString(sourceThread.subagentNickname),
        subagentRole: asOptionalTrimmedNonEmptyString(sourceThread.subagentRole),
        lastKnownPr: sourceThread.lastKnownPr,
        createdAt: sourceThread.createdAt,
      });

      if (sourceThread.handoff !== null) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: asCommandId(),
          threadId: sourceThread.id,
          handoff: sourceThread.handoff,
        });
      }

      counters.importedThreads += 1;
    } else {
      counters.skippedThreads += 1;
    }

    const importedMessages = yield* Effect.forEach(
      sourceThread.messages,
      (message) =>
        Effect.gen(function* () {
          const attachments = yield* filterImportableAttachments({
            attachments: message.attachments,
            sourceAttachmentsDir: sourcePaths.attachmentsDir,
            targetAttachmentsDir: serverConfig.attachmentsDir,
            counters,
          });
          return {
            messageId: asMessageId(message.messageId),
            role: message.role,
            text: message.text,
            turnId: message.turnId === null ? null : asTurnId(message.turnId),
            streaming: message.streaming,
            source: message.source,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(message.skills.length > 0 ? { skills: message.skills } : {}),
            ...(message.mentions.length > 0 ? { mentions: message.mentions } : {}),
            ...(message.dispatchMode !== null ? { dispatchMode: message.dispatchMode } : {}),
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          };
        }),
      { concurrency: 1 },
    );

    for (const messageChunk of chunkArray(importedMessages, 250)) {
      const createdAt =
        maxIso(messageChunk.map((message) => message.updatedAt)) ?? sourceThread.updatedAt;
      yield* orchestrationEngine.dispatch({
        type: "thread.messages.import",
        commandId: asCommandId(),
        threadId: sourceThread.id,
        messages: messageChunk,
        createdAt,
      });
      counters.importedMessages += messageChunk.length;
    }

    const importedProposedPlans = sourceThread.proposedPlans.map((proposedPlan) => ({
      id: asProposedPlanId(proposedPlan.id),
      turnId: proposedPlan.turnId === null ? null : asTurnId(proposedPlan.turnId),
      planMarkdown: asTrimmedNonEmptyString(proposedPlan.planMarkdown),
      implementedAt: proposedPlan.implementedAt,
      implementationThreadId: proposedPlan.implementationThreadId,
      createdAt: proposedPlan.createdAt,
      updatedAt: proposedPlan.updatedAt,
    }));

    for (const proposedPlanChunk of chunkArray(importedProposedPlans, 100)) {
      const createdAt =
        maxIso(proposedPlanChunk.map((proposedPlan) => proposedPlan.updatedAt)) ??
        sourceThread.updatedAt;
      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plans.import",
        commandId: asCommandId(),
        threadId: sourceThread.id,
        proposedPlans: proposedPlanChunk,
        createdAt,
      });
      counters.importedProposedPlans += proposedPlanChunk.length;
    }

    const importedActivities = sourceThread.activities.map((activity) => ({
      id: asEventId(activity.id),
      tone: activity.tone,
      kind: asTrimmedNonEmptyString(activity.kind),
      summary: asTrimmedNonEmptyString(activity.summary),
      payload: activity.payload,
      turnId: activity.turnId === null ? null : asTurnId(activity.turnId),
      ...(activity.sequence !== null ? { sequence: asNonNegativeInt(activity.sequence) } : {}),
      createdAt: activity.createdAt,
    }));

    for (const activityChunk of chunkArray(importedActivities, 500)) {
      const createdAt =
        maxIso(activityChunk.map((activity) => activity.createdAt)) ?? sourceThread.updatedAt;
      yield* orchestrationEngine.dispatch({
        type: "thread.activities.import",
        commandId: asCommandId(),
        threadId: sourceThread.id,
        activities: activityChunk,
        createdAt,
      });
      counters.importedActivities += activityChunk.length;
    }

    for (const checkpoint of sourceThread.checkpoints) {
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: asCommandId(),
        threadId: sourceThread.id,
        turnId: asTurnId(checkpoint.turnId),
        checkpointTurnCount: asNonNegativeInt(checkpoint.checkpointTurnCount),
        checkpointRef: asCheckpointRef(checkpoint.checkpointRef),
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.assistantMessageId !== null
          ? { assistantMessageId: asMessageId(checkpoint.assistantMessageId) }
          : {}),
        completedAt: checkpoint.completedAt,
        createdAt: checkpoint.completedAt,
      });
      counters.importedCheckpoints += 1;
    }

    if (sourceThread.archivedAt !== null && existingThread?.archivedAt == null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.archive",
        commandId: asCommandId(),
        threadId: sourceThread.id,
      });
    }
  }

  return {
    sourceBaseDir: asTrimmedNonEmptyString(sourcePaths.baseDir),
    sourceStateDir: asTrimmedNonEmptyString(sourcePaths.stateDir),
    ...counters,
  } satisfies typeof OrchestrationImportLegacyT3StateResult.Type;
});
