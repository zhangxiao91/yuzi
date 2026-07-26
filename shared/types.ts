export type Punctuation = "。" | "？" | "“”";
export type GamePhase = "compose" | "cut" | "complete" | "failed";
export type FragmentRole = "subject" | "time" | "action" | "object" | "place" | "memory" | "connector";

export interface Fragment {
  id: string;
  text: string;
  role: FragmentRole;
}

export interface CandidateFragment extends Fragment {
  start: number;
  end: number;
}

export interface ManuscriptParagraph {
  id: string;
  turn: number;
  text: string;
  playerSentence?: string;
}

export interface WorldState {
  letterExists: boolean;
  locationKnown: boolean;
  remembersSender: boolean;
  hasLetter: boolean;
  readLetter: boolean;
  understoodLetter: boolean;
  departed: boolean;
}

export interface GameResult {
  outcome: "success" | "cannot-write" | "world-rejected" | "history-hollow" | "open-ending";
  title: string;
  summary: string;
  finalSentence?: string;
}

export interface GameState {
  id: string;
  version: number;
  phase: GamePhase;
  turn: number;
  maxTurns: number;
  hand: Fragment[];
  forbidden: string[];
  manuscript: ManuscriptParagraph[];
  candidates: CandidateFragment[];
  cutBudget: number;
  world: WorldState;
  goal: string;
  result?: GameResult;
  expiresAt: number;
}

export interface SessionEnvelope {
  sessionId: string;
  sessionToken?: string;
  game: GameState;
}

export interface TurnInput {
  version: number;
  fragmentIds: string[];
  punctuation: Punctuation;
}

export interface CutInput {
  version: number;
  candidateIds: string[];
}

export interface ModelTurnOutput {
  narrative: string;
  candidates: Array<{ text: string; role: FragmentRole }>;
}
