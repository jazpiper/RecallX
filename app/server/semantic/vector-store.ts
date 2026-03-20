import type { DatabaseSync } from "node:sqlite";
import type { SemanticChunkRecord, SemanticEmbeddingResult } from "./types.js";

export type SemanticIndexBackend = "sqlite" | "sqlite-vec";

export interface VectorLedgerRecord {
  chunkOrdinal: number;
  vectorRef: string | null;
  vectorBlob: Uint8Array | null;
}

export interface VectorSearchMatch {
  nodeId: string;
  chunkOrdinal: number;
  similarity: number;
  vectorRef: string | null;
}

export interface VectorIndexStore {
  readonly backend: SemanticIndexBackend;
  upsertNodeChunks(input: {
    nodeId: string;
    chunks: SemanticChunkRecord[];
    embeddings: SemanticEmbeddingResult[];
    contentHash: string;
    embeddingProvider: string;
    embeddingModel: string | null;
    embeddingVersion: string | null;
    updatedAt: string;
  }): Promise<VectorLedgerRecord[]>;
  deleteNode(nodeId: string): Promise<void>;
  searchCandidates(input: {
    queryVector: number[];
    candidateNodeIds: string[];
    embeddingProvider: string;
    embeddingModel: string | null;
  }): Promise<VectorSearchMatch[]>;
}

export class VectorIndexStoreError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "VectorIndexStoreError";
  }
}

function encodeVectorBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function decodeVectorBlob(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function buildEmbeddingByOrdinal(embeddings: SemanticEmbeddingResult[]): Map<number, SemanticEmbeddingResult> {
  return new Map(embeddings.map((embedding) => [embedding.chunkOrdinal, embedding] as const));
}

function computeCosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number(left[index] ?? 0);
    const rightValue = Number(right[index] ?? 0);
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

class SqliteVectorIndexStore implements VectorIndexStore {
  readonly backend = "sqlite" as const;

  constructor(private readonly db: DatabaseSync) {}

  async upsertNodeChunks(input: {
    nodeId: string;
    chunks: SemanticChunkRecord[];
    embeddings: SemanticEmbeddingResult[];
  }): Promise<VectorLedgerRecord[]> {
    const embeddingsByOrdinal = buildEmbeddingByOrdinal(input.embeddings);
    const ledgerRows: Array<VectorLedgerRecord | null> = input.chunks
      .map((chunk) => {
        const embedding = embeddingsByOrdinal.get(chunk.ordinal);
        if (!embedding) {
          return null;
        }

        return {
          chunkOrdinal: chunk.ordinal,
          vectorRef: null,
          vectorBlob: encodeVectorBlob(embedding.vector)
        } satisfies VectorLedgerRecord;
      });

    return ledgerRows.filter((item): item is VectorLedgerRecord => item !== null);
  }

  async deleteNode(_nodeId: string): Promise<void> {}

  async searchCandidates(input: {
    queryVector: number[];
    candidateNodeIds: string[];
    embeddingProvider: string;
    embeddingModel: string | null;
  }): Promise<VectorSearchMatch[]> {
    if (!input.candidateNodeIds.length) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT owner_id, chunk_ordinal, vector_ref, vector_blob
         FROM node_embeddings
         WHERE owner_type = 'node'
           AND status = 'ready'
           AND vector_blob IS NOT NULL
           AND embedding_provider = ?
           AND embedding_model ${input.embeddingModel === null ? "IS NULL" : "= ?"}
           AND owner_id IN (${input.candidateNodeIds.map(() => "?").join(", ")})`
      )
      .all(
        ...[
          input.embeddingProvider,
          ...(input.embeddingModel === null ? [] : [input.embeddingModel]),
          ...input.candidateNodeIds
        ]
      ) as Array<Record<string, unknown>>;

    const matches: VectorSearchMatch[] = [];
    for (const row of rows) {
      if (!(row.vector_blob instanceof Uint8Array)) {
        continue;
      }

      const similarity = computeCosineSimilarity(input.queryVector, decodeVectorBlob(row.vector_blob));
      if (!Number.isFinite(similarity)) {
        continue;
      }

      matches.push({
        nodeId: String(row.owner_id),
        chunkOrdinal: Number(row.chunk_ordinal ?? 0),
        similarity,
        vectorRef: row.vector_ref ? String(row.vector_ref) : null
      });
    }

    return matches;
  }
}

class SqliteVecVectorIndexStore implements VectorIndexStore {
  readonly backend = "sqlite-vec" as const;

  constructor(private readonly db: DatabaseSync) {}

  async upsertNodeChunks(input: {
    nodeId: string;
    chunks: SemanticChunkRecord[];
    embeddings: SemanticEmbeddingResult[];
  }): Promise<VectorLedgerRecord[]> {
    const embeddingsByOrdinal = buildEmbeddingByOrdinal(input.embeddings);
    const ledgerRows: Array<VectorLedgerRecord | null> = input.chunks
      .map((chunk) => {
        const embedding = embeddingsByOrdinal.get(chunk.ordinal);
        if (!embedding) {
          return null;
        }

        return {
          chunkOrdinal: chunk.ordinal,
          vectorRef: null,
          vectorBlob: encodeVectorBlob(embedding.vector)
        } satisfies VectorLedgerRecord;
      });

    return ledgerRows.filter((item): item is VectorLedgerRecord => item !== null);
  }

  async deleteNode(_nodeId: string): Promise<void> {}

  async searchCandidates(input: {
    queryVector: number[];
    candidateNodeIds: string[];
    embeddingProvider: string;
    embeddingModel: string | null;
  }): Promise<VectorSearchMatch[]> {
    if (!input.queryVector.length || !input.candidateNodeIds.length) {
      return [];
    }

    const queryVectorBlob = encodeVectorBlob(input.queryVector);
    const rows = this.db
      .prepare(
        `SELECT
           owner_id,
           chunk_ordinal,
           vector_ref,
           vector_blob,
           1 - vec_distance_cosine(vector_blob, ?) AS similarity
         FROM node_embeddings
         WHERE owner_type = 'node'
           AND status = 'ready'
           AND vector_blob IS NOT NULL
           AND embedding_provider = ?
           AND embedding_model ${input.embeddingModel === null ? "IS NULL" : "= ?"}
           AND owner_id IN (${input.candidateNodeIds.map(() => "?").join(", ")})
         ORDER BY similarity DESC`
      )
      .all(
        ...[
          queryVectorBlob,
          input.embeddingProvider,
          ...(input.embeddingModel === null ? [] : [input.embeddingModel]),
          ...input.candidateNodeIds
        ]
      ) as Array<Record<string, unknown>>;

    return rows
      .map((row) => {
        const similarity = Number(row.similarity);
        if (!Number.isFinite(similarity)) {
          return null;
        }

        return {
          nodeId: String(row.owner_id),
          chunkOrdinal: Number(row.chunk_ordinal ?? 0),
          similarity,
          vectorRef: row.vector_ref ? String(row.vector_ref) : null
        } satisfies VectorSearchMatch;
      })
      .filter((item: VectorSearchMatch | null): item is VectorSearchMatch => item !== null);
  }
}

export function createVectorIndexStore(
  db: DatabaseSync,
  input: {
    backend: SemanticIndexBackend;
    workspaceKey: string;
  }
): VectorIndexStore {
  if (input.backend === "sqlite-vec") {
    return new SqliteVecVectorIndexStore(db);
  }

  return new SqliteVectorIndexStore(db);
}
