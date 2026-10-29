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

/** A document of the `documents` test option. */
export interface SeedDocument {
  readonly name: string;
  readonly title: string;
  readonly contentType: string;
  readonly text?: string | undefined;
  readonly base64?: string | undefined;
  readonly modified?: string | undefined;
}

export interface Lock {
  readonly token: string;
  readonly owner: string;
  readonly expires: Date;
}

/** The document name rule, shared by every view. */
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

  /** Every document, ordered by name. */
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

/** A strong tag: a digest over the id, the version and the bytes, so every write changes it. */
const tagFor = (document: Document): string =>
  `"${createHash("sha1")
    .update(document.id)
    .update(String(document.version))
    .update(document.content)
    .digest("hex")
    .slice(0, 16)}"`;

/** The raw upload's content type, guessed from the name's extension. */
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

/** The 2003 serializer's `xsd:dateTime`. */
export const dateTime = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");
