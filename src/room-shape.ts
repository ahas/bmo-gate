// The two transcript shapes a gate is handed, built from the archive's own rows
// (`docs/laya-gates.md`, 「The three transcript shapes」). A row built out of real conversation is
// written in the shape that gate really receives, so these are built here rather than described:
// a row whose lines are nearly the shape teaches the model a shape no gate ever sends it.
//
// The pipe shape is the person-book writing road's and no gate is given it, so nothing here writes
// one.

import { scrubText } from "./pii";

import type { ArchivedMessage } from "./archive";
import type { Pseudonyms } from "./pii";

export interface ShapeWho {
  ownerId: number;
  names: Pseudonyms;
}

// A room's messages by their own number, which is how a reply finds what it answers. A room is a
// hundred thousand messages and every one of them may be a reply, so the lookup is an index rather
// than a walk: searching the list for each one is the room squared.
export type RoomIndex = ReadonlyMap<number, ArchivedMessage>;

export function indexOf(room: readonly ArchivedMessage[]): RoomIndex {
  return new Map(room.map((one) => [one.messageId, one]));
}

// How much of a quoted message a reply's note carries, and what marks it where it was cut. Both
// are the archive side's, so the note a row carries reads exactly as the note a gate is handed.
export const quoteLimit = 200;

const cutMark = "…(cut short)";

export function clipQuote(text: string): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();

  return flat.length <= quoteLimit ? flat : `${flat.slice(0, quoteLimit)}${cutMark}`;
}

// The notes one message carries, one bracketed English sentence for each thing on it. A message
// with nothing attached and answering nothing carries none.
//
// A picture's note is the one the bot writes for a picture whose file is gone, because that is what
// a picture on a message months old is: the files are swept, and a row claiming a path it could
// name would be claiming a file no reader of the row can open.
export function notesOf(message: ArchivedMessage, room: RoomIndex, who: ShapeWho): string[] {
  const notes: string[] = [];

  if (message.imagePath !== null) {
    notes.push("[an attached image is no longer stored]");
  }

  if (message.replyToMessageId !== null) {
    const target = room.get(message.replyToMessageId);

    if (target === undefined) {
      notes.push(`[replies to message ${message.replyToMessageId}, which the archive no longer holds, so its words cannot be shown]`);
    } else {
      const when = new Date(target.sentAt * 1000).toISOString();
      const name = who.names.nameOf(target.senderId, target.senderName);
      const quote = clipQuote(scrubText(target.text));

      notes.push(quote === ""
        ? `[replies to message ${message.replyToMessageId}, sent by ${name} at ${when}, which carried no text]`
        : `[replies to message ${message.replyToMessageId}, sent by ${name} at ${when}, which said: ${quote}]`);
    }
  }

  return notes;
}

// The room shape: the time in brackets, the message's own number after a hash, the sender's name,
// the sender's number with an owner tag where the sender is 하스, the text, and then its notes.
export function roomShapeLine(message: ArchivedMessage, room: RoomIndex, who: ShapeWho): string {
  const senderId = who.names.idOf(message.senderId);
  const sender = senderId === null ? "unknown" : String(senderId);
  const tag = message.senderId === who.ownerId ? ", OWNER" : "";
  const notes = notesOf(message, room, who);
  const said = notes.length === 0 ? "" : ` ${notes.join(" ")}`;
  const name = who.names.nameOf(message.senderId, message.senderName);

  return `[${new Date(message.sentAt * 1000).toISOString()}] #${message.messageId} ${name} (id ${sender}${tag}): ${scrubText(message.text)}${said}`;
}

// The plain shape: the sender's name, the sender's number and the text. It carries no time and no
// reply marker, and the four gates handed it keep it as it is — the real shape governs, and those
// two fields are simply absent from their data.
export function plainShapeLine(message: ArchivedMessage, who: ShapeWho): string {
  const senderId = who.names.idOf(message.senderId);

  return `${who.names.nameOf(message.senderId, message.senderName)} (id ${senderId === null ? "unknown" : senderId}): ${scrubText(message.text)}`;
}
