CREATE TABLE `discussion_projection` (
	`space_id` text PRIMARY KEY NOT NULL,
	`storage_revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`last_command_id` text NOT NULL,
	CONSTRAINT "discussion_projection_revision_check" CHECK("discussion_projection"."storage_revision" > 0)
);
