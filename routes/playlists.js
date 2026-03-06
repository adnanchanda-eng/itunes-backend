const express = require("express");
const router = express.Router();
const pool = require("../db");

// Create a playlist
router.post("/", async (req, res) => {
  const { user_id, name, description } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO playlists (user_id, name, description) VALUES ($1, $2, $3) RETURNING *",
      [user_id, name, description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all playlists for a user
router.get("/user/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM playlists WHERE user_id = $1 ORDER BY created_at DESC",
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a single playlist with its songs
router.get("/:id", async (req, res) => {
  try {
    const playlist = await pool.query("SELECT * FROM playlists WHERE id = $1", [
      req.params.id,
    ]);
    if (playlist.rows.length === 0) {
      return res.status(404).json({ error: "Playlist not found" });
    }

    const songs = await pool.query(
      `SELECT s.*, ps.position, ps.added_at
       FROM playlist_songs ps
       JOIN songs s ON ps.song_id = s.id
       WHERE ps.playlist_id = $1
       ORDER BY ps.position`,
      [req.params.id]
    );

    res.json({ ...playlist.rows[0], songs: songs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a playlist
router.put("/:id", async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      "UPDATE playlists SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING *",
      [name, description, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a playlist
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM playlists WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    res.json({ message: "Playlist deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a song to a playlist
router.post("/:id/songs", async (req, res) => {
  const { song_id } = req.body;
  try {
    const posResult = await pool.query(
      "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM playlist_songs WHERE playlist_id = $1",
      [req.params.id]
    );
    const position = posResult.rows[0].next_pos;

    const result = await pool.query(
      "INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, song_id, position]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Song already in playlist" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Remove a song from a playlist
router.delete("/:id/songs/:songId", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM playlist_songs WHERE playlist_id = $1 AND song_id = $2 RETURNING *",
      [req.params.id, req.params.songId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Song not found in playlist" });
    }
    res.json({ message: "Song removed from playlist" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
