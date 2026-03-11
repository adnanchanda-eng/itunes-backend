CREATE TABLE "pending_playlist_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"playlist_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"shared_by_clerk_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "pending_playlist_shares" ADD CONSTRAINT "pending_playlist_shares_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_playlist_shares" ADD CONSTRAINT "pending_playlist_shares_shared_by_clerk_id_users_clerk_id_fk" FOREIGN KEY ("shared_by_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_playlist_shares_playlist_email_unique" ON "pending_playlist_shares" USING btree ("playlist_id","email");
--> statement-breakpoint
CREATE INDEX "idx_pending_playlist_shares_email" ON "pending_playlist_shares" USING btree ("email");
