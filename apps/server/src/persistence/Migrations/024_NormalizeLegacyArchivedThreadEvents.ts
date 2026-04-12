/**
 * Older desktop builds persisted thread.archived/thread.unarchived domain
 * events, but the current released schema only supports thread.meta-updated.
 * Normalize those legacy rows so replay stays decodable across upgrades.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_events
    SET
      event_type = 'thread.meta-updated',
      payload_json = json_object(
        'threadId',
        json_extract(payload_json, '$.threadId'),
        'updatedAt',
        COALESCE(
          json_extract(payload_json, '$.updatedAt'),
          json_extract(payload_json, '$.unarchivedAt'),
          json_extract(payload_json, '$.archivedAt'),
          occurred_at
        )
      )
    WHERE event_type IN ('thread.archived', 'thread.unarchived')
  `;
});
