import { SchemaAST } from "effect";

/** Effect's public AST API has no operation to replace one link of an encoding. */
export const { replaceEncoding } = SchemaAST as typeof SchemaAST & {
  replaceEncoding(
    ast: SchemaAST.AST,
    encoding: SchemaAST.Encoding | undefined,
  ): SchemaAST.AST;
};
