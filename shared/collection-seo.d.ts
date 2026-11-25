export interface CollectionIndexabilityInput {
  gameCount: number
  description?: string | null
}

export function shouldIndexCollection(input?: CollectionIndexabilityInput): boolean
