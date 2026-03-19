import { checksumText } from "../utils.js";
import type { SemanticChunkRecord } from "./types.js";

function normalizeTagValue(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeTagList(tags: string[]): string[] {
  return Array.from(new Set(tags.map(normalizeTagValue).filter(Boolean)));
}

export function buildSemanticDocumentText(input: {
  title: string | null;
  summary: string | null;
  body: string | null;
  tags: string[];
}): string {
  return [
    input.title?.trim(),
    input.summary?.trim(),
    input.tags.length ? `tags: ${normalizeTagList(input.tags).join(", ")}` : null,
    input.body?.trim(),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
    .trim();
}

function estimateTokenCount(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function buildSemanticChunks(text: string, chunkEnabled: boolean): SemanticChunkRecord[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  if (!chunkEnabled) {
    return [
      {
        ordinal: 0,
        chunkHash: checksumText(normalized),
        chunkText: normalized,
        tokenCount: estimateTokenCount(normalized),
        startOffset: 0,
        endOffset: normalized.length,
      },
    ];
  }

  const maxChars = 1200;
  const overlapChars = 180;
  const chunks: SemanticChunkRecord[] = [];
  let startOffset = 0;
  let ordinal = 0;

  while (startOffset < normalized.length) {
    let endOffset = Math.min(startOffset + maxChars, normalized.length);
    if (endOffset < normalized.length) {
      const lastBoundary = Math.max(
        normalized.lastIndexOf("\n\n", endOffset),
        normalized.lastIndexOf(". ", endOffset),
        normalized.lastIndexOf(" ", endOffset)
      );
      if (lastBoundary > startOffset + 300) {
        endOffset = lastBoundary + 1;
      }
    }

    const chunkText = normalized.slice(startOffset, endOffset).trim();
    if (!chunkText) {
      break;
    }

    chunks.push({
      ordinal,
      chunkHash: checksumText(chunkText),
      chunkText,
      tokenCount: estimateTokenCount(chunkText),
      startOffset,
      endOffset,
    });

    if (endOffset >= normalized.length) {
      break;
    }

    startOffset = Math.max(endOffset - overlapChars, startOffset + 1);
    ordinal += 1;
  }

  return chunks;
}
