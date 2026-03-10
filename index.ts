import { eq, sql, and } from "drizzle-orm";

import { db } from "./db";
import { users, playlists, playlistSongs, playlistShares } from "./db/schema";

// Convert camelCase keys to snake_case to preserve the existing API contract
function toSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeKeys(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(snakeKeys);
    if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
        return Object.fromEntries(
            Object.entries(obj as Record<string, unknown>).map(([k, v]) => [toSnake(k), snakeKeys(v)])
        );
    }
    return obj;
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(snakeKeys(data)), {
        status,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}

function corsHeaders() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        },
    });
}

const server = Bun.serve({
    port: process.env.PORT || 3001,

    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (method === "OPTIONS") return corsHeaders();

        try {
            // --- Users (synced from Clerk) ---

            // Sync user from Clerk (call after login/signup)
            if (path === "/api/users/sync" && method === "POST") {
                const { clerk_id, username, email, first_name, last_name, profile_image } = await req.json();
                if (!clerk_id) return json({ error: "clerk_id is required" }, 400);

                const result = await db
                    .insert(users)
                    .values({
                        clerkId: clerk_id,
                        username: username || null,
                        email: email || null,
                        firstName: first_name || null,
                        lastName: last_name || null,
                        profileImage: profile_image || null,
                    })
                    .onConflictDoUpdate({
                        target: users.clerkId,
                        set: {
                            username: sql`COALESCE(${username || null}, ${users.username})`,
                            email: sql`COALESCE(${email || null}, ${users.email})`,
                            firstName: sql`COALESCE(${first_name || null}, ${users.firstName})`,
                            lastName: sql`COALESCE(${last_name || null}, ${users.lastName})`,
                            profileImage: sql`COALESCE(${profile_image || null}, ${users.profileImage})`,
                            updatedAt: sql`NOW()`,
                        },
                    })
                    .returning();

                return json(result[0]);
            }

            // Get user by clerk_id
            const userMatch = path.match(/^\/api\/users\/(.+)$/);
            if (userMatch && method === "GET") {
                const clerkId = decodeURIComponent(userMatch[1]);
                const result = await db.select().from(users).where(eq(users.clerkId, clerkId));
                if (result.length === 0) return json({ error: "User not found" }, 404);
                return json(result[0]);
            }

            // --- Playlists ---

            // Create a playlist
            if (path === "/api/playlists" && method === "POST") {
                const { clerk_id, name, description } = await req.json();
                if (!clerk_id || !name) return json({ error: "clerk_id and name are required" }, 400);

                // Ensure user exists (prevents FK violation if UserSync hasn't completed)
                await db
                    .insert(users)
                    .values({ clerkId: clerk_id })
                    .onConflictDoNothing({ target: users.clerkId });

                const result = await db
                    .insert(playlists)
                    .values({
                        clerkId: clerk_id,
                        name,
                        description: description || null,
                    })
                    .returning();

                return json(result[0], 201);
            }

            // Get all playlists for a user
            const userPlaylistsMatch = path.match(/^\/api\/playlists\/user\/(.+)$/);
            if (userPlaylistsMatch && method === "GET") {
                const userId = decodeURIComponent(userPlaylistsMatch[1]);

                const result = await db
                    .select({
                        id: playlists.id,
                        clerkId: playlists.clerkId,
                        name: playlists.name,
                        description: playlists.description,
                        createdAt: playlists.createdAt,
                        song_count: sql<number>`COUNT(${playlistSongs.id})::int`,
                    })
                    .from(playlists)
                    .leftJoin(playlistSongs, eq(playlists.id, playlistSongs.playlistId))
                    .where(eq(playlists.clerkId, userId))
                    .groupBy(playlists.id)
                    .orderBy(sql`${playlists.createdAt} DESC`);

                return json(result);
            }

            // Remove a song from a playlist
            const removeSongMatch = path.match(/^\/api\/playlists\/(\d+)\/songs\/(.+)$/);
            if (removeSongMatch && method === "DELETE") {
                const result = await db
                    .delete(playlistSongs)
                    .where(
                        and(
                            eq(playlistSongs.playlistId, parseInt(removeSongMatch[1])),
                            eq(playlistSongs.trackId, removeSongMatch[2])
                        )
                    )
                    .returning();

                if (result.length === 0) return json({ error: "Song not found in playlist" }, 404);
                return json({ message: "Song removed from playlist" });
            }

            // --- Playlist Sharing ---

            // Share a playlist with another user (by email)
            const shareMatch = path.match(/^\/api\/playlists\/(\d+)\/share$/);
            if (shareMatch && method === "POST") {
                const playlistId = parseInt(shareMatch[1]);
                const { email, shared_by_clerk_id } = await req.json();
                if (!email || !shared_by_clerk_id) return json({ error: "email and shared_by_clerk_id are required" }, 400);

                // Verify the playlist exists and belongs to the sharer
                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== shared_by_clerk_id) return json({ error: "Only the playlist owner can share" }, 403);

                // Find the target user by email
                const targetUser = await db.select().from(users).where(eq(users.email, email));
                if (targetUser.length === 0) return json({ error: "User not found with that email" }, 404);
                if (targetUser[0].clerkId === shared_by_clerk_id) return json({ error: "Cannot share with yourself" }, 400);

                const result = await db
                    .insert(playlistShares)
                    .values({
                        playlistId,
                        sharedWithClerkId: targetUser[0].clerkId,
                        sharedByClerkId: shared_by_clerk_id,
                    })
                    .returning();

                return json(result[0], 201);
            }

            // Revoke a share
            const revokeShareMatch = path.match(/^\/api\/playlists\/(\d+)\/share\/(.+)$/);
            if (revokeShareMatch && method === "DELETE") {
                const playlistId = parseInt(revokeShareMatch[1]);
                const sharedWithClerkId = decodeURIComponent(revokeShareMatch[2]);

                const result = await db
                    .delete(playlistShares)
                    .where(
                        and(
                            eq(playlistShares.playlistId, playlistId),
                            eq(playlistShares.sharedWithClerkId, sharedWithClerkId)
                        )
                    )
                    .returning();

                if (result.length === 0) return json({ error: "Share not found" }, 404);
                return json({ message: "Share revoked" });
            }

            // Get playlists shared with a user
            const sharedPlaylistsMatch = path.match(/^\/api\/playlists\/shared\/(.+)$/);
            if (sharedPlaylistsMatch && method === "GET") {
                const clerkId = decodeURIComponent(sharedPlaylistsMatch[1]);

                const result = await db
                    .select({
                        id: playlists.id,
                        clerkId: playlists.clerkId,
                        name: playlists.name,
                        description: playlists.description,
                        createdAt: playlists.createdAt,
                        song_count: sql<number>`COUNT(${playlistSongs.id})::int`,
                        shared_by: playlistShares.sharedByClerkId,
                    })
                    .from(playlistShares)
                    .innerJoin(playlists, eq(playlistShares.playlistId, playlists.id))
                    .leftJoin(playlistSongs, eq(playlists.id, playlistSongs.playlistId))
                    .where(eq(playlistShares.sharedWithClerkId, clerkId))
                    .groupBy(playlists.id, playlistShares.sharedByClerkId)
                    .orderBy(sql`${playlists.createdAt} DESC`);

                return json(result);
            }

            // Add a song to a playlist
            const addSongMatch = path.match(/^\/api\/playlists\/(\d+)\/songs$/);
            if (addSongMatch && method === "POST") {
                const { track_id, title, artist_name, album_art, preview_url, collection_name, duration } = await req.json();
                if (!track_id || !title || !artist_name) {
                    return json({ error: "track_id, title, and artist_name are required" }, 400);
                }

                const playlistId = parseInt(addSongMatch[1]);

                const posResult = await db
                    .select({ nextPos: sql<number>`COALESCE(MAX(${playlistSongs.position}), 0) + 1` })
                    .from(playlistSongs)
                    .where(eq(playlistSongs.playlistId, playlistId));

                const result = await db
                    .insert(playlistSongs)
                    .values({
                        playlistId,
                        trackId: track_id,
                        title,
                        artistName: artist_name,
                        albumArt: album_art || null,
                        previewUrl: preview_url || null,
                        collectionName: collection_name || null,
                        duration: duration || null,
                        position: posResult[0].nextPos,
                    })
                    .returning();

                return json(result[0], 201);
            }

            // Get a single playlist with its songs
            const playlistMatch = path.match(/^\/api\/playlists\/(\d+)$/);
            if (playlistMatch && method === "GET") {
                const playlistId = parseInt(playlistMatch[1]);
                const clerkId = url.searchParams.get("clerk_id");

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);

                // Check access: owner or shared-with user
                const isOwner = playlist[0].clerkId === clerkId;
                let isShared = false;
                if (!isOwner && clerkId) {
                    const shareRecord = await db
                        .select()
                        .from(playlistShares)
                        .where(
                            and(
                                eq(playlistShares.playlistId, playlistId),
                                eq(playlistShares.sharedWithClerkId, clerkId)
                            )
                        );
                    isShared = shareRecord.length > 0;
                }

                const songs = await db
                    .select()
                    .from(playlistSongs)
                    .where(eq(playlistSongs.playlistId, playlistId))
                    .orderBy(playlistSongs.position);

                return json({ ...playlist[0], songs, is_owner: isOwner, is_shared: isShared });
            }

            // Update a playlist
            if (playlistMatch && method === "PUT") {
                const { name, description } = await req.json();
                const playlistId = parseInt(playlistMatch[1]);

                const result = await db
                    .update(playlists)
                    .set({
                        name: name ?? undefined,
                        description: description ?? undefined,
                    })
                    .where(eq(playlists.id, playlistId))
                    .returning();

                if (result.length === 0) return json({ error: "Playlist not found" }, 404);
                return json(result[0]);
            }

            // Delete a playlist
            if (playlistMatch && method === "DELETE") {
                const playlistId = parseInt(playlistMatch[1]);

                const result = await db
                    .delete(playlists)
                    .where(eq(playlists.id, playlistId))
                    .returning();

                if (result.length === 0) return json({ error: "Playlist not found" }, 404);
                return json({ message: "Playlist deleted" });
            }

            // --- Root ---
            if (path === "/") return json({ message: "iTunes Backend API" });

            return json({ error: "Not found" }, 404);
        } catch (err: any) {
            const code = err.code || err.cause?.code;
            const msg = err.message || "";
            if (code === "23505" || msg.includes("unique")) {
                if (msg.includes("playlist_shares")) {
                    return json({ error: "Playlist already shared with this user" }, 409);
                }
                return json({ error: "Song already in playlist" }, 409);
            }
            if (code === "23503" || msg.includes("foreign key") || msg.includes("violates foreign key")) {
                return json({ error: "User not found. Please sign in again." }, 400);
            }
            console.error("API error:", err);
            return json({ error: "Something went wrong", details: String(err), stack: err.stack }, 500);
        }
    },
});

console.log(`Server running on port ${server.port}`);
