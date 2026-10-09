PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_therapist_tasks` (
	`message_id` text PRIMARY KEY NOT NULL,
	`message_seq` integer NOT NULL,
	`space_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`input_thread_seq` integer DEFAULT 0 NOT NULL,
	`lease_id` text,
	`lease_expires_at` text,
	`run_snapshot_seq` integer,
	`run_config_json` text,
	`checkpoint_json` text,
	`reply_message_id` text,
	`understanding_message_id` text,
	`candidate_id` text,
	`covered_by` text,
	`last_error_code` text,
	`last_error_at` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`message_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "therapist_tasks_status_check" CHECK("__new_therapist_tasks"."status" IN ('queued', 'running', 'failed', 'obsolete', 'completed')),
	CONSTRAINT "therapist_tasks_input_thread_seq_check" CHECK("__new_therapist_tasks"."input_thread_seq" >= 0)
);
--> statement-breakpoint
-- Existing queued tasks predate capture of their expected thread version. Preserve them as explicit obsolete records.
INSERT INTO `__new_therapist_tasks`("message_id", "message_seq", "space_id", "thread_id", "status", "created_at", "input_thread_seq") SELECT "message_id", "message_seq", "space_id", "thread_id", 'obsolete', "created_at", 0 FROM `therapist_tasks`;--> statement-breakpoint
DROP TABLE `therapist_tasks`;--> statement-breakpoint
ALTER TABLE `__new_therapist_tasks` RENAME TO `therapist_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `therapist_tasks_status_created` ON `therapist_tasks` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `therapist_tasks_one_running_per_thread` ON `therapist_tasks` (`space_id`,`thread_id`) WHERE "therapist_tasks"."status" = 'running';
