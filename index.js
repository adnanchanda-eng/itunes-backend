const express = require("express");
const cors = require("cors");
require("dotenv").config();

const userRoutes = require("./routes/users");
const playlistRoutes = require("./routes/playlists");
const songRoutes = require("./routes/songs");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/users", userRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/songs", songRoutes);

app.get("/", (req, res) => {
  res.json({ message: "iTunes Backend API" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
