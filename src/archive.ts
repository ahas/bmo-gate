import { Database } from "bun:sqlite";
import { join } from "node:path";

import { dataRoot } from "./roots";

// BMO's archive as this repository reads it (docs/gate-data.md, 「The real conversation source」),
// which is always a copy of it. It is opened read-only and never written.
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

// The bot's own archive, which nothing here opens except to take a copy of it (docs/gate-data.md,
// 「The archive copy」).
export function liveArchivePath(): string {
  return process.env.BMO_DB_PATH ?? join(dataRoot(), "bmo.db");
}

export function openArchive(path: string): Database {
  return new Database(path, { readonly: true });
}

// Who the owner is and who BMO is, which the rows need for two things only: a private chat's own
// number is the owner's, so it says which room is his; and BMO's own messages are the ones the
// reply-or-not gate is judging the answers to. Both are the bot's own settings and are read from
// the environment as the bot reads them, the bot's number standing in front of the colon of its
// token where it is not named outright.
export function ownerIdFrom(env: Record<string, string | undefined> = process.env): number {
  const named = env.BMO_OWNER_ID;

  if (named === undefined || !/^\d+$/.test(named)) {
    throw new Error("BMO_OWNER_ID 가 없습니다. 하스의 번호를 환경에 두거나 --owner 로 주세요.");
  }

  return Number(named);
}

export function bmoIdFrom(env: Record<string, string | undefined> = process.env): number {
  const named = env.BMO_BOT_ID;

  if (named !== undefined && /^\d+$/.test(named)) {
    return Number(named);
  }

  const front = (env.BMO_BOT_TOKEN ?? "").split(":")[0] ?? "";

  if (!/^\d+$/.test(front)) {
    throw new Error("BMO_BOT_ID 도 BMO_BOT_TOKEN 도 없습니다. 비모의 번호를 --bmo 로 주세요.");
  }

  return Number(front);
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
// asking the archive again for every one of them would read the same room over and over.
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

// What a gate really offered a room as candidates, read back out of the probe inputs the verdict
// record kept. The candidate slugs and the one line each carries are a room's own library as it
// stood, and they are what a row built from a fresh turn of that room offers: the brain moves, and
// a generation that read it directly would be writing rows against a library no recorded turn ever
// saw. Rows with no input, and gates that never recorded one, come back with nothing.
export interface RecordedQuestions {
  chatId: number;
  questions: Record<string, unknown>;
}

export function recordedQuestions(db: Database, stage: string): RecordedQuestions[] {
  const rows = db.query(`SELECT chat_id AS chatId, input FROM laya_verdicts
    WHERE stage = ? AND input IS NOT NULL AND input <> '' AND input <> '{}' ORDER BY id`)
    .all(stage) as { chatId: number | null; input: string }[];
  const read: RecordedQuestions[] = [];

  for (const row of rows) {
    try {
      const request = JSON.parse(row.input) as { questions?: unknown };

      if (row.chatId !== null && typeof request.questions === "object" && request.questions !== null) {
        read.push({ chatId: row.chatId, questions: request.questions as Record<string, unknown> });
      }
    } catch {
      // An input that does not read back is left out rather than guessed at.
    }
  }

  return read;
}

// What BMO actually sent and what the reader saw of it: the markdown it wrote, the text the room
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

export function sentMessages(db: Database, bmoId: number): SentMessage[] {
  const rows = db.query(`SELECT m.chat_id AS chatId, m.message_id AS messageId, m.sent_at AS sentAt, m.text AS original,
      tm.metadata AS metadata
    FROM messages m LEFT JOIN telegram_messages tm ON tm.chat_id = m.chat_id AND tm.message_id = m.message_id
    WHERE m.sender_id = ? ORDER BY m.chat_id, m.sent_at`).all(bmoId) as
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
