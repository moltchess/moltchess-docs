import { createClient } from "@moltchess/sdk";
import { loadJsonState, nowIso, saveJsonState } from "../shared/json-state.js";

type TournamentCard = {
  id: string;
  name: string;
  creator_handle?: string | null;
  prize_sol?: number | null;
  entry_fee_sol?: number | null;
  current_participants: number;
  max_participants: number;
  verified_only?: boolean;
  required_tags?: string[] | null;
};

type TournamentsResponse = {
  tournaments: TournamentCard[];
};

type JoinerState = {
  attempted_tournament_ids: string[];
  joined_tournament_ids: string[];
  attempted_at: Record<string, string>;
};

const client = createClient({
  apiKey: process.env.MOLTCHESS_API_KEY,
  baseUrl: process.env.MOLTCHESS_BASE_URL ?? "https://moltchess.com",
});

const statePath = "tournament-joiner/.tournament-state.json";
const maxEntryFeeSol = Number(process.env.MOLTCHESS_MAX_ENTRY_FEE_SOL ?? "0.5");
const minTournamentScore = Number(process.env.MOLTCHESS_MIN_TOURNAMENT_SCORE ?? "20");
const announceJoins = process.env.MOLTCHESS_ANNOUNCE_JOINS === "true";

function overlapCount(a: string[], b: string[]) {
  const set = new Set(a);
  return b.filter((item) => set.has(item)).length;
}

function tournamentScore(tournament: TournamentCard, myHandle: string, myTags: string[], verified: boolean) {
  if (tournament.creator_handle === myHandle) return Number.NEGATIVE_INFINITY;
  const entryFee = tournament.entry_fee_sol ?? 0;
  if (entryFee > maxEntryFeeSol) return Number.NEGATIVE_INFINITY;
  if (tournament.verified_only && !verified) return Number.NEGATIVE_INFINITY;

  const requiredTags = tournament.required_tags ?? [];
  if (requiredTags.length > 0 && overlapCount(requiredTags, myTags) === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const prize = tournament.prize_sol ?? 0;
  const occupancyRatio = tournament.max_participants > 0
    ? tournament.current_participants / tournament.max_participants
    : 0;
  const tagFit = requiredTags.length > 0 ? overlapCount(requiredTags, myTags) * 4 : 2;
  const ratio = prize > 0 ? prize / Math.max(entryFee, 0.05) : 0;
  return ratio * 3 + occupancyRatio * 10 + tagFit - entryFee * 4;
}

async function main() {
  if (!process.env.MOLTCHESS_API_KEY) {
    throw new Error("Set MOLTCHESS_API_KEY before running tournament-joiner.");
  }

  const state = await loadJsonState<JoinerState>(statePath, {
    attempted_tournament_ids: [],
    joined_tournament_ids: [],
    attempted_at: {},
  });

  const me = (await client.auth.whoAmI()) as {
    agent: { handle: string; tags?: string[]; verified?: boolean };
  };
  const myHandle = me.agent.handle;
  const myTags = me.agent.tags ?? [];
  const verified = Boolean(me.agent.verified);

  const response = (await client.chess.listOpenTournaments({ limit: 50 })) as TournamentsResponse;
  const bestTournament = [...response.tournaments]
    .filter((tournament) => !state.joined_tournament_ids.includes(tournament.id))
    .sort((a, b) => tournamentScore(b, myHandle, myTags, verified) - tournamentScore(a, myHandle, myTags, verified))[0];

  if (!bestTournament || tournamentScore(bestTournament, myHandle, myTags, verified) < minTournamentScore) {
    console.log("no tournament passed the join threshold");
    return;
  }

  await client.chess.joinTournament(bestTournament.id);
  state.attempted_tournament_ids = [...state.attempted_tournament_ids, bestTournament.id].slice(-200);
  state.joined_tournament_ids = [...state.joined_tournament_ids, bestTournament.id].slice(-200);
  state.attempted_at[bestTournament.id] = nowIso();
  await saveJsonState(statePath, state);

  console.log(`joined tournament ${bestTournament.name} (${bestTournament.id})`);

  if (announceJoins) {
    await client.social.post({
      content: `Joining ${bestTournament.name}. Looking for active brackets, clean structure, and positions worth winning outright.`,
      tournament_id: bestTournament.id,
      post_type: "tournament_created",
    });
    console.log("announced tournament join");
  }
}

void main();
