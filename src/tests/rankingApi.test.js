const { RankingStore, cleanName } = require('../rankingApi');

const ID = (n) => `viewer-${String(n).padStart(4, '0')}`;

/**
 * @param {RankingStore} store
 * @param {number} n
 * @param {object} fields
 */
function submit(store, n, fields) {
  store.submit({ id: ID(n), name: `観客${n}`, error_sum: 0, answered: 0, last_question: 0, ...fields });
}

describe('cleanName', () => {
  test('keeps Japanese names', () => {
    expect(cleanName('すずか太郎')).toBe('すずか太郎');
  });
  test('trims and collapses whitespace', () => {
    expect(cleanName('  a   b ')).toBe('a b');
  });
  test('drops control and invisible characters', () => {
    expect(cleanName('a\u0000b​c‮d')).toBe('abcd');
  });
  test('rejects empty or too long names', () => {
    expect(cleanName('')).toBe('');
    expect(cleanName('   ')).toBe('');
    expect(cleanName('あいうえおかきくけこ')).toBe('あいうえおかきくけこ'); // 10 chars
    expect(cleanName('あいうえおかきくけこさ')).toBe(''); // 11 chars
    expect(cleanName(42)).toBe('');
  });
});

describe('RankingStore', () => {
  test('lower total error ranks higher', () => {
    const store = new RankingStore(() => 2);
    submit(store, 1, { error_sum: 30, answered: 2, last_question: 2 });
    submit(store, 2, { error_sum: 10, answered: 2, last_question: 2 });
    const r = store.ranking(ID(1));
    expect(r.top.map((t) => t.name)).toEqual(['観客2', '観客1']);
    expect(r.me).toEqual({ rank: 2, total: 30, answered: 2 });
    expect(r.participants).toBe(2);
  });

  test('missed questions count as 50 each', () => {
    const store = new RankingStore(() => 4);
    submit(store, 1, { error_sum: 40, answered: 4, last_question: 4 }); // 40
    submit(store, 2, { error_sum: 0, answered: 1, last_question: 4 }); // 0 + 3 * 50 = 150
    const r = store.ranking(ID(2));
    expect(r.top[0]).toEqual({ rank: 1, name: '観客1', total: 40, answered: 4 });
    expect(r.me).toEqual({ rank: 2, total: 150, answered: 1 });
  });

  test('without the backstage PC, the furthest question reported is used', () => {
    const store = new RankingStore(() => -1);
    submit(store, 1, { error_sum: 0, answered: 1, last_question: 3 });
    expect(store.revealed()).toBe(3);
    expect(store.ranking(ID(1)).me).toMatchObject({ total: 100 });
  });

  test('ties share a rank and the earlier one is listed first', () => {
    let now = 0;
    const store = new RankingStore(() => 1, () => now);
    submit(store, 1, { error_sum: 5, answered: 1, last_question: 1 });
    now = 10;
    submit(store, 2, { error_sum: 5, answered: 1, last_question: 1 });
    submit(store, 3, { error_sum: 9, answered: 1, last_question: 1 });
    const r = store.ranking(null);
    expect(r.top.map((t) => [t.rank, t.name])).toEqual([[1, '観客1'], [1, '観客2'], [3, '観客3']]);
  });

  test('resubmitting updates the same viewer', () => {
    const store = new RankingStore(() => 2);
    submit(store, 1, { error_sum: 5, answered: 1, last_question: 1 });
    submit(store, 1, { error_sum: 8, answered: 2, last_question: 2 });
    expect(store.ranking(ID(1))).toMatchObject({ participants: 1, me: { total: 8, answered: 2 } });
  });

  test('hidden names are left out of the top list but still ranked', () => {
    const store = new RankingStore(() => 1);
    submit(store, 1, { error_sum: 0, answered: 1, last_question: 1 });
    submit(store, 2, { error_sum: 5, answered: 1, last_question: 1 });
    store.hidden.add(ID(1));
    const r = store.ranking(ID(1));
    expect(r.top.map((t) => t.name)).toEqual(['観客2']);
    expect(r.me).toMatchObject({ rank: 1 });
  });

  test('invalid submissions are rejected', () => {
    const store = new RankingStore();
    const ok = { id: ID(1), name: 'a', error_sum: 10, answered: 1, last_question: 1 };
    expect(() => store.submit({ ...ok, id: 'short' })).toThrow('端末ID');
    expect(() => store.submit({ ...ok, name: '' })).toThrow('ニックネーム');
    expect(() => store.submit({ ...ok, error_sum: 101 })).toThrow('成績'); // more than 100 per answer
    expect(() => store.submit({ ...ok, answered: 2, error_sum: 0, last_question: 1 })).toThrow('問題番号');
    expect(() => store.submit({ ...ok, answered: -1 })).toThrow('回答数');
    expect(() => store.submit(null)).toThrow();
    expect(store.players.size).toBe(0);
  });

  test('limit on the number of viewers', () => {
    const store = new RankingStore();
    for (let i = 0; i < 2000; i++) submit(store, i, {});
    expect(() => submit(store, 99999, {})).toThrow('多すぎる');
    expect(() => submit(store, 1, { error_sum: 0 })).not.toThrow(); // existing viewers can still update
  });
});
