import crypto from "crypto";

import { createClerkClient } from "@clerk/backend";
import { eq, sql, and } from "drizzle-orm";

import { db } from "./db";
import { users, playlists, playlistSongs, playlistShares, playlistShareTokens, playlistClaimCopies, pendingPlaylistShares, emailInvitationTokens } from "./db/schema";
import { cacheGet, cacheSet, cacheDel, cacheDelPattern, redis } from "./redis";

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

// Cache TTL constants (seconds)
const CACHE_TTL_PLAYLISTS = 300;   // 5 minutes
const CACHE_TTL_SEARCH_HISTORY = 604800; // 7 days

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
                if (cached) return json(cached);

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
                return json(result);
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
                const { email, shared_by_clerk_id } = await req.json();
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
                if (cached) return json(cached);

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
                return json(result);
            }

            // Add a song to a playlist (owner only)
            const addSongMatch = path.match(/^\/api\/playlists\/(\d+)\/songs$/);
            if (addSongMatch && method === "POST") {
                const { track_id, title, artist_name, album_art, preview_url, collection_name, duration, clerk_id } = await req.json();
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
                if (cached) return json(cached);

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
                const { name, description, clerk_id } = await req.json();
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
                const { clerk_id } = await req.json();
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
                });
            }

            // Claim a playlist via share token (authenticated) — creates a COPY owned by claimant for full ownership
            const claimByTokenMatch = path.match(/^\/api\/playlists\/claim-by-token\/([a-fA-F0-9]+)$/);
            if (claimByTokenMatch && method === "POST") {
                const token = claimByTokenMatch[1];
                const { clerk_id } = await req.json();
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

            // Get user's recent search history (last 5 songs)
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
                    // Fetch existing, prepend new (filtering out duplicates), slice to 5, save
                    let history = [];
                    const cached = await redis.get(key);
                    if (cached) {
                        history = JSON.parse(cached);
                    }
                    
                    history = [song, ...history.filter((s: any) => s.id !== song.id)].slice(0, 5);
                    
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
