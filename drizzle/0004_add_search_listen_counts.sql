CREATE TABLE IF NOT EXISTS "song_search_counts" (
    "id" serial PRIMARY KEY NOT NULL,
    "clerk_id" varchar(255) NOT NULL,
    "track_id" varchar(255) NOT NULL,
    "count" integer NOT NULL DEFAULT 1,
    "song_data" jsonb NOT NULL,
    "last_searched_at" timestamp DEFAULT now()
);

ALTER TABLE "song_search_counts" ADD CONSTRAINT "song_search_counts_clerk_id_users_clerk_id_fk"
    FOREIGN KEY ("clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "song_search_counts_clerk_track_unique"
    ON "song_search_counts" USING btree ("clerk_id", "track_id");

CREATE INDEX IF NOT EXISTS "idx_song_search_counts_clerk_id"
    ON "song_search_counts" USING btree ("clerk_id");

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "song_listen_counts" (
    "id" serial PRIMARY KEY NOT NULL,
    "clerk_id" varchar(255) NOT NULL,
    "track_id" varchar(255) NOT NULL,
    "count" integer NOT NULL DEFAULT 1,
    "song_data" jsonb NOT NULL,
    "last_listened_at" timestamp DEFAULT now()
);

ALTER TABLE "song_listen_counts" ADD CONSTRAINT "song_listen_counts_clerk_id_users_clerk_id_fk"
    FOREIGN KEY ("clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "song_listen_counts_clerk_track_unique"
    ON "song_listen_counts" USING btree ("clerk_id", "track_id");

CREATE INDEX IF NOT EXISTS "idx_song_listen_counts_clerk_id"
    ON "song_listen_counts" USING btree ("clerk_id");
