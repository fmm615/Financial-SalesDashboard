# B2C Cross-Tab Duplicate Rule Adjustment

**Date:** 12 August 2026  
**Status:** Approved for planning  
**Scope:** Adjust exact-duplicate candidate grouping for the completed Finance
Payment Tracker `B2C` and `B2C Cons` tabs

## Evidence

The completed Finance import produced the following read-only diagnostic result:

- 63 cross-tab row pairs share normalized customer name, date, USD amount, and
  payment method.
- No such pair shares a direct e-mail address.
- No such pair has equal category text.

This reflects the two source tabs' different structures. `B2C` supplies a
`Type` value while `B2C Cons` uses separate `Category` and `Membership Type`
values. Those category fields are not equivalent and cannot safely be used as
an exact cross-tab equality test. Direct e-mail is also unavailable for these
historical pairs.

## Approved grouping rule

Create a review-only duplicate candidate only when all of the following are
true within one completed Payment Tracker import:

1. one source row is from `B2C` and one source row is from `B2C Cons`;
2. both rows have `valid` quality;
3. normalized customer names are equal and non-empty;
4. business dates are equal;
5. USD amounts are equal; and
6. normalized payment methods are equal.

The comparison key must occur exactly once in each tab. If the same name,
date, amount, and method occurs more than once in either tab, the rows are
ambiguous and no group is created. A later recurring payment differs by date,
so it is never grouped through this rule.

## Safety boundary

A group remains an `exact_duplicate_candidate`, not confirmed revenue. Both
Finance source rows remain immutable. An Admin must choose one canonical row
or exclude the group, supplying a reason; the existing one-time audited
database decision remains the only write path.

The adjusted grouping rule does not use Stripe/Tap evidence, create a B2C
payment, calculate a total, alter a target/report, or approve a Finance period.
Provider evidence can remain visible as separate Admin investigation context
only.

## Verification

- Regression tests prove a matching name/date/amount/method pair groups even
  without e-mail, phone, or matching category text.
- Tests reject category-independent near matches with a changed name, date,
  amount, or payment method.
- Tests reject multiple rows with the same comparison key in either tab.
- Database tests retain Admin-only access and verify no `b2c_payments` write.
- Full TypeScript, lint, test, build, and diff checks run before handoff.
