# Release history

The current release is [0.15](./0.15.md). [Versions](../versions.md) covers installation and
updates. Use [Schema-backed input](../schema-input.md) and [Schema-backed
groups](../schema-groups.md) for today's rules and active limits; the articles below explain changes
between releases.

## Schema-input hardening

The recurring renamed-field example tests several different questions. A later raw edit being
replaced by a generated field is one problem. A caller's encoded alias being ignored in favor of a
constructor default is another. Static input types and array normalization are separate layers.

| Release           | What changed for a consumer                                                      | Decisive new condition                                                    |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [0.6.x](./0.6.md) | Refuse a replaced raw edit; recover some union/sibling and opaque-neighbor calls | Empty caller group for renamed defaults; separate bounded recoveries      |
| [0.7](./0.7.md)   | Extend the same replaced-raw-edit check                                          | A closed union wraps the renamed group                                    |
| [0.8](./0.8.md)   | Already working encoded input can compile                                        | Shared outer names had hidden an encoded alias from the type              |
| [0.9](./0.9.md)   | Validate an ignored caller alias instead of sending its default                  | Successful initial whole construction at an eligible root                 |
| [0.10](./0.10.md) | Already working nested encoded input can compile                                 | Whole encoded shapes below unchanged outer names                          |
| [0.11](./0.11.md) | Refuse another route to the same alias/default loss                              | Failed whole decoding followed by successful final fieldwise construction |
| [0.12](./0.12.md) | Extend initial-constructor validation below an object                            | Unchanged direct-object ancestor fields                                   |
| [0.13](./0.13.md) | Extend that validation through a parent union                                    | Closed members share the same field schema                                |
| [0.14](./0.14.md) | Extend that validation through positional ancestors                              | Stable dense array/tuple cells with matching output length                |
| [0.15](./0.15.md) | Preserve actual array layout and handle symbol keys                              | An inner rewrite previously compacted/dropped cells or misread metadata   |

Thus 0.9 and 0.11–0.14 extend one constructor-default repair. Versions 0.8 and 0.10 repair static
types without changing runtime selection. Version 0.15 fixes separate normalization defects and does
not finish the constructor-default work. Some successful results changed and some calls began to
refuse, so the articles retain their breaking-change migrations.

These narrow implementation proofs protect schema priority, effects, opaque boundaries and actual
caller/output evidence. They did not require a separate software publication for every extension.
The related work was released in smaller units than its consumer outcome warranted. Remaining
alias/default work is assessed as a bounded hardening batch in
[#170](https://github.com/viell-dev/slop-effect-schema-http/issues/170), with preservation/selection
gaps retained in [#143](https://github.com/viell-dev/slop-effect-schema-http/issues/143). A batch
must name accepted cases, completion evidence and retained limits before release preparation; it
does not promise support for arbitrary schemas.

## Earlier releases

- [0.5](./0.5.md): catch raw edits replaced by generated same-name fields.
- [0.4](./0.4.md): omittable groups and transformed-tag/default loss checks.
- [0.3](./0.3.md): preserve union fields and refuse more overwritten raw edits.
- [0.2](./0.2.md): request composition and schema group changes.
- [0.1](./0.1.md): the first finite-body release.

The [complete changelog](../changelog.md) includes patch releases and maintenance details.
