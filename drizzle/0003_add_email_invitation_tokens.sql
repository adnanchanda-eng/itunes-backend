CREATE TABLE IF NOT EXISTS "email_invitation_tokens" (
    "id" serial PRIMARY KEY NOT NULL,
    "invitation_id" varchar(255) NOT NULL,
    "playlist_id" integer NOT NULL,
    "email" varchar(255) NOT NULL,
    "shared_by_clerk_id" varchar(255) NOT NULL,
    "accepted" boolean DEFAULT false,
    "created_at" timestamp DEFAULT now(),
    "expires_at" timestamp,
    CONSTRAINT "email_invitation_tokens_invitation_id_unique" UNIQUE("invitation_id")
);

ALTER TABLE "email_invitation_tokens" ADD CONSTRAINT "email_invitation_tokens_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "email_invitation_tokens" ADD CONSTRAINT "email_invitation_tokens_shared_by_clerk_id_users_clerk_id_fk" FOREIGN KEY ("shared_by_clerk_id") REFERENCES "public"."users"("clerk_id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "idx_email_invitation_tokens_invitation_id" ON "email_invitation_tokens" USING btree ("invitation_id");
CREATE INDEX IF NOT EXISTS "idx_email_invitation_tokens_email" ON "email_invitation_tokens" USING btree ("email");
