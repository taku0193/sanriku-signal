export interface Source {
  title: string;
  text?: string;
  source: string;
  url?: string;
  checked?: string;
  published?: string;
}

export interface Photo {
  src: string;
  record_ids: string[];
  title: string;
  alt: string;
  width: number;
  height: number;
  taken: string;
  author: string;
  page: string;
  license: string;
  license_url: string;
}

export interface Pending {
  question: string;
  field: "district" | "condition";
  prompt: string;
  district_hint?: string;
  resume_token?: string;
}

export interface QuestionAndAnswer {
  question: string;
  answer: string;
}

export interface AskInput {
  question: string;
  pending: Pending | null;
  history: QuestionAndAnswer[];
}

export interface AnswerSection {
  label: string;
  text: string;
  sourceIndexes: number[];
}

export interface AnswerPresentation {
  conclusion?: string;
  sections: AnswerSection[];
}

export interface GuideResult {
  mode: "ai" | "search";
  action: "answer" | "clarify" | "insufficient" | "search";
  answer: string;
  sources: Source[];
  presentation?: AnswerPresentation;
  photos?: Photo[];
  pending?: Pending | null;
  notice?: string;
  prompt?: string;
}

export type ProgressStage = "planning" | "searching" | "reviewing" | "generating";

export type ProgressEvent =
  | { type: "progress"; stage: ProgressStage; detail?: string }
  | { type: "delta"; text: string };

export type StreamEvent = ProgressEvent | { type: "result"; data: GuideResult };

export interface Turn {
  id: number;
  question: string;
  followUpQuestion?: string;
  stage: ProgressStage;
  searchDetail?: string;
  preview: string;
  result: GuideResult | null;
  failure: { message: string; stopped: boolean; partial: string } | null;
}
