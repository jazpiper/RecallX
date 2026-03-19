export interface SemanticChunkRecord {
  ordinal: number;
  chunkHash: string;
  chunkText: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
}

export interface SemanticEmbeddingRequest {
  nodeId: string;
  chunkOrdinal: number;
  contentHash: string;
  text: string;
}

export interface SemanticEmbeddingResult {
  nodeId: string;
  chunkOrdinal: number;
  contentHash: string;
  vector: number[];
  dimension: number;
}

export interface SemanticEmbeddingProvider {
  readonly provider: string;
  readonly model: string | null;
  readonly version: string | null;
  embedBatch(input: SemanticEmbeddingRequest[]): Promise<SemanticEmbeddingResult[]>;
}
