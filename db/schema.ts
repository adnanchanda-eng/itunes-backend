import { pgTable, serial, varchar, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const users = pgTable(
    "users",
    {
        id: serial("id").primaryKey(),
        clerkId: varchar("clerk_id", { length: 255 }).unique().notNull(),
        username: varchar("username", { length: 255 }),
        email: varchar("email", { length: 255 }),
        firstName: varchar("first_name", { length: 255 }),
        lastName: varchar("last_name", { length: 255 }),
        profileImage: text("profile_image"),
        createdAt: timestamp("created_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (table) => [index("idx_users_clerk_id").on(table.clerkId)]
);

export const playlists = pgTable(
    "playlists",
    {
        id: serial("id").primaryKey(),
        clerkId: varchar("clerk_id", { length: 255 })
            .notNull()
            .references(() => users.clerkId, { onDelete: "cascade" }),
        name: varchar("name", { length: 255 }).notNull(),
        description: text("description"),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (table) => [index("idx_playlists_clerk_id").on(table.clerkId)]
);

export const playlistSongs = pgTable(
    "playlist_songs",
    {
        id: serial("id").primaryKey(),
        playlistId: integer("playlist_id")
            .notNull()
            .references(() => playlists.id, { onDelete: "cascade" }),
        trackId: varchar("track_id", { length: 255 }).notNull(),
        title: varchar("title", { length: 255 }).notNull(),
        artistName: varchar("artist_name", { length: 255 }).notNull(),
        albumArt: text("album_art"),
        previewUrl: text("preview_url"),
        collectionName: varchar("collection_name", { length: 255 }),
        duration: integer("duration"),
        position: integer("position").notNull(),
        addedAt: timestamp("added_at").defaultNow(),
    },
    (table) => [
        index("idx_playlist_songs_playlist_id").on(table.playlistId),
        uniqueIndex("playlist_songs_playlist_id_track_id_unique").on(table.playlistId, table.trackId),
    ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
    playlists: many(playlists),
}));

export const playlistsRelations = relations(playlists, ({ one, many }) => ({
    user: one(users, { fields: [playlists.clerkId], references: [users.clerkId] }),
    songs: many(playlistSongs),
}));

export const playlistSongsRelations = relations(playlistSongs, ({ one }) => ({
    playlist: one(playlists, { fields: [playlistSongs.playlistId], references: [playlists.id] }),
}));
