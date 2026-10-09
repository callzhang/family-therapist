import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, primaryKey, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const members = sqliteTable('members', {
  spaceId: text('space_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
}, (table) => [primaryKey({ columns: [table.spaceId, table.userId] })]);

export const memberTokens = sqliteTable('member_tokens', {
  tokenSha256: text('token_sha256').primaryKey(),
  spaceId: text('space_id').notNull(),
  userId: text('user_id').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => [
  uniqueIndex('member_tokens_space_user_unique').on(table.spaceId, table.userId),
  foreignKey({ columns: [table.spaceId, table.userId], foreignColumns: [members.spaceId, members.userId] }).onDelete('cascade'),
]);

export const messages = sqliteTable('messages', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  messageId: text('message_id').notNull(),
  spaceId: text('space_id').notNull(),
  threadId: text('thread_id'),
  kind: text('kind').notNull(),
  actorId: text('actor_id').notNull(),
  bodyJson: text('body_json').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('messages_message_id_unique').on(table.messageId), index('messages_space_thread_seq').on(table.spaceId, table.threadId, table.seq)]);

export const therapistTasks = sqliteTable('therapist_tasks', {
  messageId: text('message_id').notNull().primaryKey().references(() => messages.messageId),
  messageSeq: integer('message_seq').notNull().references(() => messages.seq),
  spaceId: text('space_id').notNull(),
  threadId: text('thread_id').notNull(),
  status: text('status', { enum: ['queued'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [check('therapist_tasks_status_check', sql`${table.status} = 'queued'`), index('therapist_tasks_status_created').on(table.status, table.createdAt)]);

export const threadVersions = sqliteTable('thread_versions', {
  spaceId: text('space_id').notNull(),
  threadId: text('thread_id').notNull(),
  messageSeq: integer('message_seq').notNull().references(() => messages.seq),
  title: text('title').notNull(),
  status: text('status', { enum: ['pending', 'active', 'settled'] }).notNull(),
  summary: text('summary').notNull(),
}, (table) => [primaryKey({ columns: [table.spaceId, table.threadId, table.messageSeq] }), check('thread_versions_status_check', sql`${table.status} IN ('pending', 'active', 'settled')`), index('thread_versions_snapshot').on(table.spaceId, table.threadId, table.messageSeq)]);

export const agreementVersions = sqliteTable('agreement_versions', {
  spaceId: text('space_id').notNull(),
  agreementId: text('agreement_id').notNull(),
  threadId: text('thread_id'),
  messageSeq: integer('message_seq').notNull().references(() => messages.seq),
  version: integer('version').notNull(),
  text: text('text').notNull(),
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull(),
}, (table) => [primaryKey({ columns: [table.spaceId, table.agreementId, table.messageSeq] }), check('agreement_versions_confirmed_check', sql`${table.confirmed} IN (0, 1)`), check('agreement_versions_version_check', sql`${table.version} > 0`), index('agreement_versions_snapshot').on(table.spaceId, table.agreementId, table.messageSeq)]);
