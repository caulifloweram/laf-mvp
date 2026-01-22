import { pool } from "./db";

async function fixStreamId() {
  try {
    // Check if column exists and is INTEGER
    const checkResult = await pool.query(`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'streams' AND column_name = 'stream_id'
    `);

    if (checkResult.rows.length === 0) {
      console.log("stream_id column doesn't exist, will be created as BIGINT");
      return;
    }

    const currentType = checkResult.rows[0].data_type;
    if (currentType === "bigint") {
      console.log("✅ stream_id is already BIGINT");
      return;
    }

    console.log(`Converting stream_id from ${currentType} to BIGINT...`);
    
    // Drop the unique constraint temporarily
    await pool.query(`
      ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_stream_id_key
    `);

    // Change column type to BIGINT
    await pool.query(`
      ALTER TABLE streams ALTER COLUMN stream_id TYPE BIGINT
    `);

    // Re-add unique constraint
    await pool.query(`
      ALTER TABLE streams ADD CONSTRAINT streams_stream_id_key UNIQUE (stream_id)
    `);

    console.log("✅ stream_id converted to BIGINT successfully!");
  } catch (err: any) {
    console.error("Failed to fix stream_id:", err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

fixStreamId().then(() => {
  console.log("Migration complete!");
  process.exit(0);
}).catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
