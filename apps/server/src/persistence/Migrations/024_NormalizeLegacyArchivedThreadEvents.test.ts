import { CommandId, EventId, OrchestrationEvent, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

layer("024_NormalizeLegacyArchivedThreadEvents", (it) => {
  it.effect("rewrites legacy archived thread events into decodable meta updates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 23 });

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            ${EventId.makeUnsafe("evt-thread-archived")},
            ${"thread"},
            ${ThreadId.makeUnsafe("thread-archived")},
            ${0},
            ${"thread.archived"},
            ${"2026-01-01T00:00:00.000Z"},
            ${CommandId.makeUnsafe("cmd-thread-archived")},
            ${null},
            ${null},
            ${"client"},
            ${JSON.stringify({
              threadId: "thread-archived",
              archivedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            })},
            ${"{}"}
          ),
          (
            ${EventId.makeUnsafe("evt-thread-unarchived")},
            ${"thread"},
            ${ThreadId.makeUnsafe("thread-unarchived")},
            ${0},
            ${"thread.unarchived"},
            ${"2026-01-02T00:00:00.000Z"},
            ${CommandId.makeUnsafe("cmd-thread-unarchived")},
            ${null},
            ${null},
            ${"client"},
            ${JSON.stringify({
              threadId: "thread-unarchived",
              unarchivedAt: "2026-01-02T00:00:00.000Z",
            })},
            ${"{}"}
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 24 });

      const normalizedRows = yield* sql<{
        readonly sequence: number;
        readonly eventId: string;
        readonly type: string;
        readonly aggregateKind: "project" | "thread";
        readonly aggregateId: string;
        readonly occurredAt: string;
        readonly commandId: string | null;
        readonly causationEventId: string | null;
        readonly correlationId: string | null;
        readonly payload: string;
        readonly metadata: string;
      }>`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE event_id IN (
          ${EventId.makeUnsafe("evt-thread-archived")},
          ${EventId.makeUnsafe("evt-thread-unarchived")}
        )
        ORDER BY event_id ASC
      `;

      assert.deepStrictEqual(
        normalizedRows.map((row) => ({
          eventId: row.eventId,
          type: row.type,
          payload: JSON.parse(row.payload),
        })),
        [
          {
            eventId: "evt-thread-archived",
            type: "thread.meta-updated",
            payload: {
              threadId: "thread-archived",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          {
            eventId: "evt-thread-unarchived",
            type: "thread.meta-updated",
            payload: {
              threadId: "thread-unarchived",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        ],
      );

      const decodedEvents = normalizedRows.map((row) =>
        decodeEvent({
          sequence: row.sequence,
          eventId: EventId.makeUnsafe(row.eventId),
          type: row.type,
          aggregateKind: row.aggregateKind,
          aggregateId:
            row.aggregateKind === "project"
              ? ProjectId.makeUnsafe(row.aggregateId)
              : ThreadId.makeUnsafe(row.aggregateId),
          occurredAt: row.occurredAt,
          commandId: row.commandId === null ? null : CommandId.makeUnsafe(row.commandId),
          causationEventId:
            row.causationEventId === null ? null : EventId.makeUnsafe(row.causationEventId),
          correlationId:
            row.correlationId === null ? null : CommandId.makeUnsafe(row.correlationId),
          payload: JSON.parse(row.payload),
          metadata: JSON.parse(row.metadata),
        }),
      );

      assert.deepStrictEqual(
        decodedEvents.map((event) => {
          assert.equal(event.type, "thread.meta-updated");
          if (event.type !== "thread.meta-updated") {
            throw new Error(`Expected thread.meta-updated, got ${event.type}`);
          }
          return {
            eventId: String(event.eventId),
            type: event.type,
            payload: {
              threadId: String(event.payload.threadId),
              updatedAt: event.payload.updatedAt,
            },
          };
        }),
        [
          {
            eventId: "evt-thread-archived",
            type: "thread.meta-updated",
            payload: {
              threadId: "thread-archived",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          {
            eventId: "evt-thread-unarchived",
            type: "thread.meta-updated",
            payload: {
              threadId: "thread-unarchived",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          },
        ],
      );
    }),
  );
});
