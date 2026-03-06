const pool = require("./db");
const fs = require("fs");
const path = require("path");

async function initDb() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
    await pool.query(sql);
    console.log("Database tables created successfully");
  } catch (err) {
    console.error("Error initializing database:", err.message);
  } finally {
    await pool.end();
  }
}

initDb();
