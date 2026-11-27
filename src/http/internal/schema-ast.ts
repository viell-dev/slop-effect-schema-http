import { SchemaAST } from "effect";

/**
 * Effect's public AST API has no operation to replace one encoding link. Its internal replacement
 * preserves the node's checks, context and annotations on both supported peer versions.
 */
export const { replaceEncoding } = SchemaAST as typeof SchemaAST & {
  replaceEncoding(
    ast: SchemaAST.AST,
    encoding: SchemaAST.Encoding | undefined,
  ): SchemaAST.AST;
};
