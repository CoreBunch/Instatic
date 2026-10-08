import { Type, type Static } from '@sinclair/typebox'

export const PropertyConditionSchema = Type.Recursive((Self) => Type.Union([
  Type.Object(
    { field: Type.String({ minLength: 1 }), eq: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), notEq: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), in: Type.Array(Type.Unknown()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { field: Type.String({ minLength: 1 }), notIn: Type.Array(Type.Unknown()) },
    { additionalProperties: false },
  ),
  Type.Object(
    { and: Type.Array(Self) },
    { additionalProperties: false },
  ),
  Type.Object(
    { or: Type.Array(Self) },
    { additionalProperties: false },
  ),
]))

export type PropertyCondition = Static<typeof PropertyConditionSchema>
