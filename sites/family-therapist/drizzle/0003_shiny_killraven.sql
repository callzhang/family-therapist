CREATE TABLE `member_tokens` (
	`token_sha256` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`space_id`,`user_id`) REFERENCES `members`(`space_id`,`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_tokens_space_user_unique` ON `member_tokens` (`space_id`,`user_id`);