CREATE TABLE "playlist_claim_copies" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"claimed_by_clerk_id" varchar(255) NOT NULL,
	"new_playlist_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "playlist_share_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"playlist_id" integer NOT NULL,
	"created_by_clerk_id" varchar(255) NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "playlist_share_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "playlist_claim_copies" ADD CONSTRAINT "playlist_claim_copies_token_playlist_share_tokens_token_fk" FOREIGN KEY ("token") REFERENCES "public"."playlist_share_tokens"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_claim_copies" ADD CONSTRAINT "playlist_claim_copies_claimed_by_clerk_id_users_clerk_id_fk" FOREIGN KEY ("claimed_by_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_claim_copies" ADD CONSTRAINT "playlist_claim_copies_new_playlist_id_playlists_id_fk" FOREIGN KEY ("new_playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_share_tokens" ADD CONSTRAINT "playlist_share_tokens_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_share_tokens" ADD CONSTRAINT "playlist_share_tokens_created_by_clerk_id_users_clerk_id_fk" FOREIGN KEY ("created_by_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_claim_copies_token_claimed_unique" ON "playlist_claim_copies" USING btree ("token","claimed_by_clerk_id");--> statement-breakpoint
CREATE INDEX "idx_playlist_claim_copies_token" ON "playlist_claim_copies" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_token" ON "playlist_share_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_playlist_id" ON "playlist_share_tokens" USING btree ("playlist_id");