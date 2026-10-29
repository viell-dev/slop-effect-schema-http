/**
 * The part of saxes 6.0.0 that `independent.ts` uses. `saxes.js` re-exports the package, and this
 * file declares it, so TypeScript never loads the package's own `saxes.d.ts`: that file does not
 * type-check without `skipLibCheck`, which the packed lane's type-check keeps off. It passes
 * unconstrained type parameters where `SaxesOptions` is required (TS2344), and its namespace options
 * conflict under `exactOptionalPropertyTypes` (TS2430). Import saxes through `./saxes.js` only, and
 * drop both files when a saxes release type-checks.
 */

export interface SaxesOptions {
  /** Namespace processing stays off: the suite compares XML 1.0 readers. */
  readonly xmlns?: false;
}

export interface SaxesTagPlain {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly isSelfClosing: boolean;
}

export declare class SaxesParser {
  constructor(options?: SaxesOptions);
  on(
    event: "opentag" | "closetag",
    handler: (tag: SaxesTagPlain) => void,
  ): void;
  on(event: "text" | "cdata", handler: (text: string) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  write(chunk: string): this;
  close(): this;
}
