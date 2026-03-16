import crypto from "crypto";

import { createClerkClient } from "@clerk/backend";
import { eq, sql, and, desc } from "drizzle-orm";

import { db } from "./db";
import { users, playlists, playlistSongs, playlistShares, playlistShareTokens, playlistClaimCopies, pendingPlaylistShares, emailInvitationTokens, songSearchCounts, songListenCounts } from "./db/schema";
import { cacheGet, cacheSet, cacheDel, cacheDelPattern, redis } from "./redis";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Cache TTL constants (seconds)
const CACHE_TTL_PLAYLISTS = 86400;   // 1 day
const CACHE_TTL_SEARCH_HISTORY = 604800; // 7 days

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Allow any localhost origin in development so port changes don't break CORS
function getAllowedOrigin(req: Request): string {
    const origin = req.headers.get("origin") || "";
    if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return origin;
    }
    return FRONTEND_URL;
}

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

function _json(data: unknown, status = 200, cacheStatus?: "HIT" | "MISS", req?: Request) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": req ? getAllowedOrigin(req) : FRONTEND_URL,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (cacheStatus) {
        headers["X-Cache"] = cacheStatus;
    }

    return new Response(JSON.stringify(snakeKeys(data)), {
        status,
        headers,
    });
}

function corsHeaders(req: Request) {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": getAllowedOrigin(req),
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
    });
}

const server = Bun.serve({
    port: process.env.PORT || 3001,

    async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (method === "OPTIONS") return corsHeaders(req);

        // Request-aware json helper — all responses carry the correct CORS origin
        const json = (data: unknown, status = 200, cacheStatus?: "HIT" | "MISS") =>
            _json(data, status, cacheStatus, req);

        try {
            // --- Users (synced from Clerk) ---

            // Sync user from Clerk (call after login/signup)
            if (path === "/api/users/sync" && method === "POST") {
                const { clerk_id, username, email, first_name, last_name, profile_image } = (await req.json()) as Record<string, any>;
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

                // Migrate pending playlist shares for this user's email (case-insensitive)
                if (email && typeof email === "string") {
                    const emailLower = email.trim().toLowerCase();
                    const pending = await db
                        .select()
                        .from(pendingPlaylistShares)
                        .where(sql`LOWER(${pendingPlaylistShares.email}) = ${emailLower}`);

                    for (const p of pending) {
                        try {
                            await db.insert(playlistShares).values({
                                playlistId: p.playlistId,
                                sharedWithClerkId: clerk_id,
                                sharedByClerkId: p.sharedByClerkId,
                            });
                        } catch {
                            // Ignore duplicate (already shared)
                        }
                        await db.delete(pendingPlaylistShares).where(eq(pendingPlaylistShares.id, p.id));
                    }
                }

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
                const { clerk_id, name, description } = (await req.json()) as Record<string, any>;
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

                // Invalidate user playlists cache
                await cacheDel(`playlists:user:${clerk_id}`);

                return json(result[0], 201);
            }

            // Get all playlists for a user
            const userPlaylistsMatch = path.match(/^\/api\/playlists\/user\/(.+)$/);
            if (userPlaylistsMatch && method === "GET") {
                const userId = decodeURIComponent(userPlaylistsMatch[1]);
                const cacheKey = `playlists:user:${userId}`;

                // Check cache first
                const cached = await cacheGet(cacheKey);
                if (cached) return json(cached, 200, "HIT");

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

                await cacheSet(cacheKey, result, CACHE_TTL_PLAYLISTS);
                return json(result, 200, "MISS");
            }

            // Remove a song from a playlist (owner only)
            const removeSongMatch = path.match(/^\/api\/playlists\/(\d+)\/songs\/(.+)$/);
            if (removeSongMatch && method === "DELETE") {
                const playlistId = parseInt(removeSongMatch[1]);
                const trackId = removeSongMatch[2];
                const clerkId = url.searchParams.get("clerk_id");

                if (!clerkId) return json({ error: "clerk_id is required" }, 400);

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerkId) return json({ error: "Only the playlist owner can remove songs" }, 403);

                const result = await db
                    .delete(playlistSongs)
                    .where(
                        and(
                            eq(playlistSongs.playlistId, playlistId),
                            eq(playlistSongs.trackId, trackId)
                        )
                    )
                    .returning();

                if (result.length === 0) return json({ error: "Song not found in playlist" }, 404);

                // Invalidate playlist detail cache
                await cacheDelPattern(`playlist:${playlistId}:*`);

                return json({ message: "Song removed from playlist" });
            }

            // --- Playlist Sharing ---

            // Share a playlist with another user (by email)
            const shareMatch = path.match(/^\/api\/playlists\/(\d+)\/share$/);
            if (shareMatch && method === "POST") {
                const playlistId = parseInt(shareMatch[1]);
                const { email, shared_by_clerk_id } = (await req.json()) as Record<string, any>;
                if (!email || !shared_by_clerk_id) return json({ error: "email and shared_by_clerk_id are required" }, 400);

                const emailTrimmed = String(email).trim();
                if (!EMAIL_REGEX.test(emailTrimmed)) return json({ error: "Invalid email address" }, 400);

                const emailLower = emailTrimmed.toLowerCase();

                // Verify the playlist exists and belongs to the sharer
                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== shared_by_clerk_id) return json({ error: "Only the playlist owner can share" }, 403);

                // Find the target user by email (case-insensitive)
                const targetUser = await db
                    .select()
                    .from(users)
                    .where(sql`LOWER(${users.email}) = ${emailLower}`);

                if (targetUser.length > 0) {
                    if (targetUser[0].clerkId === shared_by_clerk_id) return json({ error: "Cannot share with yourself" }, 400);

                    // User exists: create share (idempotent - ignore duplicate)
                    const existing = await db
                        .select()
                        .from(playlistShares)
                        .where(
                            and(
                                eq(playlistShares.playlistId, playlistId),
                                eq(playlistShares.sharedWithClerkId, targetUser[0].clerkId)
                            )
                        );
                    if (existing.length > 0) return json(existing[0], 200);

                    // Invalidate shared playlists cache for the target user
                    await cacheDel(`playlists:shared:${targetUser[0].clerkId}`);

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

                // User not in DB: store as pending (they'll get it when they sign up)
                const existingPending = await db
                    .select()
                    .from(pendingPlaylistShares)
                    .where(
                        and(
                            eq(pendingPlaylistShares.playlistId, playlistId),
                            eq(pendingPlaylistShares.email, emailLower)
                        )
                    );
                if (existingPending.length > 0) return json({ id: existingPending[0].id, pending: true }, 200);

                const pendingResult = await db
                    .insert(pendingPlaylistShares)
                    .values({
                        playlistId,
                        email: emailLower,
                        sharedByClerkId: shared_by_clerk_id,
                    })
                    .returning();
                return json({ id: pendingResult[0].id, pending: true }, 201);
            }

            // Revoke a share (owner only)
            const revokeShareMatch = path.match(/^\/api\/playlists\/(\d+)\/share\/(.+)$/);
            if (revokeShareMatch && method === "DELETE") {
                const playlistId = parseInt(revokeShareMatch[1]);
                const sharedWithClerkId = decodeURIComponent(revokeShareMatch[2]);
                const clerkId = url.searchParams.get("clerk_id");

                if (!clerkId) return json({ error: "clerk_id is required" }, 400);

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerkId) return json({ error: "Only the playlist owner can revoke shares" }, 403);

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

            const sharedPlaylistsMatch = path.match(/^\/api\/playlists\/shared\/(.+)$/);
            if (sharedPlaylistsMatch && method === "GET") {
                const clerkId = decodeURIComponent(sharedPlaylistsMatch[1]);
                const cacheKey = `playlists:shared:${clerkId}`;

                // Check cache first
                const cached = await cacheGet(cacheKey);
                if (cached) return json(cached, 200, "HIT");

                const result = await db
                    .select({
                        id: playlists.id,
                        clerkId: playlists.clerkId,
                        name: playlists.name,
                        description: playlists.description,
                        createdAt: playlists.createdAt,
                        song_count: sql<number>`COUNT(${playlistSongs.id})::int`,
                        shared_by: playlistShares.sharedByClerkId,
                        shared_by_email: users.email,
                        shared_by_name: sql<string>`CONCAT(${users.firstName}, ' ', ${users.lastName})`,
                    })
                    .from(playlistShares)
                    .innerJoin(playlists, eq(playlistShares.playlistId, playlists.id))
                    .leftJoin(playlistSongs, eq(playlists.id, playlistSongs.playlistId))
                    .leftJoin(users, eq(users.clerkId, playlistShares.sharedByClerkId))
                    .where(eq(playlistShares.sharedWithClerkId, clerkId))
                    .groupBy(playlists.id, playlistShares.sharedByClerkId, users.email, users.firstName, users.lastName)
                    .orderBy(sql`${playlists.createdAt} DESC`);

                await cacheSet(cacheKey, result, CACHE_TTL_PLAYLISTS);
                return json(result, 200, "MISS");
            }

            // Add a song to a playlist (owner only)
            const addSongMatch = path.match(/^\/api\/playlists\/(\d+)\/songs$/);
            if (addSongMatch && method === "POST") {
                const { track_id, title, artist_name, album_art, preview_url, collection_name, duration, clerk_id } = (await req.json()) as Record<string, any>;
                if (!track_id || !title || !artist_name) {
                    return json({ error: "track_id, title, and artist_name are required" }, 400);
                }
                if (!clerk_id) return json({ error: "clerk_id is required" }, 400);

                const playlistId = parseInt(addSongMatch[1]);

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerk_id) return json({ error: "Only the playlist owner can add songs" }, 403);

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

                // Invalidate playlist detail cache after adding song
                await cacheDelPattern(`playlist:${playlistId}:*`);

                return json(result[0], 201);
            }

            // Get a single playlist with its songs
            const playlistMatch = path.match(/^\/api\/playlists\/(\d+)$/);
            if (playlistMatch && method === "GET") {
                const playlistId = parseInt(playlistMatch[1]);
                const clerkId = url.searchParams.get("clerk_id");
                const cacheKey = `playlist:${playlistId}:${clerkId || "anon"}`;

                // Check cache first
                const cached = await cacheGet(cacheKey);
                if (cached) return json(cached, 200, "HIT");

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);

                // Check access: owner or shared-with user
                const isOwner = playlist[0].clerkId === clerkId;
                let isShared = false;
                let sharedByName: string | null = null;
                let sharedByEmail: string | null = null;
                if (!isOwner && clerkId) {
                    const shareRecord = await db
                        .select({
                            sharedByClerkId: playlistShares.sharedByClerkId,
                        })
                        .from(playlistShares)
                        .where(
                            and(
                                eq(playlistShares.playlistId, playlistId),
                                eq(playlistShares.sharedWithClerkId, clerkId)
                            )
                        );
                    if (shareRecord.length > 0) {
                        isShared = true;
                        const sharer = await db
                            .select({
                                firstName: users.firstName,
                                lastName: users.lastName,
                                email: users.email,
                            })
                            .from(users)
                            .where(eq(users.clerkId, shareRecord[0].sharedByClerkId));
                        if (sharer.length > 0) {
                            sharedByName = [sharer[0].firstName, sharer[0].lastName].filter(Boolean).join(" ") || null;
                            sharedByEmail = sharer[0].email;
                        }
                    }
                }

                const songs = await db
                    .select()
                    .from(playlistSongs)
                    .where(eq(playlistSongs.playlistId, playlistId))
                    .orderBy(playlistSongs.position);

                const responseData = {
                    ...playlist[0],
                    songs,
                    is_owner: isOwner,
                    is_shared: isShared,
                    ...(isShared && { shared_by_name: sharedByName, shared_by_email: sharedByEmail }),
                };

                await cacheSet(cacheKey, responseData, CACHE_TTL_PLAYLISTS);
                return json(responseData);
            }

            // Update a playlist (owner only)
            if (playlistMatch && method === "PUT") {
                const { name, description, clerk_id } = (await req.json()) as Record<string, any>;
                const playlistId = parseInt(playlistMatch[1]);

                if (!clerk_id) return json({ error: "clerk_id is required" }, 400);

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerk_id) return json({ error: "Only the playlist owner can update" }, 403);

                const result = await db
                    .update(playlists)
                    .set({
                        name: name ?? undefined,
                        description: description ?? undefined,
                    })
                    .where(eq(playlists.id, playlistId))
                    .returning();

                if (result.length === 0) return json({ error: "Playlist not found" }, 404);

                // Invalidate playlist caches after update
                await cacheDelPattern(`playlist:${playlistId}:*`);
                await cacheDel(`playlists:user:${clerk_id}`);

                return json(result[0]);
            }

            // Delete a playlist (owner only)
            if (playlistMatch && method === "DELETE") {
                const playlistId = parseInt(playlistMatch[1]);
                const clerkId = url.searchParams.get("clerk_id");

                if (!clerkId) return json({ error: "clerk_id is required" }, 400);

                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerkId) return json({ error: "Only the playlist owner can delete" }, 403);

                const result = await db
                    .delete(playlists)
                    .where(eq(playlists.id, playlistId))
                    .returning();

                if (result.length === 0) return json({ error: "Playlist not found" }, 404);

                // Invalidate playlist caches after delete
                await cacheDelPattern(`playlist:${playlistId}:*`);
                await cacheDel(`playlists:user:${clerkId}`);

                return json({ message: "Playlist deleted" });
            }

            // --- Share Links (token-based) ---

            // Create a share link token for a playlist (owner only)
            const createShareLinkMatch = path.match(/^\/api\/playlists\/(\d+)\/share-link$/);
            if (createShareLinkMatch && method === "POST") {
                const playlistId = parseInt(createShareLinkMatch[1]);
                const { clerk_id } = (await req.json()) as Record<string, any>;
                if (!clerk_id) return json({ error: "clerk_id is required" }, 400);

                // Verify playlist exists and belongs to caller
                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== clerk_id) return json({ error: "Only the playlist owner can create share links" }, 403);

                const token = crypto.randomBytes(16).toString("hex");

                const result = await db
                    .insert(playlistShareTokens)
                    .values({
                        token,
                        playlistId,
                        createdByClerkId: clerk_id,
                    })
                    .returning();

                return json({ token: result[0].token, url: `/s/${result[0].token}` }, 201);
            }

            // Get playlist by share token (public, no auth required) — token is case-insensitive
            const sharedByTokenMatch = path.match(/^\/api\/playlists\/shared-by-token\/([a-fA-F0-9]+)$/);
            if (sharedByTokenMatch && method === "GET") {
                const token = sharedByTokenMatch[1];

                const tokenRecord = await db
                    .select()
                    .from(playlistShareTokens)
                    .where(sql`LOWER(${playlistShareTokens.token}) = LOWER(${token})`);

                if (tokenRecord.length === 0) return json({ error: "Invalid or expired share link" }, 404);

                // Check expiry
                if (tokenRecord[0].expiresAt && new Date(tokenRecord[0].expiresAt) < new Date()) {
                    return json({ error: "Invalid or expired share link" }, 404);
                }

                const playlist = await db.select().from(playlists).where(eq(playlists.id, tokenRecord[0].playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);

                // Fetch owner info
                const owner = await db.select().from(users).where(eq(users.clerkId, playlist[0].clerkId));

                const songs = await db
                    .select()
                    .from(playlistSongs)
                    .where(eq(playlistSongs.playlistId, playlist[0].id))
                    .orderBy(playlistSongs.position);

                return json({
                    id: playlist[0].id,
                    name: playlist[0].name,
                    description: playlist[0].description,
                    song_count: songs.length,
                    songs,
                    token,
                    owner_name: owner.length > 0
                        ? [owner[0].firstName, owner[0].lastName].filter(Boolean).join(" ") || owner[0].username || owner[0].email
                        : null,
                }, 200, "MISS");
            }

            // Claim a playlist via share token (authenticated) — creates a COPY owned by claimant for full ownership
            const claimByTokenMatch = path.match(/^\/api\/playlists\/claim-by-token\/([a-fA-F0-9]+)$/);
            if (claimByTokenMatch && method === "POST") {
                const token = claimByTokenMatch[1];
                const { clerk_id } = (await req.json()) as Record<string, any>;
                if (!clerk_id) return json({ error: "clerk_id is required" }, 400);

                const tokenRecord = await db
                    .select()
                    .from(playlistShareTokens)
                    .where(sql`LOWER(${playlistShareTokens.token}) = LOWER(${token})`);

                if (tokenRecord.length === 0) return json({ error: "Invalid or expired share link" }, 404);

                if (tokenRecord[0].expiresAt && new Date(tokenRecord[0].expiresAt) < new Date()) {
                    return json({ error: "Invalid or expired share link" }, 404);
                }

                // Don't let owner claim their own playlist — they already have it
                if (tokenRecord[0].createdByClerkId === clerk_id) {
                    return json({ playlist_id: tokenRecord[0].playlistId });
                }

                // Check if already claimed (idempotent) — use actual token from DB for FK
                const dbToken = tokenRecord[0].token;
                const existing = await db
                    .select()
                    .from(playlistClaimCopies)
                    .where(
                        and(
                            eq(playlistClaimCopies.token, dbToken),
                            eq(playlistClaimCopies.claimedByClerkId, clerk_id)
                        )
                    );
                if (existing.length > 0) {
                    return json({ playlist_id: existing[0].newPlaylistId });
                }

                // Ensure the claiming user exists
                await db
                    .insert(users)
                    .values({ clerkId: clerk_id })
                    .onConflictDoNothing({ target: users.clerkId });

                // Create a COPY of the playlist owned by the claimant
                const sourcePlaylist = await db.select().from(playlists).where(eq(playlists.id, tokenRecord[0].playlistId));
                if (sourcePlaylist.length === 0) return json({ error: "Playlist not found" }, 404);

                const [newPlaylist] = await db
                    .insert(playlists)
                    .values({
                        clerkId: clerk_id,
                        name: sourcePlaylist[0].name,
                        description: sourcePlaylist[0].description,
                    })
                    .returning();

                const sourceSongs = await db
                    .select()
                    .from(playlistSongs)
                    .where(eq(playlistSongs.playlistId, tokenRecord[0].playlistId))
                    .orderBy(playlistSongs.position);

                if (sourceSongs.length > 0) {
                    await db.insert(playlistSongs).values(
                        sourceSongs.map((s, i) => ({
                            playlistId: newPlaylist.id,
                            trackId: s.trackId,
                            title: s.title,
                            artistName: s.artistName,
                            albumArt: s.albumArt,
                            previewUrl: s.previewUrl,
                            collectionName: s.collectionName,
                            duration: s.duration,
                            position: i + 1,
                        }))
                    );
                }

                await db.insert(playlistClaimCopies).values({
                    token: dbToken,
                    claimedByClerkId: clerk_id,
                    newPlaylistId: newPlaylist.id,
                });

                return json({ playlist_id: newPlaylist.id });
            }

            // --- Email Invitations (Clerk-powered) ---

            // Send a Clerk invitation email for a playlist
            const inviteMatch = path.match(/^\/api\/playlists\/(\d+)\/invite$/);
            if (inviteMatch && method === "POST") {
                const playlistId = parseInt(inviteMatch[1]);
                const { email, shared_by_clerk_id } = await req.json() as { email?: string; shared_by_clerk_id?: string };
                if (!email || !shared_by_clerk_id) return json({ error: "email and shared_by_clerk_id are required" }, 400);

                const emailTrimmed = String(email).trim();
                if (!EMAIL_REGEX.test(emailTrimmed)) return json({ error: "Invalid email address" }, 400);
                const emailLower = emailTrimmed.toLowerCase();

                // Verify playlist exists and belongs to sharer
                const playlist = await db.select().from(playlists).where(eq(playlists.id, playlistId));
                if (playlist.length === 0) return json({ error: "Playlist not found" }, 404);
                if (playlist[0].clerkId !== shared_by_clerk_id) return json({ error: "Only the playlist owner can invite" }, 403);

                // Don't allow self-invite
                const sharerUser = await db.select().from(users).where(eq(users.clerkId, shared_by_clerk_id));
                if (sharerUser.length > 0 && sharerUser[0].email?.toLowerCase() === emailLower) {
                    return json({ error: "Cannot invite yourself" }, 400);
                }

                // Create Clerk invitation
                const invitation = await clerkClient.invitations.createInvitation({
                    emailAddress: emailLower,
                    redirectUrl: `${FRONTEND_URL}/invite/accept`,
                    publicMetadata: {
                        playlistInvitationPlaylistId: playlistId,
                        playlistInvitationSharedBy: shared_by_clerk_id,
                    },
                    ignoreExisting: true,
                    expiresInDays: 1,
                });

                // Store the invitation mapping in our DB
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
                await db.insert(emailInvitationTokens).values({
                    invitationId: invitation.id,
                    playlistId,
                    email: emailLower,
                    sharedByClerkId: shared_by_clerk_id,
                    expiresAt,
                });

                // Also create a pending share so the playlist is shared even if
                // the user signs up through a different path
                const existingPending = await db
                    .select()
                    .from(pendingPlaylistShares)
                    .where(
                        and(
                            eq(pendingPlaylistShares.playlistId, playlistId),
                            eq(pendingPlaylistShares.email, emailLower)
                        )
                    );
                if (existingPending.length === 0) {
                    await db.insert(pendingPlaylistShares).values({
                        playlistId,
                        email: emailLower,
                        sharedByClerkId: shared_by_clerk_id,
                    }).onConflictDoNothing();
                }

                // If user already exists, also create the direct share
                const targetUser = await db
                    .select()
                    .from(users)
                    .where(sql`LOWER(${users.email}) = ${emailLower}`);
                if (targetUser.length > 0) {
                    await db.insert(playlistShares).values({
                        playlistId,
                        sharedWithClerkId: targetUser[0].clerkId,
                        sharedByClerkId: shared_by_clerk_id,
                    }).onConflictDoNothing();
                }

                return json({ invitation_id: invitation.id, pending: true }, 201);
            }

            // Resolve a Clerk invitation to its playlist (called by frontend after ticket auth)
            const resolveInvMatch = path.match(/^\/api\/invitations\/resolve$/);
            if (resolveInvMatch && method === "GET") {
                const invitationId = url.searchParams.get("invitation_id");
                const clerkId = url.searchParams.get("clerk_id");
                if (!invitationId) return json({ error: "invitation_id is required" }, 400);

                const record = await db
                    .select()
                    .from(emailInvitationTokens)
                    .where(eq(emailInvitationTokens.invitationId, invitationId));

                if (record.length === 0) return json({ error: "Invitation not found" }, 404);

                const inv = record[0];

                // Check expiry
                if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) {
                    return json({ error: "Invitation has expired" }, 410);
                }

                // Mark as accepted
                await db
                    .update(emailInvitationTokens)
                    .set({ accepted: true })
                    .where(eq(emailInvitationTokens.id, inv.id));

                // If we have the accepting user's clerk_id, create the share record
                if (clerkId) {
                    // Ensure user exists
                    await db
                        .insert(users)
                        .values({ clerkId })
                        .onConflictDoNothing({ target: users.clerkId });

                    await db.insert(playlistShares).values({
                        playlistId: inv.playlistId,
                        sharedWithClerkId: clerkId,
                        sharedByClerkId: inv.sharedByClerkId,
                    }).onConflictDoNothing();

                    // Clean up any pending share for this email
                    await db.delete(pendingPlaylistShares).where(
                        and(
                            eq(pendingPlaylistShares.playlistId, inv.playlistId),
                            eq(pendingPlaylistShares.email, inv.email)
                        )
                    );
                }

                return json({
                    playlist_id: inv.playlistId,
                    shared_by_clerk_id: inv.sharedByClerkId,
                    email: inv.email,
                });
            }

            // --- User Search History (Redis-backed) ---

            // Get user's recent search history (last 10 songs)
            const searchHistoryGetMatch = path.match(/^\/api\/search-history\/(.+)$/);
            if (searchHistoryGetMatch && method === "GET") {
                const clerkId = decodeURIComponent(searchHistoryGetMatch[1]);
                const key = `search:recent-songs:${clerkId}`;
                try {
                    const cached = await redis.get(key);
                    const history = cached ? JSON.parse(cached) : [];
                    // Return raw JSON — songs are stored in camelCase from the frontend
                    // Don't use json() helper which converts to snake_case
                    return new Response(JSON.stringify({ searches: history }), {
                        status: 200,
                        headers: {
                            "Content-Type": "application/json",
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                            "Access-Control-Allow-Headers": "Content-Type",
                            "X-Cache": cached ? "HIT" : "MISS",
                        },
                    });
                } catch {
                    return json({ searches: [] });
                }
            }

            // Save a recently played song to user's history
            if (path === "/api/search-history" && method === "POST") {
                const { clerk_id, song } = await req.json() as { clerk_id?: string; song?: any };
                if (!clerk_id || !song || !song.id) return json({ error: "clerk_id and valid song object are required" }, 400);

                const key = `search:recent-songs:${clerk_id}`;
                try {
                    // Fetch existing, prepend new (filtering out duplicates), slice to 10, save
                    let history = [];
                    const cached = await redis.get(key);
                    if (cached) {
                        history = JSON.parse(cached);
                    }

                    history = [song, ...history.filter((s: any) => s.id !== song.id)].slice(0, 10);

                    await redis.set(key, JSON.stringify(history), "EX", CACHE_TTL_SEARCH_HISTORY);
                    return json({ saved: true });
                } catch {
                    return json({ saved: false });
                }
            }

            // Remove a song from user's search history
            if (path === "/api/search-history" && method === "DELETE") {
                const clerk_id = url.searchParams.get("clerk_id");
                const song_id = url.searchParams.get("song_id");
                if (!clerk_id || !song_id) return json({ error: "clerk_id and song_id are required" }, 400);

                const key = `search:recent-songs:${clerk_id}`;
                try {
                    const cached = await redis.get(key);
                    if (cached) {
                        const history = JSON.parse(cached);
                        const newHistory = history.filter((s: any) => s.id !== song_id);
                        await redis.set(key, JSON.stringify(newHistory), "EX", CACHE_TTL_SEARCH_HISTORY);
                    }
                    return json({ removed: true });
                } catch {
                    return json({ removed: false });
                }
            }

            // --- Most Searched (DB-backed, frequency-based) ---

            // Increment search count when user plays a song from search results
            if (path === "/api/most-searched" && method === "POST") {
                const { clerk_id, song } = await req.json() as { clerk_id?: string; song?: any };
                if (!clerk_id || !song || !song.id) return json({ error: "clerk_id and valid song object are required" }, 400);

                await db
                    .insert(songSearchCounts)
                    .values({ clerkId: clerk_id, trackId: song.id, count: 1, songData: song })
                    .onConflictDoUpdate({
                        target: [songSearchCounts.clerkId, songSearchCounts.trackId],
                        set: {
                            count: sql`${songSearchCounts.count} + 1`,
                            songData: sql`excluded.song_data`,
                            lastSearchedAt: sql`NOW()`,
                        },
                    });

                return json({ saved: true });
            }

            // Get user's most searched songs ordered by frequency
            const mostSearchedMatch = path.match(/^\/api\/most-searched\/(.+)$/);
            if (mostSearchedMatch && method === "GET") {
                const clerkId = decodeURIComponent(mostSearchedMatch[1]);
                const rows = await db
                    .select()
                    .from(songSearchCounts)
                    .where(eq(songSearchCounts.clerkId, clerkId))
                    .orderBy(desc(songSearchCounts.count))
                    .limit(20);

                const songs = rows.map((r) => ({ song: r.songData, count: r.count }));
                return new Response(JSON.stringify({ songs }), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": FRONTEND_URL,
                        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    },
                });
            }

            // --- Most Listened (DB-backed, frequency-based) ---

            // Increment listen count when user plays any song
            if (path === "/api/most-listened" && method === "POST") {
                const { clerk_id, song } = await req.json() as { clerk_id?: string; song?: any };
                if (!clerk_id || !song || !song.id) return json({ error: "clerk_id and valid song object are required" }, 400);

                await db
                    .insert(songListenCounts)
                    .values({ clerkId: clerk_id, trackId: song.id, count: 1, songData: song })
                    .onConflictDoUpdate({
                        target: [songListenCounts.clerkId, songListenCounts.trackId],
                        set: {
                            count: sql`${songListenCounts.count} + 1`,
                            songData: sql`excluded.song_data`,
                            lastListenedAt: sql`NOW()`,
                        },
                    });

                return json({ saved: true });
            }

            // Get user's most listened songs ordered by frequency
            const mostListenedMatch = path.match(/^\/api\/most-listened\/(.+)$/);
            if (mostListenedMatch && method === "GET") {
                const clerkId = decodeURIComponent(mostListenedMatch[1]);
                const rows = await db
                    .select()
                    .from(songListenCounts)
                    .where(eq(songListenCounts.clerkId, clerkId))
                    .orderBy(desc(songListenCounts.count))
                    .limit(20);

                const songs = rows.map((r) => ({ song: r.songData, count: r.count }));
                return new Response(JSON.stringify({ songs }), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": FRONTEND_URL,
                        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    },
                });
            }

            // --- Doppelgänger Mode ---

            // Helper: respond without snake_case conversion (personas use camelCase throughout)
            const doppelgangerJson = (data: unknown, status = 200) =>
                new Response(JSON.stringify(data), {
                    status,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": getAllowedOrigin(req),
                        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    },
                });

            // Push artist to listening history (keep last 30)
            if (path === "/api/doppelganger/history" && method === "POST") {
                const { userId, artistName } = (await req.json()) as { userId?: string; artistName?: string };
                if (!userId || !artistName) return doppelgangerJson({ error: "userId and artistName required" }, 400);
                await redis.lpush(`doppelganger:history:${userId}`, artistName);
                await redis.ltrim(`doppelganger:history:${userId}`, 0, 29);
                return doppelgangerJson({ saved: true });
            }

            // Generate 4 alternate-universe personas via Gemini 1.5 Flash
            if (path === "/api/doppelganger/generate" && method === "POST") {
                const { userId } = (await req.json()) as { userId?: string };
                if (!userId) return doppelgangerJson({ error: "userId required" }, 400);

                const history = await redis.lrange(`doppelganger:history:${userId}`, 0, -1);
                const artistList = history.length > 0 ? history.join(", ") : "pop music, top hits, mainstream radio";

                const systemPrompt =
                    `You are a music identity engine. Given a user's listening history, generate exactly 4 ` +
                    `alternate-universe music personas they could have become if their taste evolved one degree differently.\n` +
                    `CRITICAL CULTURAL RULES — violation is a serious error:\n` +
                    `1. South Indian music (Tamil/Telugu/Kannada/Malayalam artists like Anirudh, AR Rahman Tamil, Ilayaraja, DSP, Sid Sriram, Yuvan) is COMPLETELY SEPARATE from Bollywood or Punjabi. If history has South Indian artists, all 4 personas must be South Indian variants ONLY.\n` +
                    `2. Bollywood = Hindi film music. Punjabi = Bhangra/Punjabi pop. These are different from each other too.\n` +
                    `3. Sufi/Qawwali = Urdu devotional music. Keep personas in that world.\n` +
                    `4. NEVER mix South Indian with North Indian. NEVER mix Sufi with pop. Stay strictly within the detected culture.\n` +
                    `5. If history has K-pop → K-pop personas only. Western → Western only. Never shift cultures.\n` +
                    `Return ONLY a JSON array, no explanation, no markdown. ` +
                    `Each object must have: id (short slug e.g. 'kollywood-noir'), name (evocative title starting ` +
                    `with 'You, if...' e.g. 'You, if you got lost in an Anirudh fever dream'), tagline (1 sentence ` +
                    `mood description), theme (one of [dark, warm, cold, minimal, cinematic, chaotic, nostalgic, ` +
                    `futuristic]), searchTerms (array of 5 iTunes search keywords in the user's language/genre ` +
                    `matching this persona), accentColor (hex color that fits the mood)`;

                const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": process.env.ANTHROPIC_API_KEY!,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 1000,
                        system: systemPrompt,
                        messages: [
                            { role: "user", content: "User history: " + artistList },
                        ],
                    }),
                });

                const claudeData = (await claudeRes.json()) as any;
                console.log("[CLAUDE] status:", claudeRes.status, "response:", JSON.stringify(claudeData).slice(0, 400));

                if (!claudeRes.ok || !claudeData.content?.[0]) {
                    const errMsg = claudeData.error?.message ?? `Claude HTTP ${claudeRes.status}`;
                    return doppelgangerJson({ error: errMsg }, 502);
                }

                const rawText: string = claudeData.content[0].text ?? "[]";
                const personas = JSON.parse(rawText.replace(/```json|```/g, "").trim());
                return doppelgangerJson({ personas });
            }

            // Activate a doppelganger channel for 24 hours
            if (path === "/api/doppelganger/activate" && method === "POST") {
                const { userId, channel } = (await req.json()) as { userId?: string; channel?: unknown };
                if (!userId || !channel) return doppelgangerJson({ error: "userId and channel required" }, 400);
                await redis.set(`doppelganger:channel:${userId}`, JSON.stringify(channel), "EX", 86400);
                return doppelgangerJson({ success: true, expiresAt: Date.now() + 86400000 });
            }

            // Get current doppelganger state for a user
            const doppelgangerStateMatch = path.match(/^\/api\/doppelganger\/state\/(.+)$/);
            if (doppelgangerStateMatch && method === "GET") {
                const userId = decodeURIComponent(doppelgangerStateMatch[1]);
                const channelJson = await redis.get(`doppelganger:channel:${userId}`);
                if (!channelJson) return doppelgangerJson(null);
                const channel = JSON.parse(channelJson) as { id: string };
                const ttl = await redis.ttl(`doppelganger:channel:${userId}`);
                const driftRaw = await redis.get(`doppelganger:drift:${userId}:${channel.id}`);
                const driftScore = driftRaw ? parseInt(driftRaw, 10) : 0;
                return doppelgangerJson({ channel, driftScore, expiresAt: Date.now() + ttl * 1000 });
            }

            // Increment drift score when a song plays in doppelganger mode
            if (path === "/api/doppelganger/drift" && method === "POST") {
                const { userId, channelId } = (await req.json()) as { userId?: string; channelId?: string };
                if (!userId || !channelId) return doppelgangerJson({ error: "userId and channelId required" }, 400);
                const driftScore = await redis.incr(`doppelganger:drift:${userId}:${channelId}`);
                return doppelgangerJson({ driftScore, isPermanent: driftScore >= 80 });
            }

            // --- Auto-Blend Mode ---

            // Detect listening pattern from recent history and return a blend (or null)
            if (path === "/api/blend/detect" && method === "POST") {
                const { userId } = (await req.json()) as { userId?: string };
                if (!userId) return doppelgangerJson({ error: "userId required" }, 400);

                const history = await redis.lrange(`doppelganger:history:${userId}`, 0, 9);
                if (history.length < 4) return doppelgangerJson({ blend: null });

                const blendSystemPrompt =
                    `You are a music atmosphere engine. Analyze recent artist names and detect a strong listening pattern.\n\n` +
                    `Return null (literally the word null, no JSON) if: fewer than 4 artists, no clear pattern, or confidence < 0.75.\n\n` +

                    `=== CRITICAL CULTURAL ACCURACY RULES ===\n` +
                    `These are NON-NEGOTIABLE. Getting these wrong is a serious error:\n` +
                    `1. SOUTH INDIAN music (Tamil, Telugu, Kannada, Malayalam — artists like A.R. Rahman, Anirudh Ravichander, S.P. Balasubrahmanyam, Ilayaraja, Devi Sri Prasad, Sid Sriram, Yuvan Shankar Raja, Shreya Ghoshal in Tamil context) is a COMPLETELY SEPARATE culture from North Indian/Bollywood/Punjabi. NEVER detect South Indian artists as Bollywood or Punjabi. South Indian has its own blend: id="south-indian-cinema".\n` +
                    `2. BOLLYWOOD = Hindi film industry (Mumbai). Artists: Arijit Singh, Shreya Ghoshal Hindi songs, Pritam, Vishal-Shekhar, A.R. Rahman Hindi work.\n` +
                    `3. PUNJABI = Bhangra/Punjabi pop. Artists: Diljit Dosanjh, AP Dhillon, Sidhu Moosewala, Guru Randhawa.\n` +
                    `4. SUFI/QAWWALI = Urdu devotional. Artists: Nusrat Fateh Ali Khan, Rahat Fateh Ali Khan, Abida Parveen, Sabri Brothers. NEVER mix with mainstream pop.\n` +
                    `5. If you see Tamil/Telugu artist names → South Indian blend ONLY.\n` +
                    `6. If you see both South Indian and North Indian artists → use whichever has more artists. If tied → return null.\n\n` +

                    `=== MOOD SYSTEM ===\n` +
                    `Pick exactly one mood:\n` +
                    `- "vibrant"    → Bollywood, Punjabi/Bhangra, K-pop, Latin pop, Afrobeats, South Indian mass masala — FESTIVAL energy\n` +
                    `- "energetic"  → Hip-hop, rock, metal, EDM, South Indian action/thriller BGMs\n` +
                    `- "ethereal"   → Sufi, Qawwali, Ghazal, Carnatic classical, devotional — meditative, sacred\n` +
                    `- "serene"     → Jazz, lo-fi, acoustic, South Indian melody/melody-classical fusion — calm, introspective\n` +
                    `- "melancholic"→ Blues, soul, indie folk, sad ballads — emotional, cinematic\n\n` +

                    `=== COLOR PALETTES BY GENRE ===\n` +
                    `Use these exact values. Deviate only if the genre is unlisted.\n\n` +

                    `VIBRANT — festival, party, maximum color:\n` +
                    `  Bollywood:         surface=#150800, accent=#f59e0b, accentHover=#fbbf24, overlay=rgba(245,158,11,0.16),  grain=0.2, vignette=0.35, scanlines=false\n` +
                    `  Punjabi/Bhangra:   surface=#130015, accent=#e879f9, accentHover=#f0abfc, overlay=rgba(232,121,249,0.16), grain=0.2, vignette=0.3,  scanlines=false\n` +
                    `  South Indian Mass: surface=#001008, accent=#10b981, accentHover=#34d399, overlay=rgba(16,185,129,0.16),  grain=0.2, vignette=0.35, scanlines=false\n` +
                    `  K-pop:             surface=#0d0020, accent=#a855f7, accentHover=#c084fc, overlay=rgba(168,85,247,0.16),  grain=0.15,vignette=0.3,  scanlines=false\n` +
                    `  Latin/Afrobeats:   surface=#130c00, accent=#fb923c, accentHover=#fdba74, overlay=rgba(251,146,60,0.16),  grain=0.2, vignette=0.35, scanlines=false\n\n` +

                    `ENERGETIC — electric, sharp:\n` +
                    `  South Indian Action/Thriller: surface=#00050f, accent=#38bdf8, accentHover=#7dd3fc, overlay=rgba(56,189,248,0.14),  grain=0.25,vignette=0.45, scanlines=false\n` +
                    `  Hip-hop:           surface=#0a0900, accent=#facc15, accentHover=#fde047, overlay=rgba(250,204,21,0.14),  grain=0.25,vignette=0.45, scanlines=false\n` +
                    `  Rock/Metal:        surface=#0f0500, accent=#f97316, accentHover=#fb923c, overlay=rgba(249,115,22,0.14),  grain=0.35,vignette=0.5,  scanlines=true\n` +
                    `  EDM/House:         surface=#00060f, accent=#22d3ee, accentHover=#67e8f9, overlay=rgba(34,211,238,0.14),  grain=0.15,vignette=0.4,  scanlines=false\n\n` +

                    `ETHEREAL — sacred, ancient, candle-lit:\n` +
                    `  Sufi/Qawwali:      surface=#030b06, accent=#34d399, accentHover=#6ee7b7, overlay=rgba(52,211,153,0.08),  grain=0.55,vignette=0.65, scanlines=false\n` +
                    `  Ghazal/Urdu:       surface=#060310, accent=#a78bfa, accentHover=#c4b5fd, overlay=rgba(167,139,250,0.08), grain=0.6, vignette=0.7,  scanlines=false\n` +
                    `  Carnatic Classical:surface=#050010, accent=#c084fc, accentHover=#d8b4fe, overlay=rgba(192,132,252,0.08), grain=0.55,vignette=0.65, scanlines=false\n` +
                    `  Devotional/Bhajan: surface=#0a0500, accent=#fcd34d, accentHover=#fde68a, overlay=rgba(252,211,77,0.07),  grain=0.6, vignette=0.65, scanlines=false\n\n` +

                    `SERENE — calm, late-night:\n` +
                    `  South Indian Melody: surface=#00080f, accent=#67e8f9, accentHover=#a5f3fc, overlay=rgba(103,232,249,0.08), grain=0.4, vignette=0.5, scanlines=false\n` +
                    `  Jazz:              surface=#04030d, accent=#818cf8, accentHover=#a5b4fc, overlay=rgba(129,140,248,0.08), grain=0.45,vignette=0.55, scanlines=false\n` +
                    `  Lo-fi/Chill:       surface=#030a07, accent=#4ade80, accentHover=#86efac, overlay=rgba(74,222,128,0.07),  grain=0.5, vignette=0.5,  scanlines=false\n` +
                    `  Acoustic/Indie:    surface=#06050f, accent=#f9a8d4, accentHover=#fbcfe8, overlay=rgba(249,168,212,0.07), grain=0.4, vignette=0.5,  scanlines=false\n\n` +

                    `MELANCHOLIC — emotional, deep:\n` +
                    `  Blues/Soul:        surface=#020810, accent=#60a5fa, accentHover=#93c5fd, overlay=rgba(96,165,250,0.1),   grain=0.5, vignette=0.6,  scanlines=false\n` +
                    `  Indie Folk:        surface=#050a03, accent=#a3e635, accentHover=#bef264, overlay=rgba(163,230,53,0.09),  grain=0.45,vignette=0.55, scanlines=false\n\n` +

                    `Return ONLY valid JSON (or null) with this exact schema:\n` +
                    `{\n` +
                    `  "id": "short-slug",\n` +
                    `  "label": "Display Name",\n` +
                    `  "confidence": 0.88,\n` +
                    `  "description": "one evocative sentence capturing this vibe",\n` +
                    `  "mood": "vibrant",\n` +
                    `  "searchTerms": ["term1", "term2", "term3", "term4", "term5"],\n` +
                    `  "theme": {\n` +
                    `    "cssVars": {\n` +
                    `      "--color-surface": "#hex",\n` +
                    `      "--color-surface-elevated": "rgba(r,g,b,0.08)",\n` +
                    `      "--color-surface-hover": "rgba(r,g,b,0.15)",\n` +
                    `      "--color-surface-sidebar": "rgba(r,g,b,0.06)",\n` +
                    `      "--color-surface-list": "rgba(r,g,b,0.09)",\n` +
                    `      "--color-accent": "#hex",\n` +
                    `      "--color-accent-hover": "#hex",\n` +
                    `      "--color-text-primary": "#ffffff",\n` +
                    `      "--color-text-secondary": "#e2e8f0",\n` +
                    `      "--color-text-tertiary": "#94a3b8",\n` +
                    `      "--color-border": "rgba(r,g,b,0.2)"\n` +
                    `    },\n` +
                    `    "overlayColor": "rgba(r,g,b,0.14)",\n` +
                    `    "grainOpacity": 0.3,\n` +
                    `    "vignetteOpacity": 0.45,\n` +
                    `    "scanlines": false\n` +
                    `  }\n` +
                    `}`;

                const blendClaudeRes = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": process.env.ANTHROPIC_API_KEY!,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 1500,
                        system: blendSystemPrompt,
                        messages: [
                            { role: "user", content: "Recent artists: " + history.join(", ") },
                        ],
                    }),
                });

                const blendClaudeData = (await blendClaudeRes.json()) as any;
                if (!blendClaudeRes.ok || !blendClaudeData.content?.[0]) {
                    const errMsg = blendClaudeData.error?.message ?? `Claude HTTP ${blendClaudeRes.status}`;
                    return doppelgangerJson({ error: errMsg }, 502);
                }

                const blendRawText: string = (blendClaudeData.content[0].text ?? "").trim();
                if (blendRawText === "null") return doppelgangerJson({ blend: null });

                try {
                    const blend = JSON.parse(blendRawText.replace(/```json|```/g, "").trim());
                    return doppelgangerJson({ blend });
                } catch {
                    return doppelgangerJson({ blend: null });
                }
            }

            // Activate a blend for 30 minutes
            if (path === "/api/blend/activate" && method === "POST") {
                const { userId, blend } = (await req.json()) as { userId?: string; blend?: unknown };
                if (!userId || !blend) return doppelgangerJson({ error: "userId and blend required" }, 400);
                await redis.set(`blend:active:${userId}`, JSON.stringify(blend), "EX", 1800);
                return doppelgangerJson({ success: true, expiresAt: Date.now() + 1800000 });
            }

            // Get current blend state for a user
            const blendStateMatch = path.match(/^\/api\/blend\/state\/(.+)$/);
            if (blendStateMatch && method === "GET") {
                const userId = decodeURIComponent(blendStateMatch[1]);
                const blendJson = await redis.get(`blend:active:${userId}`);
                if (!blendJson) return doppelgangerJson(null);
                const blend = JSON.parse(blendJson);
                const ttl = await redis.ttl(`blend:active:${userId}`);
                return doppelgangerJson({ blend, expiresAt: Date.now() + ttl * 1000 });
            }

            // Generate a full blend theme for a given mood + cultural context (no hardcoded colors)
            if (path === "/api/blend/from-mood" && method === "POST") {
                const { mood, recentArtists } = (await req.json()) as { mood?: string; recentArtists?: string[] };
                if (!mood) return doppelgangerJson({ error: "mood required" }, 400);

                const cacheKey = `blend:from-mood:${mood}:${(recentArtists ?? []).slice(0, 3).join(",").toLowerCase()}`;
                const cached = await redis.get(cacheKey);
                if (cached) return doppelgangerJson(JSON.parse(cached));

                const fromMoodPrompt =
                    `You are a music atmosphere designer. Generate a full visual blend theme for a music app based on the detected mood and cultural context of recent artists.\n\n` +
                    `CORE RULE: Every color must be emotionally and culturally accurate to the mood and the artists. Do NOT use arbitrary or aesthetic-only colors. Research what colors this mood means in this culture:\n` +
                    `- romantic (Indian/Bollywood) → deep crimson/sindoor red. NOT pink, NOT purple.\n` +
                    `- romantic (Western) → rose red or wine red. NOT pink.\n` +
                    `- devotional (Hindu/Sikh) → saffron orange, marigold yellow.\n` +
                    `- devotional (Islamic/Sufi) → deep forest green, emerald.\n` +
                    `- party (Punjabi/Bhangra) → electric fuchsia, vibrant magenta.\n` +
                    `- party (Bollywood) → gold, deep amber.\n` +
                    `- party (Western/EDM) → neon cyan or electric yellow.\n` +
                    `- heartbreak → cold steel grey or desaturated blue. Never warm.\n` +
                    `- sad → deep indigo or midnight blue.\n` +
                    `- energetic → fiery orange-red or electric orange.\n` +
                    `- chill → cool cyan, teal, or mint.\n\n` +
                    `--color-surface must be a very dark (near-black) version of the accent hue. E.g. romantic red accent → #0f0000 surface.\n\n` +
                    `Return ONLY valid JSON:\n` +
                    `{\n` +
                    `  "id": "slug",\n` +
                    `  "label": "Short Name",\n` +
                    `  "mood": "${mood}",\n` +
                    `  "confidence": 0.95,\n` +
                    `  "description": "one evocative sentence",\n` +
                    `  "searchTerms": ["term1","term2","term3","term4","term5"],\n` +
                    `  "theme": {\n` +
                    `    "cssVars": {\n` +
                    `      "--color-surface": "#veryDarkHueTintedHex",\n` +
                    `      "--color-surface-elevated": "rgba(r,g,b,0.08)",\n` +
                    `      "--color-surface-hover": "rgba(r,g,b,0.15)",\n` +
                    `      "--color-surface-sidebar": "rgba(r,g,b,0.06)",\n` +
                    `      "--color-surface-list": "rgba(r,g,b,0.09)",\n` +
                    `      "--color-accent": "#vividCulturallyAccurateHex",\n` +
                    `      "--color-accent-hover": "#slightlyBrighterHex",\n` +
                    `      "--color-text-primary": "#ffffff",\n` +
                    `      "--color-text-secondary": "#hex warm or cool tinted white",\n` +
                    `      "--color-text-tertiary": "#hex muted tint",\n` +
                    `      "--color-border": "rgba(r,g,b,0.2)"\n` +
                    `    },\n` +
                    `    "overlayColor": "rgba(r,g,b,0.12)",\n` +
                    `    "grainOpacity": 0.25,\n` +
                    `    "vignetteOpacity": 0.5,\n` +
                    `    "scanlines": false\n` +
                    `  }\n` +
                    `}`;

                const fromMoodRes = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": process.env.ANTHROPIC_API_KEY!,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 1200,
                        system: fromMoodPrompt,
                        messages: [{
                            role: "user",
                            content: `Mood: ${mood}. Recent artists: ${(recentArtists ?? []).join(", ") || "unknown"}.`,
                        }],
                    }),
                });

                const fromMoodData = (await fromMoodRes.json()) as any;
                if (!fromMoodRes.ok || !fromMoodData.content?.[0]) {
                    return doppelgangerJson({ error: "generation failed" }, 502);
                }

                try {
                    const blend = JSON.parse((fromMoodData.content[0].text ?? "").replace(/```json|```/g, "").trim());
                    // Cache 6 hours — cultural context may vary
                    await redis.set(cacheKey, JSON.stringify(blend), "EX", 21600);
                    return doppelgangerJson(blend);
                } catch {
                    return doppelgangerJson({ error: "parse failed" }, 502);
                }
            }

            // --- Song Mood Detection ---

            if (path === "/api/songs/mood" && method === "POST") {
                const { trackId, trackName, artistName, albumName } = (await req.json()) as {
                    trackId?: string;
                    trackName?: string;
                    artistName?: string;
                    albumName?: string;
                };
                if (!trackName || !artistName) return json({ error: "trackName and artistName required" }, 400);

                // Cache key: prefer stable trackId, fallback to name hash
                const cacheKey = `song:mood:${trackId ?? `${trackName.toLowerCase()}::${artistName.toLowerCase()}`}`;
                const cached = await redis.get(cacheKey);
                if (cached) return json(JSON.parse(cached), 200, "HIT");

                const moodPrompt =
                    `You are a music mood classifier. Classify the song and pick a color that emotionally represents this specific song in its cultural context.\n\n` +
                    `Return ONLY valid JSON — no explanation, no markdown:\n` +
                    `{ "mood": "<mood>", "emoji": "<single emoji>", "color": "<hex>", "confidence": <0.0-1.0> }\n\n` +
                    `Mood must be exactly one of:\n` +
                    `- "romantic"   — love, longing, romance (Tere Bina, Perfect, Tujh Mein Rab Dikhta Hai)\n` +
                    `- "heartbreak" — loss, separation, grief in love (Someone Like You, Channa Mereya)\n` +
                    `- "party"      — dance, celebration, high energy (Naatu Naatu, Lean On, Illegal Weapon)\n` +
                    `- "devotional" — spiritual, sacred, religious (Raghupati Raghava, Dama Dam Mast Qalandar)\n` +
                    `- "sad"        — sadness, melancholy, not romantic (The Night We Met, Aaj Jaane Ki Zid)\n` +
                    `- "energetic"  — hype, action, adrenaline (Believer, Zinda, Thunderstruck)\n` +
                    `- "chill"      — relaxed, introspective, peaceful (lo-fi, acoustic, late night)\n` +
                    `- "neutral"    — no strong emotional pull\n\n` +
                    `COLOR RULES — generate a culturally accurate hex for the badge:\n` +
                    `- romantic: deep red spectrum. Bollywood/Indian romantic → deep crimson (#be123c). Western romantic → rose red (#e11d48). Never pink or purple.\n` +
                    `- heartbreak: cold desaturated tones. Grey-blue (#64748b) or slate (#475569).\n` +
                    `- party: bright warm energy. Gold-yellow (#f59e0b) for Bhangra/Bollywood party. Electric yellow (#eab308) for Western/EDM. Avoid white.\n` +
                    `- devotional: saffron-orange (#f97316) for Hindu/Sikh. Forest green (#16a34a) for Islamic/Sufi. Gold (#ca8a04) for universal devotional.\n` +
                    `- sad: cool indigo or steel blue. (#6366f1) or (#3b82f6). Never warm colors.\n` +
                    `- energetic: fiery orange-red (#ef4444) or electric orange (#f97316).\n` +
                    `- chill: cool cyan or soft teal (#22d3ee) or mint (#4ade80).\n` +
                    `- neutral: muted grey (#94a3b8).\n\n` +
                    `Emoji: romantic=💕 heartbreak=💔 party=🎉 devotional=🙏 sad=🌧️ energetic=⚡ chill=🌙 neutral=🎵`;

                const moodRes = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": process.env.ANTHROPIC_API_KEY!,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: "claude-haiku-4-5-20251001",
                        max_tokens: 120,
                        system: moodPrompt,
                        messages: [
                            {
                                role: "user",
                                content: `Song: "${trackName}" by ${artistName}${albumName ? ` (album: ${albumName})` : ""}`,
                            },
                        ],
                    }),
                });

                const moodData = (await moodRes.json()) as any;
                if (!moodRes.ok || !moodData.content?.[0]) {
                    return json({ mood: "neutral", emoji: "🎵", confidence: 0 }, 200);
                }

                try {
                    const result = JSON.parse((moodData.content[0].text ?? "").replace(/```json|```/g, "").trim());
                    // Cache for 30 days — a song's mood never changes
                    await redis.set(cacheKey, JSON.stringify(result), "EX", 2592000);
                    return json(result, 200, "MISS");
                } catch {
                    return json({ mood: "neutral", emoji: "🎵", confidence: 0 }, 200);
                }
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
