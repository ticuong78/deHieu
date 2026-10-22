import type { OpsEventBus } from '../../../shared/application/ops-event-bus.js';
import {
  EMPIRE_SHARE,
  planForTrades,
  planRebalance,
  type RebalanceDecision,
  type RebalancePlan,
  type TradeUnit,
  type VenueBalances,
} from '../domain/balance-rebalance.js';
import type { TradingVenue } from '../domain/trading-account.js';
import type { TradeAttempt } from './trade-attempt.js';
import type { PushSender } from './one-click-notifier.js';

/** Một bên thiếu Cash lúc vào lệnh (đọc ngay trước khi gửi). */
export interface CashShortage {
  readonly venue: TradingVenue;
  readonly available: number;
  readonly required: number;
}

/** Đề xuất chuyển tiền đang chờ người xử lý của một profile. */
export interface RebalanceSuggestion {
  readonly profileId: string;
  readonly profileName: string;
  readonly csgoempireAccountId: string | null;
  readonly polymarketAccountId: string | null;
  /** Lệnh gần nhất bị hủy vì thiếu tiền. */
  readonly tradeId: string;
  readonly teams: readonly [string, string];
  readonly firstAt: number;
  readonly updatedAt: number;
  /** Số lệnh đã bị hủy vì thiếu tiền kể từ khi có đề xuất. */
  readonly triggers: number;
  /** Số dư (USD) hai bên lúc lệnh gần nhất bị hủy. */
  readonly balances: VenueBalances;
  readonly shortages: readonly CashShortage[];
  /** null = không nên chuyển (xem verdict). */
  readonly plan: RebalancePlan | null;
  /** Chuyển theo kế hoạch có vào thêm được lệnh không. */
  readonly helpsShortage: boolean;
  /**
   * transfer = chuyển thì vào thêm được lệnh; insufficient = tổng hai bên không đủ một lệnh tối thiểu
   * (cần nạp); none = chuyển không vào thêm được lệnh nào; ratio = không rõ tiền một lệnh, chỉ theo tỉ lệ.
   */
  readonly verdict: 'transfer' | 'insufficient' | 'none' | 'ratio';
  /** Tiền một lệnh (từ lệnh vừa hủy) — dùng cho lượt tự chuyển. */
  readonly unit: TradeUnit | null;
  /** Tổng tối thiểu cần cho một lệnh nhỏ nhất (USD); chỉ có khi verdict = insufficient. */
  readonly needUsd: number | null;
  /** Mô tả một dòng cho thông báo / sự cố. */
  readonly summary: string;
}

/** Lệnh thật bị hủy trước khi gửi vì một bên không đủ Cash. */
export function isCashShortage(t: TradeAttempt): boolean {
  const code = (t.reason ?? '').split(':')[0].trim();
  return t.mode === 'live' && code === 'INSUFFICIENT_CASH';
}

/** Cửa sổ lịch sử tiền một lệnh dùng để cân bằng. */
const HISTORY_MS = 24 * 3_600_000;
const HISTORY_MAX = 50;

const VENUES: readonly TradingVenue[] = ['csgoempire', 'polymarket'];
const NAME: Record<TradingVenue, string> = {
  csgoempire: 'csgoempire',
  polymarket: 'Polymarket',
};
const usd = (n: number) => `${n.toFixed(2)}$`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Đọc detail.cash của lệnh (do executor ghi): số dư từng bên + số tiền lệnh cần. */
function readCash(t: TradeAttempt): {
  balances: VenueBalances;
  shortages: CashShortage[];
  unit: TradeUnit | null;
} | null {
  const raw = (t.detail as { cash?: unknown }).cash;
  if (!Array.isArray(raw)) return null;
  const by = new Map<TradingVenue, { available: number; required: number }>();
  for (const c of raw as {
    venue?: unknown;
    available?: unknown;
    required?: unknown;
  }[]) {
    const venue = VENUES.find((v) => v === c?.venue);
    if (
      venue &&
      typeof c.available === 'number' &&
      Number.isFinite(c.available) &&
      typeof c.required === 'number' &&
      Number.isFinite(c.required)
    )
      by.set(venue, { available: c.available, required: c.required });
  }
  const e = by.get('csgoempire');
  const p = by.get('polymarket');
  if (!e || !p) return null;
  // tiền một lệnh = số lệnh vừa hủy cần ở mỗi bên; lệnh nhỏ nhất = Tối thiểu của hạng ÷ tiền csgoempire
  const sizing = (t.detail as { sizing?: { minStake?: unknown } }).sizing;
  const minStake =
    typeof sizing?.minStake === 'number' && sizing.minStake >= 0
      ? sizing.minStake
      : e.required;
  const unit: TradeUnit | null =
    e.required > 0 && p.required > 0
      ? {
          csgoempire: e.required,
          polymarket: p.required,
          minFraction: Math.min(1, minStake / e.required),
        }
      : null;
  return {
    unit,
    balances: { csgoempire: e.available, polymarket: p.available },
    shortages: VENUES.flatMap((venue) => {
      const c = by.get(venue)!;
      return c.available + 1e-9 < c.required ? [{ venue, ...c }] : [];
    }),
  };
}

/** Quyết định chuyển: theo LỆNH nếu biết tiền một lệnh, không thì theo tỉ lệ. */
export function decide(
  balances: VenueBalances,
  unit: TradeUnit | null,
  empireShare = EMPIRE_SHARE,
): {
  plan: RebalancePlan | null;
  verdict: RebalanceSuggestion['verdict'];
  needUsd: number | null;
  decision: RebalanceDecision | null;
} {
  const d = unit ? planForTrades(balances, unit, empireShare) : null;
  if (!d) {
    const plan = planRebalance(balances, empireShare);
    return { plan, verdict: 'ratio', needUsd: null, decision: null };
  }
  return {
    plan: d.kind === 'transfer' ? d.plan : null,
    verdict: d.kind,
    needUsd: d.kind === 'insufficient' ? d.needUsd : null,
    decision: d,
  };
}

const level = (n: number) =>
  n < 0
    ? 'không vào được lệnh nào'
    : n === 0
      ? 'chỉ lệnh nhỏ hơn mục tiêu'
      : `${n} lệnh đầy đủ`;

export function rebalanceSummary(
  balances: VenueBalances,
  shortages: readonly CashShortage[],
  plan: RebalancePlan | null,
  empireShare = EMPIRE_SHARE,
  decision: RebalanceDecision | null = null,
): string {
  const short = shortages
    .map(
      (s) =>
        `${NAME[s.venue]} có ${usd(s.available)}, lệnh cần ${usd(s.required)}`,
    )
    .join('; ');
  const ratio = `${pct(empireShare)}/${pct(1 - empireShare)}`;
  const total = balances.csgoempire + balances.polymarket;
  if (decision?.kind === 'insufficient')
    return `${short || 'Thiếu Cash'}. Tổng hai tài khoản ${usd(total)} < ${usd(decision.needUsd)} cần cho MỘT lệnh nhỏ nhất (tiền cả hai chân) — chuyển qua lại cũng không vào được lệnh: nạp thêm hoặc giảm tiền / tối thiểu của hạng. Không tự chuyển.`;
  if (decision?.kind === 'none')
    return `${short || 'Thiếu Cash'}. Chuyển qua lại không vào thêm được lệnh nào (hiện ${level(decision.levelBefore)}; tổng ${usd(total)}). Không tự chuyển — nạp thêm nếu muốn vào nhiều hơn.`;
  if (plan && decision?.kind === 'transfer')
    return `${short || 'Thiếu Cash'}. Chuyển ${usd(plan.amountUsd)} từ ${NAME[plan.from]} sang ${NAME[plan.to]}: từ ${level(decision.levelBefore)} lên ${level(decision.levelAfter)} (csgoempire ${usd(plan.current.csgoempire)} → ${usd(plan.target.csgoempire)}, Polymarket ${usd(plan.current.polymarket)} → ${usd(plan.target.polymarket)}; mục tiêu ${ratio}).`;
  if (!plan)
    return `${short || 'Thiếu Cash'}. Hai tài khoản đã đúng tỉ lệ ${ratio} (csgoempire ${usd(balances.csgoempire)} · Polymarket ${usd(balances.polymarket)}): tổng tiền không đủ cho lệnh — nạp thêm hoặc giảm tiền theo hạng.`;
  const helps = shortages.some((s) => s.venue === plan.to);
  return `${short || 'Thiếu Cash'}. Chuyển ${usd(plan.amountUsd)} từ ${NAME[plan.from]} sang ${NAME[plan.to]} để về ${ratio} (hiện ${pct(plan.currentEmpireShare)}/${pct(1 - plan.currentEmpireShare)}: csgoempire ${usd(plan.current.csgoempire)} → ${usd(plan.target.csgoempire)}, Polymarket ${usd(plan.current.polymarket)} → ${usd(plan.target.polymarket)}).${helps ? '' : ' Lưu ý: chuyển theo tỉ lệ không bù được bên đang thiếu — tổng tiền không đủ cho lệnh.'}`;
}

/**
 * Lệnh thật bị hủy vì hết tiền ở một bên → tính kế hoạch chuyển tiền giữa hai tài khoản của profile theo
 * tỉ lệ csgoempire 35% / Polymarket 65%, giữ đề xuất (mỗi profile một) và báo: sự kiện vận hành (→ Sự cố)
 * + push. KHÔNG tự chuyển tiền: người chuyển tay rồi bấm "Đã chuyển xong" (resolve).
 *
 * Báo lại khi kế hoạch đổi đáng kể (đổi chiều, lệch số tiền > max(5$, 10%)) hoặc sau `renotifyMs`;
 * lệnh hủy tiếp theo cùng tình trạng chỉ cập nhật đề xuất, không spam.
 */
export class RebalanceAdvisor {
  private readonly _open = new Map<string, RebalanceSuggestion>();
  /**
   * Tiền mỗi lệnh thật gần đây của từng profile (24 giờ, tối đa 50 lệnh), lấy từ số Cash executor đọc lúc
   * vào lệnh. Cân bằng theo lệnh ĐÒI NHIỀU NHẤT ở mỗi bên, không theo riêng lệnh vừa hủy: tiền một chân
   * Polymarket đổi rất mạnh theo giá (kèo cửa dưới chỉ vài chục cent / share), tối ưu cho đúng một lệnh rẻ
   * sẽ rút cạn bên kia rồi lệnh sau lại thiếu → chuyển qua chuyển lại.
   */
  private readonly _history = new Map<
    string,
    { readonly at: number; readonly unit: TradeUnit }[]
  >();
  /** Nghe mỗi lần lệnh hủy vì hết tiền (vd tự chuyển tiền). */
  private readonly _listeners: ((profileId: string) => void)[] = [];
  /** Lần báo gần nhất của mỗi profile: lúc nào, với kế hoạch nào (để không báo lặp). */
  private readonly _notified = new Map<
    string,
    { readonly at: number; readonly plan: RebalancePlan | null }
  >();

  constructor(
    private readonly _ops: OpsEventBus | null,
    private readonly _push: PushSender | null,
    private readonly _profileName: (id: string) => Promise<string | null>,
    private readonly _webUrl: string | null,
    private readonly _onError: (e: unknown) => void = () => undefined,
    private readonly _now: () => number = Date.now,
    private readonly _empireShare = EMPIRE_SHARE,
    private readonly _renotifyMs = 6 * 3_600_000,
  ) {}

  get empireShare(): number {
    return this._empireShare;
  }

  /** Gọi cho MỌI lệnh ghi về; chỉ xử lý lệnh thật hủy vì thiếu Cash. Không ném lỗi. */
  async trade(t: TradeAttempt): Promise<void> {
    // mọi lệnh thật có số Cash (khớp, hủy…) đều ghi lại tiền một lệnh
    if (t.mode === 'live') {
      const unit = readCash(t)?.unit;
      if (unit) this._remember(t.profileId, unit);
    }
    if (!isCashShortage(t)) return;
    try {
      const cash = readCash(t);
      if (!cash) return;
      const now = this._now();
      const { plan, verdict, needUsd, decision } = decide(
        cash.balances,
        this.unitFor(t.profileId) ?? cash.unit,
        this._empireShare,
      );
      const prev = this._open.get(t.profileId);
      const profileName =
        prev?.profileName ??
        (await this._profileName(t.profileId)) ??
        t.profileId;
      const summary = rebalanceSummary(
        cash.balances,
        cash.shortages,
        plan,
        this._empireShare,
        decision,
      );
      const last = this._notified.get(t.profileId);
      const notify =
        !prev ||
        !last ||
        now - last.at >= this._renotifyMs ||
        changed(last.plan, plan);
      const next = {
        profileId: t.profileId,
        profileName,
        csgoempireAccountId: t.csgoempireAccountId ?? null,
        polymarketAccountId: t.polymarketAccountId ?? null,
        tradeId: t.id,
        teams: t.teams,
        firstAt: prev?.firstAt ?? now,
        updatedAt: now,
        triggers: (prev?.triggers ?? 0) + 1,
        balances: cash.balances,
        shortages: cash.shortages,
        plan,
        helpsShortage:
          verdict === 'transfer' ||
          (verdict === 'ratio' &&
            !!plan &&
            cash.shortages.some((s) => s.venue === plan.to)),
        verdict,
        unit: cash.unit,
        needUsd,
        summary,
      };
      this._open.set(t.profileId, next);
      for (const l of this._listeners) l(t.profileId);
      if (!notify) return;
      this._notified.set(t.profileId, { at: now, plan });
      this._ops?.publish({
        type: 'trading.rebalance_needed',
        topic: 'alerts',
        at: now,
        data: {
          profileId: t.profileId,
          profileName,
          tradeId: t.id,
          summary,
          fromVenue: plan?.from ?? null,
          toVenue: plan?.to ?? null,
          amountUsd: plan?.amountUsd ?? 0,
        },
      });
      await this._push?.send({
        title: plan
          ? `Cân bằng tiền: chuyển ${usd(plan.amountUsd)} ${NAME[plan.from]} → ${NAME[plan.to]}`
          : verdict === 'insufficient'
            ? `Không đủ tiền cho một lệnh: profile ${profileName}`
            : `Hết tiền: profile ${profileName}`,
        body: `Profile ${profileName}: lệnh ${t.teams[0]} vs ${t.teams[1]} bị hủy vì thiếu tiền. ${summary}\nChuyển xong bấm "Đã chuyển xong" ở Auto trade → Cân bằng tiền.`,
        url: this._webUrl
          ? `${this._webUrl.replace(/\/+$/, '')}/giao-dich`
          : null,
        collapseId: `rebalance:${t.profileId}`.slice(0, 64),
        ttlSec: 24 * 3600,
      });
    } catch (e) {
      this._onError(e);
    }
  }

  /** Đăng ký nghe lệnh hủy vì hết tiền (RebalanceExecutor tự chuyển). */
  onShortage(listener: (profileId: string) => void): void {
    this._listeners.push(listener);
  }

  /** Tiền một lệnh của lệnh hủy gần nhất (cho lượt tự chuyển). */
  unitFor(profileId: string): TradeUnit | null {
    const list = this._fresh(profileId);
    if (!list.length) return null;
    // mỗi bên theo lệnh đòi nhiều nhất; lệnh nhỏ nhất theo lệnh gần nhất (cấu hình hạng hiện tại)
    return {
      csgoempire: Math.max(...list.map((x) => x.unit.csgoempire)),
      polymarket: Math.max(...list.map((x) => x.unit.polymarket)),
      minFraction: list.at(-1)!.unit.minFraction,
    };
  }

  private _fresh(profileId: string) {
    const since = this._now() - HISTORY_MS;
    const list = (this._history.get(profileId) ?? []).filter(
      (x) => x.at >= since,
    );
    this._history.set(profileId, list);
    return list;
  }

  private _remember(profileId: string, unit: TradeUnit) {
    const list = this._fresh(profileId);
    list.push({ at: this._now(), unit });
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  }

  /** Đề xuất đang chờ, mới nhất trước. */
  list(): RebalanceSuggestion[] {
    return [...this._open.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Người đã chuyển tiền xong (hoặc bỏ qua) → xóa đề xuất, đóng sự cố. null = không có đề xuất. */
  resolve(profileId: string, by: string): RebalanceSuggestion | null {
    const cur = this._open.get(profileId);
    if (!cur) return null;
    this._open.delete(profileId);
    this._notified.delete(profileId);
    try {
      this._ops?.publish({
        type: 'trading.rebalanced',
        topic: 'alerts',
        at: this._now(),
        data: { profileId, by },
      });
    } catch (e) {
      this._onError(e);
    }
    return cur;
  }
}

/** Kế hoạch đổi đủ để báo lại: đổi chiều / có ↔ không, hoặc số tiền lệch > max(5$, 10%). */
function changed(a: RebalancePlan | null, b: RebalancePlan | null): boolean {
  if (!a || !b) return a !== b;
  if (a.from !== b.from) return true;
  const d = Math.abs(a.amountUsd - b.amountUsd);
  return d > Math.max(5, 0.1 * a.amountUsd);
}
