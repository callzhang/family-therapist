CREATE TABLE `agreement_versions` (
	`space_id` text NOT NULL,
	`agreement_id` text NOT NULL,
	`thread_id` text,
	`message_seq` integer NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`confirmed` integer NOT NULL,
	PRIMARY KEY(`space_id`, `agreement_id`, `message_seq`),
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agreement_versions_snapshot` ON `agreement_versions` (`space_id`,`agreement_id`,`message_seq`);--> statement-breakpoint
CREATE TABLE `members` (
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`space_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL,
	`space_id` text NOT NULL,
	`thread_id` text,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`body_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_message_id_unique` ON `messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `messages_space_thread_seq` ON `messages` (`space_id`,`thread_id`,`seq`);--> statement-breakpoint
CREATE TABLE `thread_versions` (
	`space_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_seq` integer NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	PRIMARY KEY(`space_id`, `thread_id`, `message_seq`),
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `thread_versions_snapshot` ON `thread_versions` (`space_id`,`thread_id`,`message_seq`);