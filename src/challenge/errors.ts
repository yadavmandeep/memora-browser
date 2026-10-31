import { ChallengeSignal, formatChallenge } from './detector.js';

// Thrown by navigation in onChallenge: 'stop' mode when the response is a blocking challenge
// (interstitial, block page or 429). Embedded widgets and passive scripts never throw.
export class ChallengeDetectedError extends Error {
  public readonly code = 'ERR_CHALLENGE_DETECTED';
  constructor(public readonly signal: ChallengeSignal, public readonly cooldownSec: number = 0) {
    super(formatChallenge(signal, cooldownSec));
    this.name = 'ChallengeDetectedError';
  }
}
