import { createHash } from "node:crypto";

/** A document as the store keeps it. One record backs the SOAP, WebDAV and upload views. */
export interface Document {
  readonly id: string;
  readonly name: string;
  title: string;
  contentType: string;
  content: Uint8Array;
  version: number;
  /** A strong entity tag, quotes included. */
  etag: string;
  modified: Date;
}

/** A document present when the handler starts, as plain JSON: its content as text or base64. */
export interface SeedDocument {
  readonly name: string;
  readonly title: string;
  readonly contentType: string;
  /** UTF-8 text content. */
  readonly text?: string | undefined;
  /** Binary content in base64; used when `text` is absent. */
  readonly base64?: string | undefined;
  /** ISO 8601 modification time; defaults to the clock. */
  readonly modified?: string | undefined;
}

export interface Lock {
  readonly token: string;
  readonly owner: string;
  readonly expires: Date;
}

/**
 * Document names are file names. The 2003 schema allowed anything but a slash; the 2009 WebDAV view
 * added the ban on control characters because they broke its hrefs.
 */
export const validName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= 120 &&
  name.trim() === name &&
  ![...name].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      character === "/" || character === "\\" || code < 0x20 || code === 0x7f
    );
  });

/** The store's state for one handler instance. */
export class Store {
  private readonly documents = new Map<string, Document>();
  private readonly locks = new Map<string, Lock>();
  private sequence = 0;
  private lockSequence = 0;

  constructor(
    readonly now: () => Date,
    seed: ReadonlyArray<SeedDocument>,
    readonly collections: ReadonlyArray<string>,
  ) {
    for (const document of seed)
      this.create({
        name: document.name,
        title: document.title,
        contentType: document.contentType,
        content:
          document.text !== undefined
            ? new TextEncoder().encode(document.text)
            : new Uint8Array(Buffer.from(document.base64 ?? "", "base64")),
        modified:
          document.modified === undefined
            ? undefined
            : new Date(document.modified),
      });
  }

  /** Every document, ordered by name the way the 2003 index returned them. */
  all(): ReadonlyArray<Document> {
    return [...this.documents.values()].toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  byId(id: string): Document | undefined {
    return this.documents.get(id);
  }

  byName(name: string): Document | undefined {
    return [...this.documents.values()].find(
      (document) => document.name === name,
    );
  }

  create(input: {
    readonly name: string;
    readonly title: string;
    readonly contentType: string;
    readonly content: Uint8Array;
    readonly modified?: Date | undefined;
  }): Document {
    this.sequence++;
    const id = `DOC-${String(this.sequence).padStart(6, "0")}`;
    const document: Document = {
      id,
      name: input.name,
      title: input.title,
      contentType: input.contentType,
      content: input.content,
      version: 1,
      etag: "",
      modified: input.modified ?? this.now(),
    };
    document.etag = tagFor(document);
    this.documents.set(id, document);
    return document;
  }

  replace(document: Document, content: Uint8Array, contentType: string): void {
    document.content = content;
    document.contentType = contentType;
    document.version++;
    document.modified = this.now();
    document.etag = tagFor(document);
  }

  remove(document: Document): void {
    this.documents.delete(document.id);
    this.locks.delete(document.id);
  }

  /** The live lock on a document, dropping an expired one. */
  lock(id: string): Lock | undefined {
    const lock = this.locks.get(id);
    if (lock !== undefined && lock.expires.getTime() <= this.now().getTime()) {
      this.locks.delete(id);
      return undefined;
    }
    return lock;
  }

  acquire(id: string, owner: string, seconds: number): Lock {
    this.lockSequence++;
    const lock: Lock = {
      token: `opaquelocktoken:5f1c0e2a-7d3b-4c19-9a40-${String(this.lockSequence).padStart(12, "0")}`,
      owner,
      expires: new Date(this.now().getTime() + seconds * 1000),
    };
    this.locks.set(id, lock);
    return lock;
  }
}

/** Strong tags change with every write: a digest over the id, the version and the bytes. */
const tagFor = (document: Document): string =>
  `"${createHash("sha1")
    .update(document.id)
    .update(String(document.version))
    .update(document.content)
    .digest("hex")
    .slice(0, 16)}"`;

/** The extension table the raw upload servlet uses, because raw uploads carry no content type. */
export const guessType = (name: string): string => {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "txt":
      return "text/plain";
    case "xml":
      return "application/xml";
    default:
      return "application/octet-stream";
  }
};

/** xsd:dateTime in UTC without fractional seconds, as the 2003 serializer wrote it. */
export const dateTime = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");
