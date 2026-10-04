// Audience ranking for the "Suzuleague" stage event.
//
// The audience answers the same questions as the contestants on their phones,
// and each phone scores itself (the correct answer arrives as a cloud variable
// at the reveal). After every reveal the phone reports its running total here:
//
//   audience phone --POST /api/score-->   here
//                  <--GET /api/ranking--
//
// Score = sum of |correct - answer| over the questions revealed so far, where a
// question the viewer did not answer counts as 50. Lower is better. Missed
// questions are counted here (not on the phone) from the number of questions the
// backstage PC reports as revealed, so that late joiners and people who stop
// answering do not float to the top.
//
// The phones report their own totals, so a determined viewer could cheat. This
// is a fun extra for a school festival, not a prize contest.

const naughty = require('./naughty');

const MISSED_PENALTY = 50;
const MAX_PLAYERS = 2000;
const MAX_NAME_LENGTH = 10;
const MAX_QUESTIONS = 100;

class RankingError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message Shown to the viewer as is
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Clean up a nickname for display. Returns '' if it cannot be used.
 * @param {unknown} name
 */
function cleanName(name) {
  if (typeof name !== 'string') return '';
  // drop control characters and collapse whitespace
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  if (chars.length === 0 || chars.length > MAX_NAME_LENGTH) return '';
  if (naughty(cleaned)) return '';
  return cleaned;
}

class RankingStore {
  /**
   * @param {() => number} revealedFromHost Number of revealed questions according to the backstage PC, or -1 if unknown.
   * @param {() => number} now
   */
  constructor(revealedFromHost = () => -1, now = Date.now) {
    this.revealedFromHost = revealedFromHost;
    this.now = now;
    /** @type {Map<string, {name: string, errorSum: number, answered: number, lastQuestion: number, at: number}>} */
    this.players = new Map();
    /** @type {Set<string>} ids hidden by the MC (inappropriate names) */
    this.hidden = new Set();
  }

  /**
   * @param {unknown} body
   */
  submit(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RankingError(400, '送信の形式が正しくありません');
    }
    const { id, name, error_sum: errorSum, answered, last_question: lastQuestion } = /** @type {any} */ (body);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      throw new RankingError(400, '端末IDが正しくありません');
    }
    if (!Number.isInteger(answered) || answered < 0 || answered > MAX_QUESTIONS) {
      throw new RankingError(400, '回答数が正しくありません');
    }
    if (!Number.isInteger(errorSum) || errorSum < 0 || errorSum > 100 * answered) {
      throw new RankingError(400, '成績が正しくありません');
    }
    if (!Number.isInteger(lastQuestion) || lastQuestion < answered || lastQuestion > MAX_QUESTIONS) {
      throw new RankingError(400, '問題番号が正しくありません');
    }
    const display = cleanName(name);
    if (!display) {
      throw new RankingError(400, `ニックネームは${MAX_NAME_LENGTH}文字以内で、使えない言葉を含まないものにしてください`);
    }
    if (!this.players.has(id) && this.players.size >= MAX_PLAYERS) {
      throw new RankingError(503, '参加者が多すぎるため、ランキングに登録できませんでした');
    }
    this.players.set(id, { name: display, errorSum, answered, lastQuestion, at: this.now() });
  }

  revealed() {
    const fromHost = this.revealedFromHost();
    if (fromHost >= 0) return fromHost;
    let max = 0;
    for (const p of this.players.values()) max = Math.max(max, p.lastQuestion);
    return max;
  }

  /**
   * @param {string | null} id The viewer's own id, to report their rank.
   * @param {number} limit How many top entries to return.
   */
  ranking(id, limit = 5) {
    const revealed = this.revealed();
    const rows = [];
    for (const [pid, p] of this.players) {
      const missed = Math.max(0, revealed - p.answered);
      rows.push({ id: pid, name: p.name, total: p.errorSum + MISSED_PENALTY * missed, answered: p.answered, at: p.at });
    }
    // lower total first; on a tie, whoever reached it first
    rows.sort((a, b) => a.total - b.total || a.at - b.at);

    // standard competition ranking (1, 2, 2, 4)
    let rank = 0;
    let previous = null;
    const ranked = rows.map((r, i) => {
      if (r.total !== previous) {
        rank = i + 1;
        previous = r.total;
      }
      return { ...r, rank };
    });

    const me = id ? ranked.find((r) => r.id === id) : undefined;
    return {
      participants: ranked.length,
      revealed,
      top: ranked
        .filter((r) => !this.hidden.has(r.id))
        .slice(0, limit)
        .map(({ rank: rk, name, total, answered }) => ({ rank: rk, name, total, answered })),
      me: me ? { rank: me.rank, total: me.total, answered: me.answered } : null,
    };
  }
}

module.exports = {
  RankingStore,
  RankingError,
  cleanName,
  MISSED_PENALTY,
};
