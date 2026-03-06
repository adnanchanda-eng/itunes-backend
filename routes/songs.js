const express = require("express");
const router = express.Router();
const pool = require("../db");

// Add a song
router.post("/", async (req, res) => {
  const { title, artist, album, duration, genre, url, cover_image } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO songs (title, artist, album, duration, genre, url, cover_image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [title, artist, album, duration, genre, url, cover_image]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all songs
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM songs ORDER BY title");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search songs
router.get("/search", async (req, res) => {
  const { q } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM songs WHERE title ILIKE $1 OR artist ILIKE $1 OR album ILIKE $1",
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single song
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM songs WHERE id = $1", [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Song not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
