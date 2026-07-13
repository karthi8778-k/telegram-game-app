// Simplified Ludo engine.
// - Shared 52-cell circular track, 4 fixed color start offsets (classic Ludo layout).
// - Each player has 4 tokens. Roll a 6 to leave base.
// - Landing on an opponent's token (on a non-safe cell) sends it back to base.
// - A token finishes after traveling 51 steps from its own start cell.
// - First player to finish all 4 tokens wins.
// This is intentionally simplified (no exact-roll-to-finish rule) to keep
// the multiplayer logic easy to reason about. You can extend it later.

const COLORS = ['red', 'green', 'yellow', 'blue'];
const OFFSETS = [0, 13, 26, 39];
const TRACK_LENGTH = 52;
const FINISH_STEPS = 51;

class LudoGame {
  constructor(userIds) {
    this.userIds = userIds; // array of 2-4 telegram user ids, join order = turn order
    this.players = userIds.map((id, idx) => ({
      userId: id,
      color: COLORS[idx],
      offset: OFFSETS[idx],
      tokens: [-1, -1, -1, -1], // -1 = in base, 0..50 = steps traveled, >=51 = finished
    }));
    this.turnIndex = 0;
    this.lastDice = null;
  }

  currentPlayer() {
    return this.players[this.turnIndex];
  }

  currentTurnUserId() {
    return this.currentPlayer().userId;
  }

  rollDice() {
    this.lastDice = 1 + Math.floor(Math.random() * 6);
    return { dice: this.lastDice, userId: this.currentTurnUserId() };
  }

  hasValidMoves() {
    if (this.lastDice == null) return false;
    const p = this.currentPlayer();
    return p.tokens.some((steps) => {
      if (steps === -1) return this.lastDice === 6;
      if (steps >= FINISH_STEPS) return false;
      return true;
    });
  }

  moveToken(userId, tokenIndex) {
    const p = this.currentPlayer();
    if (p.userId !== userId) return { ok: false, reason: 'not your turn' };
    if (this.lastDice == null) return { ok: false, reason: 'roll dice first' };
    if (tokenIndex < 0 || tokenIndex > 3) return { ok: false, reason: 'invalid token' };

    const steps = p.tokens[tokenIndex];
    if (steps >= FINISH_STEPS) return { ok: false, reason: 'token already finished' };

    if (steps === -1) {
      if (this.lastDice !== 6) return { ok: false, reason: 'need a 6 to leave base' };
      p.tokens[tokenIndex] = 0;
    } else {
      p.tokens[tokenIndex] = Math.min(steps + this.lastDice, FINISH_STEPS);
    }

    this.checkCapture(p, tokenIndex);

    const winnerId = p.tokens.every((s) => s >= FINISH_STEPS) ? p.userId : null;
    return { ok: true, winnerId };
  }

  checkCapture(movingPlayer, tokenIndex) {
    const steps = movingPlayer.tokens[tokenIndex];
    if (steps >= FINISH_STEPS) return;
    const globalPos = (movingPlayer.offset + steps) % TRACK_LENGTH;
    const isSafeCell = OFFSETS.includes(globalPos);
    if (isSafeCell) return;

    for (const other of this.players) {
      if (other.userId === movingPlayer.userId) continue;
      other.tokens.forEach((oSteps, i) => {
        if (oSteps === -1 || oSteps >= FINISH_STEPS) return;
        const oGlobalPos = (other.offset + oSteps) % TRACK_LENGTH;
        if (oGlobalPos === globalPos) {
          other.tokens[i] = -1; // sent back to base
        }
      });
    }
  }

  // Skips turn automatically if the player has no legal move for the current dice.
  nextTurn() {
    this.lastDice = null;
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    return this.currentTurnUserId();
  }

  getState() {
    return {
      players: this.players.map((p) => ({
        userId: p.userId,
        color: p.color,
        offset: p.offset,
        tokens: p.tokens,
      })),
      turn: this.currentTurnUserId(),
      lastDice: this.lastDice,
      trackLength: TRACK_LENGTH,
      finishSteps: FINISH_STEPS,
    };
  }
}

module.exports = LudoGame;
