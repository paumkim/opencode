import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260928020838_fanout_ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`fanout_group\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_fanout_group_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fanout_worker\` (
          \`id\` text PRIMARY KEY,
          \`group_id\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`description\` text NOT NULL,
          \`status\` text NOT NULL,
          \`digest\` text,
          \`error\` text,
          \`settled_seq\` integer,
          \`claimed_seq\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_fanout_worker_group_id_fanout_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`fanout_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_fanout_worker_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_fanout_worker_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`fanout_group_parent_status_idx\` ON \`fanout_group\` (\`parent_session_id\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`fanout_group_session_idx\` ON \`fanout_group\` (\`parent_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`fanout_worker_group_idx\` ON \`fanout_worker\` (\`group_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`fanout_worker_parent_status_idx\` ON \`fanout_worker\` (\`parent_session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`fanout_worker_parent_claimed_idx\` ON \`fanout_worker\` (\`parent_session_id\`,\`claimed_seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`fanout_worker_session_idx\` ON \`fanout_worker\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`fanout_worker_settled_idx\` ON \`fanout_worker\` (\`settled_seq\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
