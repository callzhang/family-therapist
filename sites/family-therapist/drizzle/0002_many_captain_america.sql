CREATE TABLE `therapist_tasks` (
	`message_id` text PRIMARY KEY NOT NULL,
	`message_seq` integer NOT NULL,
	`space_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "therapist_tasks_status_check" CHECK("therapist_tasks"."status" = 'queued')
);
--> statement-breakpoint
CREATE INDEX `therapist_tasks_status_created` ON `therapist_tasks` (`status`,`created_at`);