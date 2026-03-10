CREATE TABLE "playlist_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"playlist_id" integer NOT NULL,
	"shared_with_clerk_id" varchar(255) NOT NULL,
	"shared_by_clerk_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "playlist_songs" (
	"id" serial PRIMARY KEY NOT NULL,
	"playlist_id" integer NOT NULL,
	"track_id" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"artist_name" varchar(255) NOT NULL,
	"album_art" text,
	"preview_url" text,
	"collection_name" varchar(255),
	"duration" integer,
	"position" integer NOT NULL,
	"added_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"username" varchar(255),
	"email" varchar(255),
	"first_name" varchar(255),
	"last_name" varchar(255),
	"profile_image" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id")
);
--> statement-breakpoint
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_shared_with_clerk_id_users_clerk_id_fk" FOREIGN KEY ("shared_with_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_shares" ADD CONSTRAINT "playlist_shares_shared_by_clerk_id_users_clerk_id_fk" FOREIGN KEY ("shared_by_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_songs" ADD CONSTRAINT "playlist_songs_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_clerk_id_users_clerk_id_fk" FOREIGN KEY ("clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_shares_playlist_id_shared_with_unique" ON "playlist_shares" USING btree ("playlist_id","shared_with_clerk_id");--> statement-breakpoint
CREATE INDEX "idx_playlist_shares_shared_with" ON "playlist_shares" USING btree ("shared_with_clerk_id");--> statement-breakpoint
CREATE INDEX "idx_playlist_songs_playlist_id" ON "playlist_songs" USING btree ("playlist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_songs_playlist_id_track_id_unique" ON "playlist_songs" USING btree ("playlist_id","track_id");--> statement-breakpoint
CREATE INDEX "idx_playlists_clerk_id" ON "playlists" USING btree ("clerk_id");--> statement-breakpoint
CREATE INDEX "idx_users_clerk_id" ON "users" USING btree ("clerk_id");