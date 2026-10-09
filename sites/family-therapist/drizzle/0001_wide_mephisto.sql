PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agreement_versions` (
	`space_id` text NOT NULL,
	`agreement_id` text NOT NULL,
	`thread_id` text,
	`message_seq` integer NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`confirmed` integer NOT NULL,
	PRIMARY KEY(`space_id`, `agreement_id`, `message_seq`),
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agreement_versions_confirmed_check" CHECK("__new_agreement_versions"."confirmed" IN (0, 1)),
	CONSTRAINT "agreement_versions_version_check" CHECK("__new_agreement_versions"."version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_agreement_versions`("space_id", "agreement_id", "thread_id", "message_seq", "version", "text", "confirmed") SELECT "space_id", "agreement_id", "thread_id", "message_seq", "version", "text", "confirmed" FROM `agreement_versions`;--> statement-breakpoint
DROP TABLE `agreement_versions`;--> statement-breakpoint
ALTER TABLE `__new_agreement_versions` RENAME TO `agreement_versions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agreement_versions_snapshot` ON `agreement_versions` (`space_id`,`agreement_id`,`message_seq`);--> statement-breakpoint
CREATE TABLE `__new_thread_versions` (
	`space_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_seq` integer NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	PRIMARY KEY(`space_id`, `thread_id`, `message_seq`),
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "thread_versions_status_check" CHECK("__new_thread_versions"."status" IN ('pending', 'active', 'settled'))
);
--> statement-breakpoint
INSERT INTO `__new_thread_versions`("space_id", "thread_id", "message_seq", "title", "status", "summary") SELECT "space_id", "thread_id", "message_seq", "title", "status", "summary" FROM `thread_versions`;--> statement-breakpoint
DROP TABLE `thread_versions`;--> statement-breakpoint
ALTER TABLE `__new_thread_versions` RENAME TO `thread_versions`;--> statement-breakpoint
CREATE INDEX `thread_versions_snapshot` ON `thread_versions` (`space_id`,`thread_id`,`message_seq`);