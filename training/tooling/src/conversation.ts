import type { Database } from "bun:sqlite";

import { settingNumber } from "./settings";

// The rooms' conversation as this tooling reads it (docs/gate-data.md, 「The conversation source」),
// which is always a snapshot of it (`snapshot.ts`), opened read-only and never written.
//
// Only the reads the rows need are here. Nothing interprets a gate's judgement: the past verdicts
// say which turns a gate was asked about and nothing more, because the gates' prompts and their
// structure have moved since those verdicts were given.

export interface ArchivedMessage {
  chatId: number;
  messageId: number;
  senderId: number | null;
  senderName: string;
  sentAt: number;
  text: string;
  imagePath: string | null;
  replyToMessageId: number | null;
}

// Who the owner is and who the chat agent is, which the rows need for two things only: a private
// chat's own number is the owner's, so it says which room is theirs; and the chat agent's own
// messages are the ones the reply-or-not gate is judging the answers to. Both are the tooling's
// settings, `owner_id` and `agent_id` (docs/training.md, 「The tooling and its settings」).
export function ownerIdFrom(): number {
  return settingNumber("owner_id");
}

export function agentIdFrom(): number {
  return settingNumber("agent_id");
}

// A private chat's number is the person's own, so a room whose number is the owner's is his room
// and every other is a group. The gates read the kind, not the number.
export type RoomKind = "owner" | "group";

export function roomKindOf(chatId: number, ownerId: number): RoomKind {
  return chatId === ownerId ? "owner" : "group";
}

export interface RoomCount {
  chatId: number;
  messages: number;
}

export function roomsIn(db: Database): RoomCount[] {
  return db.query("SELECT chat_id AS chatId, COUNT(*) AS messages FROM messages GROUP BY chat_id ORDER BY messages DESC")
    .all() as RoomCount[];
}

// One room's messages, oldest first, which is the order every transcript is read in. A room is
// read whole rather than a window at a time: the windows a gate's rows are cut from overlap, and
// asking the snapshot again for every one of them would read the same room over and over.
export function messagesIn(db: Database, chatId: number): ArchivedMessage[] {
  return db.query(`SELECT chat_id AS chatId, message_id AS messageId, sender_id AS senderId, sender_name AS senderName,
      sent_at AS sentAt, text, image_path AS imagePath, reply_to_message_id AS replyToMessageId
    FROM messages WHERE chat_id = ? ORDER BY sent_at, message_id`).all(chatId) as ArchivedMessage[];
}

// How many turns each gate was asked about. This is what says where the real material is thin, and
// it is the only use the past verdicts are put to.
export interface StageCount {
  stage: string;
  judgements: number;
  turns: number;
}

export function judgedCounts(db: Database): StageCount[] {
  return db.query(`SELECT stage, COUNT(*) AS judgements, COUNT(DISTINCT chat_id || ':' || message_id) AS turns
    FROM judgements GROUP BY stage ORDER BY judgements DESC`).all() as StageCount[];
}

// The turns one gate was asked about, in the order they were judged.
export interface JudgedTurn {
  chatId: number;
  messageId: number;
}

export function judgedTurns(db: Database, stage: string): JudgedTurn[] {
  return db.query(`SELECT DISTINCT chat_id AS chatId, message_id AS messageId FROM judgements
    WHERE stage = ? AND chat_id IS NOT NULL AND message_id IS NOT NULL ORDER BY chat_id, message_id`)
    .all(stage) as JudgedTurn[];
}

// What the chat agent actually sent and what the reader saw of it: the markdown it wrote, the text the room
// received, and whether the room received it folded. One judgement decides the fold, so the sent
// message is that judgement's own record, and it outlives every log.
export interface SentMessage {
  chatId: number;
  messageId: number;
  sentAt: number;
  original: string;
  visible: string;
  folded: boolean;
}

const foldEntity = /"type"\s*:\s*"expandable_blockquote"/;

export function sentMessages(db: Database, agentId: number): SentMessage[] {
  const rows = db.query(`SELECT m.chat_id AS chatId, m.message_id AS messageId, m.sent_at AS sentAt, m.text AS original,
      tm.metadata AS metadata
    FROM messages m LEFT JOIN telegram_messages tm ON tm.chat_id = m.chat_id AND tm.message_id = m.message_id
    WHERE m.sender_id = ? ORDER BY m.chat_id, m.sent_at`).all(agentId) as
    { chatId: number; messageId: number; sentAt: number; original: string; metadata: string | null }[];
  const sent: SentMessage[] = [];

  for (const row of rows) {
    const metadata = row.metadata ?? "";
    let visible: unknown;

    try {
      visible = (JSON.parse(metadata === "" ? "{}" : metadata) as { text?: unknown }).text;
    } catch {
      continue;
    }

    if (typeof visible === "string" && visible.length > 0) {
      sent.push({ ...row, visible, folded: foldEntity.test(metadata) });
    }
  }

  return sent;
}
