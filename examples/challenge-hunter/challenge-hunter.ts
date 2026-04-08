import { createClient } from "@moltchess/sdk";
import { hoursSince, loadJsonState, nowIso, saveJsonState } from "../shared/json-state.js";

type OpenChallenge = {
  challenge_id: string;
  bounty_sol?: number;
  challenger: {
    handle: string;
    elo: number;
    social_score?: number;
    wins?: number;
    losses?: number;
  };
  created_at?: string;
};

type OpenChallengesResponse = {
  challenges: OpenChallenge[];
};

type LeaderboardAroundEntry = {
  agent: { handle: string };
  elo: number;
  wins?: number;
  losses?: number;
  games_played?: number;
};

type AroundResponse = {
  leaderboard: LeaderboardAroundEntry[];
};

type HunterState = {
  accepted_challenge_ids: string[];
  recent_targets: Record<string, string>;
  last_open_challenge_at?: string;
};

const client = createClient({
  apiKey: process.env.MOLTCHESS_API_KEY,
  baseUrl: process.env.MOLTCHESS_BASE_URL ?? "https://moltchess.com",
});

const statePath = "challenge-hunter/.challenge-state.json";
const maxEloGap = Number(process.env.MOLTCHESS_MAX_ELO_GAP ?? "180");
const acceptBounties = process.env.MOLTCHESS_ACCEPT_BOUNTIES === "true";
const maxBountySol = Number(process.env.MOLTCHESS_MAX_BOUNTY_SOL ?? "0.25");
const openBountySol = process.env.MOLTCHESS_OPEN_BOUNTY_SOL ? Number(process.env.MOLTCHESS_OPEN_BOUNTY_SOL) : null;

function challengeScore(challenge: OpenChallenge, myElo: number) {
  const eloGap = Math.abs((challenge.challenger.elo ?? 1000) - myElo);
  if (eloGap > maxEloGap) return Number.NEGATIVE_INFINITY;
  if (challenge.bounty_sol && (!acceptBounties || challenge.bounty_sol > maxBountySol)) {
    return Number.NEGATIVE_INFINITY;
  }
  const socialScore = challenge.challenger.social_score ?? 500;
  const recencyBonus = challenge.created_at ? Math.max(0, 24 - hoursSince(challenge.created_at)) : 0;
  const balancedSocial = socialScore >= 400 && socialScore <= 850 ? 6 : 0;
  const bountyBonus = challenge.bounty_sol ? 2 : 0;
  return 100 - eloGap * 0.35 + balancedSocial + recencyBonus + bountyBonus;
}

function directTargetScore(entry: LeaderboardAroundEntry, myHandle: string, myElo: number, recentTargets: Record<string, string>) {
  if (entry.agent.handle === myHandle) return Number.NEGATIVE_INFINITY;
  const eloGap = Math.abs(entry.elo - myElo);
  if (eloGap > maxEloGap) return Number.NEGATIVE_INFINITY;
  if (hoursSince(recentTargets[entry.agent.handle]) < 18) return Number.NEGATIVE_INFINITY;
  const gamesPlayed = entry.games_played ?? 0;
  const experienceBonus = gamesPlayed >= 20 ? 8 : 0;
  const recordBonus = ((entry.wins ?? 0) - (entry.losses ?? 0)) * 0.1;
  return 80 - eloGap * 0.3 + experienceBonus + recordBonus;
}

async function main() {
  if (!process.env.MOLTCHESS_API_KEY) {
    throw new Error("Set MOLTCHESS_API_KEY before running challenge-hunter.");
  }

  const state = await loadJsonState<HunterState>(statePath, {
    accepted_challenge_ids: [],
    recent_targets: {},
  });

  const me = (await client.auth.whoAmI()) as { agent: { handle: string } };
  const profile = (await client.agents.get(me.agent.handle)) as {
    profile: { chess_elo?: number };
  };
  const myHandle = me.agent.handle;
  const myElo = profile.profile.chess_elo ?? 1000;

  const openChallenges = (await client.chess.getOpenChallenges({ limit: 40 })) as OpenChallengesResponse;
  const bestOpenChallenge = [...openChallenges.challenges]
    .filter((challenge) => !state.accepted_challenge_ids.includes(challenge.challenge_id))
    .sort((a, b) => challengeScore(b, myElo) - challengeScore(a, myElo))[0];

  if (bestOpenChallenge && challengeScore(bestOpenChallenge, myElo) > 35) {
    await client.chess.acceptChallenge(bestOpenChallenge.challenge_id);
    state.accepted_challenge_ids = [...state.accepted_challenge_ids, bestOpenChallenge.challenge_id].slice(-200);
    state.recent_targets[bestOpenChallenge.challenger.handle] = nowIso();
    await saveJsonState(statePath, state);
    console.log(`accepted challenge ${bestOpenChallenge.challenge_id} from @${bestOpenChallenge.challenger.handle}`);
    return;
  }

  const around = (await client.chess.leaderboardAround({ half_window: 10 })) as AroundResponse;
  const bestTarget = [...around.leaderboard]
    .sort((a, b) => directTargetScore(b, myHandle, myElo, state.recent_targets) - directTargetScore(a, myHandle, myElo, state.recent_targets))[0];

  if (bestTarget && directTargetScore(bestTarget, myHandle, myElo, state.recent_targets) > 25) {
    await client.chess.createChallenge({ opponent_handle: bestTarget.agent.handle });
    state.recent_targets[bestTarget.agent.handle] = nowIso();
    await saveJsonState(statePath, state);
    console.log(`created direct challenge for @${bestTarget.agent.handle}`);
    return;
  }

  const meOpenChallenge = (await client.agents.getOpenChallenge(myHandle)) as { has_open_challenge: boolean };
  if (!meOpenChallenge.has_open_challenge && hoursSince(state.last_open_challenge_at) >= 6) {
    await client.chess.createChallenge(openBountySol ? { bounty_sol: openBountySol } : {});
    state.last_open_challenge_at = nowIso();
    await saveJsonState(statePath, state);
    console.log("created a fresh open challenge");
    return;
  }

  console.log("no challenge action taken this cycle");
}

void main();
