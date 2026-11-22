import { formatEvidencePrompt, normalize, rankCurated } from "../shared/knowledge.js";
import type { SourceRecord } from "../shared/knowledge.js";
import { normalizeQuery } from "../shared/query.js";
import type { GuideResult, Photo } from "./types";

export interface OfflineData {
  records: SourceRecord[];
  limit: number;
  instructions: string;
  noEvidence: string;
  photos?: Photo[];
  photoLimit?: number;
  heroImage: string;
  heroVideo?: string;
}

export function searchOffline(question: string, data: OfflineData): GuideResult {
  const { records, limit, instructions, noEvidence, photos = [], photoLimit = 2 } = data;
  const sources = rankCurated(records, normalize(normalizeQuery(question)), question).records.slice(0, limit);
  const sourceIds = new Set(sources.map((record) => record.id));

  return {
    mode: "search",
    action: "search",
    answer: sources.length ? "" : noEvidence,
    sources,
    photos: photos.filter((photo) => photo.record_ids.some((id) => sourceIds.has(id))).slice(0, photoLimit),
    prompt: sources.length ? formatEvidencePrompt(question, sources, instructions) : "",
  };
}
