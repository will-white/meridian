import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatCents, isInvestmentAccountType } from "@meridian/shared";
import type { AccountView, CreateInvestmentTxnBody, CreateInvestmentTxnResponse, InvestmentTxnType, SecurityView, TransferDirection } from "@meridian/shared";
import { api } from "../../lib/api.js";
import { defaultTradeAmountCents, emptyTradeForm, parseTradeForm, securityLabel, TRADE_TYPES, type TradeFormState } from "../../lib/investmentForms.js";
import { ErrorText } from "../ui.js";
import { invalidateInvestments } from "./queries.js";

/**
 * Record a trade by hand (imports design §3.10, §5): a type-switched form
 * matching `CreateInvestmentTxnBody`. Buy, sell and reinvest take quantity,
 * price and fee with the amount prefilled from the rounding rule and
 * editable; dividend, interest and fee take an amount; a split its ratio;
 * a transfer its direction, a security or cash, the other account (which
 * inserts the mirror leg) or, for shares arriving from outside, the carried
 * basis and acquired date. Lot picks for a sale are set afterwards from the
 * row's lot picker. Owner only.
 */
export function TradeForm({
  accountId,
  accounts,
  securities,
  today,
  initialType = "buy",
  counterpartyAccountId = "",
  onClose,
  onSaved,
}: {
  accountId: string;
  accounts: readonly AccountView[];
  securities: readonly SecurityView[];
  today: string;
  initialType?: InvestmentTxnType;
  counterpartyAccountId?: string;
  onClose: () => void;
  onSaved: (result: CreateInvestmentTxnResponse) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<TradeFormState>(() => ({ ...emptyTradeForm(today, initialType), counterpartyAccountId, direction: counterpartyAccountId ? "out" : "in" }));
  const [clientError, setClientError] = useState<string | null>(null);
  const others = accounts.filter((a) => a.id !== accountId && isInvestmentAccountType(a.type) && !a.closed);
  const tradable = securities.filter((s) => !s.archived && s.type !== "cash");

  const save = useMutation({
    mutationFn: (body: CreateInvestmentTxnBody) => api<CreateInvestmentTxnResponse>("/investments/txns", { method: "POST", body }),
    onSuccess: (r) => {
      invalidateInvestments(qc);
      void qc.invalidateQueries({ queryKey: ["investment-transactions"] });
      void qc.invalidateQueries({ queryKey: ["transactions"] });
      void qc.invalidateQueries({ queryKey: ["lots"] });
      onSaved(r);
    },
  });

  const edit = (patch: Partial<TradeFormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setClientError(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = parseTradeForm(form, accountId, today);
    if (!r.ok) return setClientError(r.error);
    save.mutate(r.body);
  };

  const isTrade = form.type === "buy" || form.type === "sell" || form.type === "reinvest";
  const isIncome = form.type === "dividend" || form.type === "interest" || form.type === "fee";
  const defaultAmount = isTrade ? defaultTradeAmountCents(form.type, form.quantity, form.price, form.fee) : null;
  const amountPlaceholder = defaultAmount === null ? (form.type === "sell" ? "cash received" : isTrade ? "cash paid (negative)" : "") : formatCents(defaultAmount);
  const outsideIn = form.type === "transfer" && form.direction === "in" && form.counterpartyAccountId === "" && form.securityId !== "";

  const securitySelect = (allowNone: boolean, noneLabel: string) => (
    <select value={form.securityId} onChange={(e) => edit({ securityId: e.target.value })} aria-label="Security">
      {allowNone && <option value="">{noneLabel}</option>}
      {!allowNone && <option value="">— security —</option>}
      {tradable.map((s) => (
        <option key={s.id} value={s.id}>
          {securityLabel(s)}
        </option>
      ))}
    </select>
  );

  return (
    <form className="inv-trade-form" onSubmit={submit} aria-label="Record a trade">
      <div className="row wrap">
        <label>
          Type
          <select value={form.type} onChange={(e) => edit({ type: e.target.value as InvestmentTxnType, amount: "" })}>
            {TRADE_TYPES.map(([t, label]) => (
              <option key={t} value={t}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={form.date} max={today} onChange={(e) => edit({ date: e.target.value })} required />
        </label>
        {form.type === "transfer" && (
          <label>
            Direction
            <select value={form.direction} onChange={(e) => edit({ direction: e.target.value as TransferDirection })} aria-label="Direction">
              <option value="in">into this account</option>
              <option value="out">out of this account</option>
            </select>
          </label>
        )}
        <label>
          Security
          {form.type === "transfer" ? securitySelect(true, "— cash —") : isIncome ? securitySelect(true, form.type === "dividend" ? "— pick the security —" : "— account level —") : securitySelect(false, "")}
        </label>
      </div>

      {isTrade && (
        <div className="row wrap">
          <label>
            Quantity
            <input inputMode="decimal" value={form.quantity} onChange={(e) => edit({ quantity: e.target.value })} placeholder="shares" required />
          </label>
          <label>
            Price
            <input inputMode="decimal" value={form.price} onChange={(e) => edit({ price: e.target.value })} placeholder="per share" required />
          </label>
          <label>
            Fee
            <input inputMode="decimal" value={form.fee} onChange={(e) => edit({ fee: e.target.value })} placeholder="0.00" />
          </label>
          <label>
            Amount <span className="muted">(cash effect)</span>
            <input inputMode="decimal" value={form.amount} onChange={(e) => edit({ amount: e.target.value })} placeholder={amountPlaceholder} />
          </label>
        </div>
      )}
      {isTrade && <p className="muted small">{form.type === "sell" ? "Amount = quantity × price − fee" : form.type === "reinvest" ? "Amount = −(quantity × price); a reinvestment is a purchase, never income (record the dividend separately)" : "Amount = −(quantity × price + fee)"}, rounded half away from zero; leave it blank to accept.</p>}

      {isIncome && (
        <div className="row wrap">
          <label>
            Amount
            <input inputMode="decimal" value={form.amount} onChange={(e) => edit({ amount: e.target.value })} placeholder={form.type === "fee" ? "charged" : "received"} required />
          </label>
          <span className="muted small">{form.type === "fee" ? "Fees are recorded as a negative cash effect." : "Income is positive; a reinvested dividend is a dividend plus a reinvest row."}</span>
        </div>
      )}

      {form.type === "split" && (
        <div className="row wrap">
          <label>
            New shares
            <input inputMode="numeric" value={form.splitNum} onChange={(e) => edit({ splitNum: e.target.value })} placeholder="2" required className="inv-ratio-input" />
          </label>
          <span className="muted">for</span>
          <label>
            Old shares
            <input inputMode="numeric" value={form.splitDen} onChange={(e) => edit({ splitDen: e.target.value })} placeholder="1" required className="inv-ratio-input" />
          </label>
          <span className="muted small">2 : 1 doubles the shares; 1 : 10 is a reverse split.</span>
        </div>
      )}

      {form.type === "transfer" && (
        <>
          <div className="row wrap">
            {form.securityId === "" ? (
              <label>
                Cash amount
                <input inputMode="decimal" value={form.amount} onChange={(e) => edit({ amount: e.target.value })} placeholder="dollars" required />
              </label>
            ) : (
              <label>
                Quantity
                <input inputMode="decimal" value={form.quantity} onChange={(e) => edit({ quantity: e.target.value })} placeholder="shares" required />
              </label>
            )}
            <label>
              {form.direction === "in" ? "From account" : "To account"}
              <select value={form.counterpartyAccountId} onChange={(e) => edit({ counterpartyAccountId: e.target.value })} aria-label="Other account">
                <option value="">— outside Meridian's investment accounts —</option>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {outsideIn && (
            <div className="row wrap">
              <label>
                Cost basis <span className="muted">(carried; blank = unknown)</span>
                <input inputMode="decimal" value={form.costBasis} onChange={(e) => edit({ costBasis: e.target.value })} placeholder="dollars" />
              </label>
              <label>
                Acquired on <span className="muted">(for the holding period)</span>
                <input type="date" value={form.acquiredDate} max={form.date} onChange={(e) => edit({ acquiredDate: e.target.value })} />
              </label>
            </div>
          )}
          <p className="muted small">
            {form.counterpartyAccountId
              ? "The other account gets the mirror leg in the same group; shares keep their lots and basis."
              : form.securityId === ""
                ? "A cash transfer in is a contribution: for an account without a bank feed it also creates the ledger row that counts toward savings goals."
                : "Shares arriving from outside open lots with the basis and date you give; unknown basis is shown as such and never counted in gains."}
          </p>
        </>
      )}

      <label>
        Memo <span className="muted">(optional)</span>
        <input value={form.memo} onChange={(e) => edit({ memo: e.target.value })} maxLength={2000} />
      </label>
      <div className="row wrap">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Record"}
        </button>
        <button type="button" className="secondary" onClick={onClose} disabled={save.isPending}>
          Cancel
        </button>
      </div>
      {clientError && <ErrorText error={new Error(clientError)} />}
      <ErrorText error={save.error} />
    </form>
  );
}
